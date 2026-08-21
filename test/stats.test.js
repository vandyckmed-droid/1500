/* Unit tests for docs/stats.js, plus the reconciliation test that pins the
   client's volatility formula to the pipeline's volatility_63d using real
   captured data (test/fixtures/reconcile.json).
   Run: node --test test/stats.test.js */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Stats = require(path.join(__dirname, "..", "docs", "stats.js"));

// deterministic pseudo-random walk
function walk(seed, n, drift) {
  let h = seed >>> 0;
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  const out = [100];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + (rnd() - 0.5 + (drift || 0)) * 0.02));
  return out;
}
function dates(n) {
  const out = [];
  const d = new Date(Date.UTC(2026, 0, 1));
  while (out.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function mapOf(closes) { return Stats.logReturnMap(dates(closes.length), closes, 140); }

test("logReturnMap: values, window cap, and thin-series null", () => {
  const c = [100, 110, 99];
  const m = Stats.logReturnMap(dates(3), c, 140);
  assert.equal(m, null); // fewer than MIN_OVERLAP observations
  const c2 = walk(7, 200);
  const m2 = Stats.logReturnMap(dates(200), c2, 140);
  assert.equal(Object.keys(m2).length, 140); // capped
  const ds = dates(200);
  assert.ok(Math.abs(m2[ds[199]] - Math.log(c2[199] / c2[198])) < 1e-12);
});

test("corr: identical series → 1, mirrored → −1, insufficient overlap → null", () => {
  const a = mapOf(walk(1, 120));
  assert.ok(Math.abs(Stats.corr(a, a) - 1) < 1e-12);
  const mirrored = {};
  for (const k of Object.keys(a)) mirrored[k] = -a[k];
  assert.ok(Math.abs(Stats.corr(a, mirrored) + 1) < 1e-12);
  const b = mapOf(walk(2, 120));
  const short = {};
  Object.keys(b).slice(0, 10).forEach(k => short[k] = b[k]);
  assert.equal(Stats.corr(a, short), null);
});

test("annVol: constant returns → 0, matches hand computation", () => {
  assert.ok(Stats.annVol([0.01, 0.01, 0.01, 0.01]) < 1e-12);
  const vals = [0.01, -0.02, 0.005];
  const mean = (0.01 - 0.02 + 0.005) / 3;
  const varr = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / 2;
  assert.ok(Math.abs(Stats.annVol(vals) - Math.sqrt(varr * 252)) < 1e-12);
});

test("basket: equal weights of two series average their returns; weights renormalize", () => {
  const m1 = mapOf(walk(3, 120)), m2 = mapOf(walk(4, 120));
  const b = Stats.basket([m1, m2], [2, 2]); // un-normalized weights
  const ds = Stats.alignDates([m1, m2]);
  assert.ok(Math.abs(b.ret[ds[50]] - (m1[ds[50]] + m2[ds[50]]) / 2) < 1e-12);
  assert.ok(b.sigma > 0);
  const solo = Stats.basket([m1], [1]);
  assert.ok(Math.abs(solo.sigma - Stats.annVol(ds.map(d => m1[d]).filter(v => v !== undefined))) < 1e-6);
});

test("beta: self → β=1 ρ=1; doubled returns → β=2; diversification lowers basket vol", () => {
  const m1 = mapOf(walk(5, 120));
  const b = Stats.basket([m1], [1]);
  const self = Stats.beta(m1, b.ret, b.sigma);
  assert.ok(Math.abs(self.beta - 1) < 1e-9 && Math.abs(self.rho - 1) < 1e-9);
  const twice = {};
  for (const k of Object.keys(m1)) twice[k] = 2 * m1[k];
  const dbl = Stats.beta(twice, b.ret, b.sigma);
  assert.ok(Math.abs(dbl.beta - 2) < 1e-9);
  // two roughly independent series: basket vol below average member vol
  const mA = mapOf(walk(11, 120)), mB = mapOf(walk(23, 120));
  const both = Stats.basket([mA, mB], [1, 1]);
  const dsA = Stats.alignDates([mA, mB]);
  const volA = Stats.annVol(dsA.map(d => mA[d])), volB = Stats.annVol(dsA.map(d => mB[d]));
  assert.ok(both.sigma < (volA + volB) / 2);
});

test("blendVol: w=0 → 0; w=1 → σc−σb; ρ=1 → linear blend", () => {
  assert.ok(Math.abs(Stats.blendVol(0.3, 0.6, 0.4, 0)) < 1e-12);
  assert.ok(Math.abs(Stats.blendVol(0.3, 0.6, 0.4, 1) - 0.3) < 1e-12);
  const w = 0.25;
  assert.ok(Math.abs(Stats.blendVol(0.3, 0.6, 1, w) - ((1 - w) * 0.3 + w * 0.6 - 0.3)) < 1e-12);
});

test("momentumQuality: crafted series has known high, drawdown, up-days", () => {
  // 300 closes: flat at 100, spike to 200 at index 260, slide to 120
  const closes = [];
  for (let i = 0; i < 300; i++) {
    if (i < 260) closes.push(100 + i * 0.1);
    else closes.push(200 - (i - 260) * 2);
  }
  const q = Stats.momentumQuality(closes);
  assert.ok(Math.abs(q.hi52 - Math.max(...closes.slice(-252))) < 1e-9);
  assert.ok(Math.abs(q.lo52 - Math.min(...closes.slice(-252))) < 1e-9);
  assert.ok(q.lo52 <= q.last && q.last <= q.hi52 * (1 + 1e-9));
  assert.ok(q.offHigh < 0);
  assert.ok(q.mdd < -0.3); // slid from 200 toward 122
  assert.equal(q.upTot, 63);
  assert.ok(q.upr >= 0 && q.upr <= 1);
});

test("hrp: weights sum to 1; the lower-variance asset gets more weight", () => {
  const calm = [], wild = [];
  let h = 99;
  const rnd = () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return (h >>> 0) / 4294967296; };
  for (let t = 0; t < 100; t++) {
    calm.push((rnd() - 0.5) * 0.005);
    wild.push((rnd() - 0.5) * 0.05);
  }
  const w = Stats.hrp([calm, wild]);
  assert.ok(Math.abs(w[0] + w[1] - 1) < 1e-9);
  assert.ok(w[0] > w[1], `calm asset should outweigh wild (${w[0]} vs ${w[1]})`);
  assert.equal(Stats.hrp([calm]), null);
});

test("reconciliation: JS volFromCloses matches the pipeline's volatility_63d", () => {
  const fx = require(path.join(__dirname, "fixtures", "reconcile.json"));
  assert.ok(fx.cases.length >= 3);
  for (const c of fx.cases) {
    const v = Stats.volFromCloses(c.close, 63);
    assert.ok(v != null, c.symbol + ": vol not computable");
    assert.ok(Math.abs(v - c.expected_vol63) < 1.5e-4,
      `${c.symbol}: JS ${v} vs pipeline ${c.expected_vol63}`);
  }
});
