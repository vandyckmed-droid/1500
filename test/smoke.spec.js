/* Headless smoke test of the app itself: it must boot, render the rankings
   from the repo's real data file, open a stock sheet with computed momentum
   quality, and produce watchlist portfolio stats — with every network
   dependency stubbed, so the test is deterministic and never touches
   production or third parties.

   Run: node test/smoke.spec.js   (expects a static server for docs/ on
   SMOKE_PORT, default 8080; set CHROMIUM_PATH to use a specific browser.) */
"use strict";
const { chromium } = require("playwright");

const PORT = process.env.SMOKE_PORT || "8080";
const BASE = "http://localhost:" + PORT;
const API = "https://1500.vandyck-med.workers.dev"; // the app targets prod from localhost; we intercept

// Deterministic synthetic price archive: one shared trading calendar, a
// seeded random walk per symbol, so correlations and basket math are real
// numbers but identical on every run.
const DATES = (() => {
  const out = [];
  const d = new Date(Date.UTC(2026, 7, 20)); // matches the era of the checked-in data
  while (out.length < 280) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
})();
function seeded(sym) {
  let h = 2166136261;
  for (const c of sym) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) / 4294967296);
  };
}
function priceSeries(sym) {
  const rnd = seeded(sym);
  let p = 50 + rnd() * 200;
  const close = [];
  for (let i = 0; i < DATES.length; i++) {
    p *= 1 + (rnd() - 0.49) * 0.03;
    close.push(+p.toFixed(4));
  }
  return { symbol: sym, dates: DATES, close };
}

const API_STUBS = [
  [/\/api\/deltas$/, { deltas: {} }],
  [/\/api\/indices$/, { indices: [] }],
  [/\/api\/movers/, { up: [], down: [] }],
  [/\/api\/today/, { quotes: {} }],
  [/\/api\/spark\//, (() => {
    // a valid intraday series so the 1D chart path renders deterministically
    const closes = [], times = [];
    for (let i = 0; i < 30; i++) { closes.push(100 + Math.sin(i / 4) * 2); times.push(1755690000 + i * 300); }
    return { closes, times, prev_close: 99.5, price: closes[29], gmtoffset: -14400 };
  })()],
  [/\/api\/history\//, { points: [] }],
];

const failures = [];
function check(name, ok, detail) {
  console.log((ok ? "  ok  " : "  FAIL") + " " + name + (detail ? " — " + detail : ""));
  if (!ok) failures.push(name + (detail ? " (" + detail + ")" : ""));
}

(async () => {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  );
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e.message)));

  await page.route(API + "/**", route => {
    const path = new URL(route.request().url()).pathname;
    const hit = API_STUBS.find(([re]) => re.test(path));
    route.fulfill({
      status: hit ? 200 : 404,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(hit ? hit[1] : { error: "unstubbed: " + path }),
    });
  });
  await page.route("https://raw.githubusercontent.com/**", route => {
    const m = route.request().url().match(/\/data\/([A-Z0-9_.-]+)\.json$/i);
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(priceSeries(m ? m[1].replace("_", ".") : "X")),
    });
  });
  // fonts are irrelevant to the smoke and slow in CI
  await page.route("https://fonts.googleapis.com/**", r => r.fulfill({ status: 200, contentType: "text/css", body: "" }));
  await page.route("https://fonts.gstatic.com/**", r => r.abort());

  await page.addInitScript(() => {
    localStorage.setItem("watch", JSON.stringify(["SNDK", "MU", "GEO", "VSTS", "MXL"]));
    localStorage.setItem("wscheme", "equal");
  });

  // 1. Boot + rankings from the repo's real data file
  await page.goto(BASE + "/#/rankings", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#list .row", { timeout: 20000 }).catch(() => {});
  const rowCount = await page.locator("#list .row").count();
  check("rankings render", rowCount >= 60, rowCount + " rows painted");
  const asof = await page.locator("#asof").textContent();
  check("as-of date shown", /^\d{4}-\d{2}-\d{2}$/.test((asof || "").trim()), asof);

  // 2. Stock sheet: chart + computed momentum quality
  await page.locator("#list .row").first().click();
  const mq = await page.waitForSelector("#mq .strip", { timeout: 20000 }).catch(() => null);
  check("momentum quality computes", !!mq);
  const chart = await page.waitForSelector("#chartbox svg.chartsvg", { timeout: 15000 }).catch(() => null);
  check("price chart draws", !!chart);

  // 3. Watchlist portfolio stats (basket vol headline from synthetic prices)
  await page.evaluate(() => { location.hash = "#/rankings"; });
  await page.waitForTimeout(300);
  await page.click('#tabs button[data-view="watch"]');
  const gotBasket = await page.waitForFunction(() => {
    const el = document.querySelector("#wstats .phead .pv");
    return el && /%/.test(el.textContent);
  }, { timeout: 30000 }).catch(() => null);
  check("basket volatility headline", !!gotBasket,
    await page.evaluate(() => (document.querySelector("#wstats .phead .pv") || {}).textContent || "missing"));

  // 4. Beta mode fills from the returns matrix — one fetch, one in-memory pass
  await page.click('#tabs button[data-view="all"]');
  await page.click('#seg button[data-mode="beta"]');
  const betaFilled = await page.waitForFunction(() => {
    const chips = [...document.querySelectorAll("#list .row .bchips .chip")];
    return chips.filter(c => /^[0-9−+.-]/.test(c.textContent.trim())).length >= 20;
  }, { timeout: 15000 }).catch(() => null);
  check("beta column fills from matrix", !!betaFilled);

  // 5. Honest failure: the stubs return empty live data, so the dashboard
  // must say so instead of showing silent dashes
  await page.evaluate(() => { location.hash = "#/"; });
  const advisory = await page.waitForSelector("#livestatus:not([hidden])", { timeout: 15000 }).catch(() => null);
  check("live-data advisory shows when quotes are down", !!advisory);

  // 6. No uncaught errors anywhere along the way
  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

  await browser.close();
  if (failures.length) {
    console.error("\nSMOKE FAILED: " + failures.join("; "));
    process.exit(1);
  }
  console.log("\nsmoke passed");
})().catch(e => { console.error("SMOKE CRASHED:", e); process.exit(1); });
