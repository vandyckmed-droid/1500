/* The app's statistics, in one place with one set of conventions.
   Pure functions only — no fetching, no caching, no DOM — so the same code
   runs in the browser (as window.Stats) and under node's test runner
   (test/stats.test.js), and the client can never quietly disagree with
   itself. Conventions, shared by every function here:

   - Daily series are maps of trading date → log return, built by
     logReturnMap from the price archive's {dates, close} arrays.
   - Correlations and betas need at least MIN_OVERLAP common dates.
   - Volatilities are annualized with √252 and use the sample estimator
     (ddof = 1). volFromCloses uses simple returns to match the pipeline's
     volatility_63d exactly; everything portfolio-shaped uses log returns. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Stats = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MIN_OVERLAP = 40;
  var YEAR = 252;

  // {dates, close} → {date: ln(c/c_prev)} over at most maxDays trailing days;
  // null when there are not enough observations to be usable.
  function logReturnMap(dates, close, maxDays) {
    if (!dates || !close || close.length !== dates.length) return null;
    var from = Math.max(1, close.length - (maxDays || 140));
    var m = {}, n = 0;
    for (var j = from; j < close.length; j++) {
      m[dates[j]] = Math.log(close[j] / close[j - 1]);
      n++;
    }
    return n > MIN_OVERLAP ? m : null;
  }

  // Pearson correlation of two date→return maps over their common dates.
  function corr(a, b) {
    if (!a || !b) return null;
    var dates = Object.keys(a).filter(function (dt) { return dt in b; });
    if (dates.length < MIN_OVERLAP) return null;
    var n = dates.length, ma = 0, mb = 0, i, dt;
    for (i = 0; i < n; i++) { dt = dates[i]; ma += a[dt]; mb += b[dt]; }
    ma /= n; mb /= n;
    var sab = 0, sa = 0, sb = 0, xa, xb;
    for (i = 0; i < n; i++) {
      dt = dates[i];
      xa = a[dt] - ma; xb = b[dt] - mb;
      sab += xa * xb; sa += xa * xa; sb += xb * xb;
    }
    return sa && sb ? sab / Math.sqrt(sa * sb) : null;
  }

  // Mean pairwise correlation over every pair with enough overlap.
  function avgPairCorr(maps) {
    var s = 0, n = 0;
    for (var i = 0; i < maps.length; i++) for (var j = i + 1; j < maps.length; j++) {
      var c = corr(maps[i], maps[j]);
      if (c != null) { s += c; n++; }
    }
    return n ? s / n : null;
  }

  // Trading dates every map shares, ascending.
  function alignDates(maps) {
    if (!maps.length) return [];
    var dates = Object.keys(maps[0]);
    for (var k = 1; k < maps.length; k++) {
      var m = maps[k];
      dates = dates.filter(function (dt) { return dt in m; });
    }
    dates.sort();
    return dates;
  }

  // Annualized sample volatility of an array of daily returns.
  function annVol(vals) {
    var n = vals.length;
    if (n < 2) return null;
    var mean = 0, i;
    for (i = 0; i < n; i++) mean += vals[i];
    mean /= n;
    var v = 0;
    for (i = 0; i < n; i++) v += (vals[i] - mean) * (vals[i] - mean);
    return Math.sqrt((v / (n - 1)) * YEAR);
  }

  // Weighted basket of return maps → its own return series and annualized
  // vol. Weights are renormalized over the maps provided (callers drop
  // members with no data before calling). Null when overlap is too thin.
  function basket(maps, weights) {
    if (!maps.length || maps.length !== weights.length) return null;
    var dates = alignDates(maps);
    if (dates.length < MIN_OVERLAP) return null;
    var tot = 0, k;
    for (k = 0; k < weights.length; k++) tot += weights[k];
    if (!(tot > 0)) return null;
    var ret = {}, vals = [];
    for (var i = 0; i < dates.length; i++) {
      var dt = dates[i], s = 0;
      for (k = 0; k < maps.length; k++) s += (weights[k] / tot) * maps[k][dt];
      ret[dt] = s;
      vals.push(s);
    }
    return { ret: ret, sigma: annVol(vals) };
  }

  // Candidate vs basket: ρ over common dates, the candidate's annualized
  // vol on that window, and beta = ρ × σ_c ÷ σ_b (σ_b = the basket's
  // full-window vol, passed in, so beta and the headline share one number).
  function beta(candMap, basketRet, sigmaB) {
    if (!candMap || !basketRet || sigmaB == null) return null;
    var dates = Object.keys(candMap).filter(function (dt) { return dt in basketRet; });
    if (dates.length < MIN_OVERLAP) return null;
    var n = dates.length, mc = 0, mb = 0, i, dt;
    for (i = 0; i < n; i++) { dt = dates[i]; mc += candMap[dt]; mb += basketRet[dt]; }
    mc /= n; mb /= n;
    var vc = 0, vb = 0, cv = 0, xc, xb;
    for (i = 0; i < n; i++) {
      dt = dates[i];
      xc = candMap[dt] - mc; xb = basketRet[dt] - mb;
      vc += xc * xc; vb += xb * xb; cv += xc * xb;
    }
    if (!(vc > 0) || !(vb > 0)) return null;
    var rho = cv / Math.sqrt(vc * vb);
    var sc = Math.sqrt((vc / (n - 1)) * YEAR);
    return { beta: rho * sc / sigmaB, rho: rho, sc: sc };
  }

  // Change in basket vol from giving a candidate a w-sized position:
  // √[(1−w)²σ_b² + w²σ_c² + 2w(1−w)ρσ_bσ_c] − σ_b.
  function blendVol(sigmaB, sigmaC, rho, w) {
    if (sigmaB == null || sigmaC == null || rho == null) return null;
    var k = 1 - w;
    return Math.sqrt(k * k * sigmaB * sigmaB + w * w * sigmaC * sigmaC +
      2 * w * k * rho * sigmaB * sigmaC) - sigmaB;
  }

  // Momentum quality from raw closes: distance below the 52-week high (and
  // the 52-week range for context), worst 6-month peak-to-trough drawdown,
  // share of up days over 63 sessions.
  function momentumQuality(closes) {
    if (!closes || closes.length < 2) return null;
    var last = closes[closes.length - 1];
    var yr = closes.slice(-YEAR);
    var hi52 = Math.max.apply(null, yr);
    var lo52 = Math.min.apply(null, yr);
    var w6 = closes.slice(-126);
    var peak = w6[0], mdd = 0;
    for (var i = 0; i < w6.length; i++) {
      if (w6[i] > peak) peak = w6[i];
      var d = w6[i] / peak - 1;
      if (d < mdd) mdd = d;
    }
    var w63 = closes.slice(-64), upDays = 0, upTot = 0;
    for (var j = 1; j < w63.length; j++) { upTot++; if (w63[j] > w63[j - 1]) upDays++; }
    return {
      last: last, hi52: hi52, lo52: lo52, offHigh: last / hi52 - 1,
      mdd: mdd, upDays: upDays, upTot: upTot, upr: upTot ? upDays / upTot : null,
    };
  }

  // Hierarchical risk parity (Lopez de Prado): correlation-distance
  // single-linkage clustering for the quasi-diagonal order, then recursive
  // bisection with inverse-variance allocations. rets: array of equal-length
  // daily-return arrays. Returns weights summing to 1, or null.
  function hrp(rets) {
    var nA = rets.length;
    if (nA < 2) return null;
    var T = rets[0].length;
    if (T < 2) return null;
    var mean = rets.map(function (r) {
      var s = 0; for (var t = 0; t < T; t++) s += r[t]; return s / T;
    });
    var cov = [];
    for (var a = 0; a < nA; a++) { cov.push(new Array(nA)); }
    for (a = 0; a < nA; a++) for (var b = a; b < nA; b++) {
      var s = 0;
      for (var t = 0; t < T; t++) s += (rets[a][t] - mean[a]) * (rets[b][t] - mean[b]);
      cov[a][b] = cov[b][a] = s / (T - 1);
    }
    var dist = function (a2, b2) {
      return Math.sqrt(Math.max(0, 0.5 * (1 - cov[a2][b2] / Math.sqrt(cov[a2][a2] * cov[b2][b2]))));
    };
    var clusters = [];
    for (a = 0; a < nA; a++) clusters.push([a]);
    while (clusters.length > 1) {
      var bi = 0, bj = 1, bd = Infinity;
      for (var i = 0; i < clusters.length; i++) for (var j = i + 1; j < clusters.length; j++) {
        var d = Infinity;
        for (var x = 0; x < clusters[i].length; x++) for (var y = 0; y < clusters[j].length; y++)
          d = Math.min(d, dist(clusters[i][x], clusters[j][y]));
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
      clusters[bi] = clusters[bi].concat(clusters[bj]);
      clusters.splice(bj, 1);
    }
    var order = clusters[0];
    var w = new Array(nA).fill(1);
    var clusterVar = function (idxs) {
      var ivp = idxs.map(function (i2) { return 1 / cov[i2][i2]; });
      var s2 = ivp.reduce(function (p, q) { return p + q; }, 0);
      var ww = ivp.map(function (v) { return v / s2; });
      var v2 = 0;
      for (var a2 = 0; a2 < idxs.length; a2++) for (var b2 = 0; b2 < idxs.length; b2++)
        v2 += ww[a2] * ww[b2] * cov[idxs[a2]][idxs[b2]];
      return v2;
    };
    var stack = [order];
    while (stack.length) {
      var cl = stack.pop();
      if (cl.length < 2) continue;
      var half = Math.floor(cl.length / 2);
      var c1 = cl.slice(0, half), c2 = cl.slice(half);
      var v1 = clusterVar(c1), vv2 = clusterVar(c2);
      var alpha = 1 - v1 / (v1 + vv2);
      for (i = 0; i < c1.length; i++) w[c1[i]] *= alpha;
      for (i = 0; i < c2.length; i++) w[c2[i]] *= 1 - alpha;
      stack.push(c1, c2);
    }
    var tot = w.reduce(function (p, q) { return p + q; }, 0);
    return w.map(function (v) { return v / tot; });
  }

  // The pipeline's volatility_63d, recomputed in JS: last `window` simple
  // returns of the close series, sample std, annualized. This is the
  // reconciliation anchor between the client and the nightly ranking.
  function volFromCloses(closes, window) {
    var win = window || 63;
    if (!closes || closes.length < win + 1) return null;
    var rets = [];
    for (var i = closes.length - win; i < closes.length; i++)
      rets.push(closes[i] / closes[i - 1] - 1);
    return annVol(rets);
  }

  return {
    MIN_OVERLAP: MIN_OVERLAP,
    logReturnMap: logReturnMap,
    corr: corr,
    avgPairCorr: avgPairCorr,
    alignDates: alignDates,
    annVol: annVol,
    basket: basket,
    beta: beta,
    blendVol: blendVol,
    momentumQuality: momentumQuality,
    hrp: hrp,
    volFromCloses: volFromCloses,
  };
});
