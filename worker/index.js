// Slim API in front of the static rankings site.
//
// Static files in ./docs are served by Cloudflare's asset handling before
// this Worker runs; only non-asset paths (i.e. /api/*) reach it.
//
//   GET /api/summary            → metadata: as_of, counts, sectors
//   GET /api/top?n=&index=&sector=  → top-N rows (rank order), columnar
//   GET /api/ticker/:symbol     → one row + rank context
//   GET /api/search?q=&n=       → symbol/name/sector match, columnar
//   GET /api/quote/:symbol      → intraday quote proxied from Yahoo Finance
//   GET /api/analyze/:symbol    → AI explanation of what the company does
//                                 (Workers AI, cached per symbol per as_of day)
//   POST /api/review            → {symbols: [...]} AI watchlist review
//   POST /api/ask               → {question, symbol?} AI Q&A about the rankings
//
// Columnar responses reuse rankings.json's {columns, rows} shape so clients
// can share one column-index decoder for slim and full payloads.

const DATA_TTL_MS = 5 * 60 * 1000;
const QUOTE_TTL_S = 60;
const MAX_N = 1500;

const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const METHODOLOGY =
  "You are the built-in analyst of an S&P 1500 momentum-rankings app. " +
  "Methodology: return_12_1 is the price change from 12 months ago to 1 month ago " +
  "(the latest month is skipped on purpose, standard momentum practice); return_6_1 " +
  "is the same over 6 months. Volatility is annualized from daily swings. " +
  "score_12 = return_12_1 / volatility_12m and score_6 = return_6_1 / volatility_6m " +
  "(volatility-adjusted return, VAR = reward per unit of risk). Every stock is ranked " +
  "by final_score, the average of score_12 and score_6; rank 1 is best of ~1500. " +
  "All returns and volatilities in the data are decimal fractions: 0.42 means 42%, " +
  "3.39 means 339% — convert carefully when quoting percentages. " +
  "Data is end-of-day, refreshed nightly. Write plainly for a retail user, ground every " +
  "claim in the numbers given, and never give buy/sell advice — describe, don't recommend.";

let cached = { data: null, at: 0 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "public, max-age=300" : "no-store",
      ...CORS,
      ...extra,
    },
  });

async function loadData(env, request) {
  const now = Date.now();
  if (cached.data && now - cached.at < DATA_TTL_MS) return cached.data;
  const res = await env.ASSETS.fetch(new URL("/data/rankings.json", request.url));
  if (!res.ok) throw new Error("rankings.json unavailable");
  const data = await res.json();
  data._col = Object.fromEntries(data.columns.map((c, i) => [c, i]));
  cached = { data, at: now };
  return data;
}

const meta = (d) => ({
  as_of: d.as_of,
  generated_at: d.generated_at,
  total: d.rows.length,
  constituent_counts: d.constituent_counts,
  ranked_counts: d.ranked_counts,
});

function clampN(params, dflt) {
  const n = parseInt(params.get("n"), 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_N) : dflt;
}

function apiTop(d, params) {
  const idx = params.get("index");
  const sector = params.get("sector");
  let rows = d.rows; // already sorted by rank_1500
  if (idx) rows = rows.filter((r) => r[d._col.index] === idx);
  if (sector) rows = rows.filter((r) => r[d._col.sector] === sector);
  rows = rows.slice(0, clampN(params, 25));
  return json({ ...meta(d), sectors: d.sectors, columns: d.columns, rows });
}

function apiTicker(d, symbol) {
  const sym = decodeURIComponent(symbol).toUpperCase();
  const row = d.rows.find((r) => r[d._col.symbol] === sym);
  if (!row) return json({ error: "unknown symbol", symbol: sym }, 404);
  const secName = row[d._col.sector];
  const sec = (d.sectors || []).find((s) => s.sector === secName);
  return json({
    ...meta(d),
    index_count: d.ranked_counts[row[d._col.index]],
    sector_count: sec ? sec.count : null,
    columns: d.columns,
    rows: [row],
  });
}

function apiSearch(d, params) {
  const q = (params.get("q") || "").trim().toLowerCase();
  if (!q) return json({ error: "missing q parameter" }, 400);
  const { symbol, name, sector } = d._col;
  const rows = [];
  const max = clampN(params, 25);
  for (const r of d.rows) {
    if (
      String(r[symbol]).toLowerCase().includes(q) ||
      String(r[name]).toLowerCase().includes(q) ||
      String(r[sector] || "").toLowerCase().includes(q)
    ) {
      rows.push(r);
      if (rows.length >= max) break;
    }
  }
  return json({ as_of: d.as_of, total: d.rows.length, columns: d.columns, rows });
}

async function apiQuote(symbol) {
  const sym = decodeURIComponent(symbol).toUpperCase();
  const ysym = sym.replace(/\./g, "-"); // BRK.B → BRK-B
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ysym) +
    "?range=1d&interval=5m&includePrePost=false";
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; sp1500-momentum)" },
    cf: { cacheTtl: QUOTE_TTL_S, cacheEverything: true },
  });
  if (!res.ok) return json({ error: "quote unavailable", symbol: sym }, 502);
  const body = await res.json();
  const m = body?.chart?.result?.[0]?.meta;
  const price = m?.regularMarketPrice;
  const prev = m?.chartPreviousClose ?? m?.previousClose;
  if (price == null || prev == null)
    return json({ error: "quote unavailable", symbol: sym }, 502);
  return json(
    {
      symbol: sym,
      price,
      prev_close: prev,
      change: +(price - prev).toFixed(4),
      change_pct: +((price / prev - 1) * 100).toFixed(3),
      market_time: m.regularMarketTime ?? null,
      currency: m.currency ?? "USD",
      source: "yahoo",
    },
    200,
    { "Cache-Control": "public, max-age=" + QUOTE_TTL_S }
  );
}

const rowObj = (d, row) => Object.fromEntries(d.columns.map((c, i) => [c, row[i]]));

async function aiRun(env, messages, maxTokens) {
  if (!env.AI) throw new Error("AI binding not configured");
  const out = await env.AI.run(AI_MODEL, { messages, max_tokens: maxTokens });
  const text = (out && (out.response || "")).trim();
  if (!text) throw new Error("empty AI response");
  return text;
}

async function apiAnalyze(env, d, symbol, requestUrl) {
  const sym = decodeURIComponent(symbol).toUpperCase();
  const row = d.rows.find((r) => r[d._col.symbol] === sym);
  if (!row) return json({ error: "unknown symbol", symbol: sym }, 404);

  // The description is stable; cache one per symbol per as_of day (v2: company
  // explainer replaced the ranking explainer — the bump skips stale v1 entries).
  const cacheKey = new Request(
    new URL("/api/analyze/" + encodeURIComponent(sym) + "?v=2&as_of=" + d.as_of, requestUrl)
  );
  const hit = await caches.default.match(cacheKey);
  if (hit) return hit;

  const s = rowObj(d, row);
  const analysis = await aiRun(env, [
    {
      role: "system",
      content:
        "You are the built-in explainer of a stock-rankings app. Describe companies " +
        "plainly for a retail user with no jargon. Never give buy/sell advice.",
    },
    {
      role: "user",
      content:
        "In 90-140 words of flowing prose (no headings or bullets), explain what " +
        "this company actually does: what it makes or sells, who its customers are, " +
        "and how it makes money. If you are not fully certain about this specific " +
        "company, stick to what its name, sector, and size imply and keep it " +
        "general rather than inventing specifics.\n" +
        "Company: " + s.name + " (ticker " + s.symbol + ")\n" +
        "Sector: " + s.sector + " | Index: " + s.index +
        (s.market_cap ? " | Market cap: $" + Math.round(s.market_cap / 1e6) + "M" : ""),
    },
  ], 350);

  const res = json({ symbol: sym, as_of: d.as_of, analysis }, 200, {
    "Cache-Control": "public, max-age=86400",
  });
  await caches.default.put(cacheKey, res.clone());
  return res;
}

async function apiReview(env, d, body) {
  const syms = Array.isArray(body && body.symbols)
    ? [...new Set(body.symbols.map((s) => String(s).toUpperCase()))].slice(0, 30)
    : [];
  if (!syms.length) return json({ error: "symbols array required" }, 400);
  const rows = d.rows.filter((r) => syms.includes(r[d._col.symbol])).map((r) => {
    const s = rowObj(d, r);
    return {
      symbol: s.symbol, name: s.name, sector: s.sector, index: s.index,
      rank_1500: s.rank_1500, final_score: s.final_score,
      return_12_1: s.return_12_1, return_6_1: s.return_6_1,
      volatility_12m: s.volatility_12m, market_cap: s.market_cap,
    };
  });
  if (!rows.length) return json({ error: "no known symbols", symbols: syms }, 404);
  const analysis = await aiRun(env, [
    { role: "system", content: METHODOLOGY },
    {
      role: "user",
      content:
        "Review this watchlist in 130-180 words as short flowing prose (no headings " +
        "or bullets). Cover: how it tilts by sector and size, which names are the " +
        "momentum leaders and laggards within it, and anything notable about its " +
        "overall risk (volatility) profile. Data as of " + d.as_of +
        " (rank is out of " + d.rows.length + "):\n" + JSON.stringify(rows),
    },
  ], 450);
  return json({ as_of: d.as_of, count: rows.length, analysis }, 200, {
    "Cache-Control": "no-store",
  });
}

async function apiAsk(env, d, body) {
  const question = String((body && body.question) || "").trim().slice(0, 500);
  if (!question) return json({ error: "question required" }, 400);
  let stockCtx = "";
  if (body && body.symbol) {
    const row = d.rows.find((r) => r[d._col.symbol] === String(body.symbol).toUpperCase());
    if (row) stockCtx = "\nStock in view: " + JSON.stringify(rowObj(d, row));
  }
  const top = d.rows.slice(0, 20).map((r) => {
    const s = rowObj(d, r);
    return { symbol: s.symbol, name: s.name, sector: s.sector, rank: s.rank_1500, final_score: s.final_score };
  });
  const analysis = await aiRun(env, [
    { role: "system", content: METHODOLOGY },
    {
      role: "user",
      content:
        "Answer the user's question in at most 120 words of plain prose. If the " +
        "question cannot be answered from the app's data or methodology, say so " +
        "briefly. Data as of " + d.as_of + ". Sector overview: " +
        JSON.stringify(d.sectors || []) + "\nCurrent top 20: " + JSON.stringify(top) +
        stockCtx + "\n\nQuestion: " + question,
    },
  ], 350);
  return json({ as_of: d.as_of, answer: analysis }, 200, { "Cache-Control": "no-store" });
}

async function apiSpark(symbol) {
  const sym = decodeURIComponent(symbol).toUpperCase();
  const ysym = sym.replace(/\./g, "-");
  // Same URL and cache settings as apiQuote, so both share one upstream fetch.
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(ysym) +
    "?range=1d&interval=5m&includePrePost=false";
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; sp1500-momentum)" },
    cf: { cacheTtl: QUOTE_TTL_S, cacheEverything: true },
  });
  if (!res.ok) return json({ error: "spark unavailable", symbol: sym }, 502);
  const body = await res.json();
  const r0 = body?.chart?.result?.[0];
  const m = r0?.meta;
  const ts = r0?.timestamp || [];
  const cl = r0?.indicators?.quote?.[0]?.close || [];
  const times = [], closes = [];
  for (let i = 0; i < ts.length; i++)
    if (cl[i] != null) { times.push(ts[i]); closes.push(+cl[i].toFixed(4)); }
  const prev = m?.chartPreviousClose ?? m?.previousClose;
  if (closes.length < 2 || prev == null)
    return json({ error: "spark unavailable", symbol: sym }, 502);
  return json(
    {
      symbol: sym,
      prev_close: prev,
      price: m.regularMarketPrice ?? closes[closes.length - 1],
      gmtoffset: m.gmtoffset ?? -14400,
      times,
      closes,
    },
    200,
    { "Cache-Control": "public, max-age=120" }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const isPost = path === "/api/review" || path === "/api/ask";
    if (request.method !== (isPost ? "POST" : "GET"))
      return json({ error: isPost ? "POST only" : "GET only" }, 405);

    try {
      const quote = path.match(/^\/api\/quote\/([^/]+)$/);
      if (quote) return await apiQuote(quote[1]);
      const spark = path.match(/^\/api\/spark\/([^/]+)$/);
      if (spark) return await apiSpark(spark[1]);

      const d = await loadData(env, request);
      if (path === "/api/summary") return json({ ...meta(d), sectors: d.sectors });
      if (path === "/api/top") return apiTop(d, url.searchParams);
      if (path === "/api/search") return apiSearch(d, url.searchParams);
      const ticker = path.match(/^\/api\/ticker\/([^/]+)$/);
      if (ticker) return apiTicker(d, ticker[1]);
      const analyze = path.match(/^\/api\/analyze\/([^/]+)$/);
      if (analyze) return await apiAnalyze(env, d, analyze[1], url);
      if (path === "/api/review") return await apiReview(env, d, await request.json().catch(() => null));
      if (path === "/api/ask") return await apiAsk(env, d, await request.json().catch(() => null));

      return json(
        {
          error: "unknown endpoint",
          endpoints: [
            "/api/summary",
            "/api/top?n=&index=&sector=",
            "/api/ticker/:symbol",
            "/api/search?q=&n=",
            "/api/quote/:symbol",
            "/api/spark/:symbol",
            "/api/analyze/:symbol",
            "POST /api/review {symbols}",
            "POST /api/ask {question, symbol?}",
          ],
        },
        404
      );
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};
