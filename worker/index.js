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
//
// Columnar responses reuse rankings.json's {columns, rows} shape so clients
// can share one column-index decoder for slim and full payloads.

const DATA_TTL_MS = 5 * 60 * 1000;
const QUOTE_TTL_S = 60;
const MAX_N = 1500;

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET") return json({ error: "GET only" }, 405);

    try {
      const quote = path.match(/^\/api\/quote\/([^/]+)$/);
      if (quote) return await apiQuote(quote[1]);

      const d = await loadData(env, request);
      if (path === "/api/summary") return json({ ...meta(d), sectors: d.sectors });
      if (path === "/api/top") return apiTop(d, url.searchParams);
      if (path === "/api/search") return apiSearch(d, url.searchParams);
      const ticker = path.match(/^\/api\/ticker\/([^/]+)$/);
      if (ticker) return apiTicker(d, ticker[1]);

      return json(
        {
          error: "unknown endpoint",
          endpoints: [
            "/api/summary",
            "/api/top?n=&index=&sector=",
            "/api/ticker/:symbol",
            "/api/search?q=&n=",
            "/api/quote/:symbol",
          ],
        },
        404
      );
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};
