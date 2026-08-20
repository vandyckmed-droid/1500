// S&P 1500 Momentum — native app for Expo Go
// Data: nightly pipeline at github.com/vandyckmed-droid/1500 (GitHub Pages + data branch)
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, FlatList, Pressable, Image, Modal, ScrollView,
  ActivityIndicator, StyleSheet, Platform, StatusBar, PanResponder,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import Svg, { Path, Line as SvgLine, Circle, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_BASE = 'https://1500.vandyck-med.workers.dev';
const DATA_URL = API_BASE + '/data/rankings.json';
const TOP_URL = API_BASE + '/api/top?n=100';        // slim first paint (~20 KB)
const SEARCH_URL = (q) => API_BASE + '/api/search?q=' + encodeURIComponent(q) + '&n=50';
const QUOTE_URL = (s) => API_BASE + '/api/quote/' + encodeURIComponent(s);
const PRICE_URL = (s) => 'https://raw.githubusercontent.com/vandyckmed-droid/1500/data/' + s.replace('.', '_') + '.json';
const LOGO_URL = (s) => 'https://images.financialmodelingprep.com/symbol/' + s.replace('.', '-') + '.png';

const C = {
  bg: '#000000', surface: '#141414', surface2: '#1d1d1f', hairline: '#26262a',
  text: '#f2f2f4', text2: '#9a9aa2', text3: '#6c6c74',
  brand: '#d91222', brandHi: '#ff5a67',
  up: '#1fc27e', down: '#f0443b', gold: '#e7a93c', tile: '#f2f2f4',
};

const tap = (style) => {
  if (Platform.OS === 'web') return;
  if (style === 'select') Haptics.selectionAsync();
  else if (style === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  else if (style === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};

const mcapFmt = (v) => v >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : v >= 1e9 ? '$' + (v / 1e9).toFixed(v < 1e10 ? 1 : 0) + 'B' : '$' + (v / 1e6).toFixed(0) + 'M';
const pctv = (v) => (v > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
const money = (v) => '$' + Number(v).toFixed(2);
const day = (d) => { const [y, m, dd] = d.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1] + ' ' + (+dd) + ', ' + y; };

const MODES = {
  voladj: { label: 'VAR', head: ['12M', '6M'], cols: ['score_12', 'score_6'], fmt: (v) => v.toFixed(2), signed: true },
  ret: { label: 'Return', head: ['12-1', '6-1'], cols: ['return_12_1', 'return_6_1'], fmt: (v) => (v > 0 && v < 10 ? '+' : '') + (v * 100).toFixed(0) + '%', signed: true },
  vol: { label: 'Vol', head: ['12M', '6M'], cols: ['volatility_12m', 'volatility_6m'], fmt: (v) => (v * 100).toFixed(0) + '%', signed: false },
  mcap: { label: 'MCap', head: ['MCAP', ''], cols: ['market_cap', null], fmt: mcapFmt, signed: false },
};
const VIEWS = [
  { k: 'watch', label: '★' }, { k: 'all', label: '1500' }, { k: 'sp500', label: 'S&P 500' },
  { k: 'sp400', label: 'Mid 400' }, { k: 'sp600', label: 'Small 600' },
];
const INDEX_NAME = { sp500: 'S&P 500', sp400: 'S&P MidCap 400', sp600: 'S&P SmallCap 600' };

const SECTOR_ICONS = {
  Energy: { h: 28, d: 'M12 3c2.2 3 5 5.2 5 9a5 5 0 0 1-10 0c0-3.8 2.8-6 5-9z' },
  'Information Technology': { h: 210, d: 'M7 7h10v10H7zM9 4v3M15 4v3M9 17v3M15 17v3M4 9h3M4 15h3M17 9h3M17 15h3' },
  'Real Estate': { h: 260, d: 'M4 21h16M6 21V9.5L12 5l6 4.5V21M10 21v-5h4v5' },
  Financials: { h: 150, d: 'M12 3l9 6H3l9-6zM5 9v9M10 9v9M14 9v9M19 9v9M3 20h18' },
  'Health Care': { h: 350, d: 'M9 4h6v5h5v6h-5v5H9v-5H4V9h5V4z' },
  Utilities: { h: 48, d: 'M13 2 4 14h6l-1 8 9-12h-6l1-8z' },
  Industrials: { h: 200, d: 'M3 21h18M5 21V11l5 3v-3l5 3V9h4v12' },
  'Communication Services': { h: 185, d: 'M12 13v7M7.5 6.5a6.5 6.5 0 0 1 9 0M5 4a10 10 0 0 1 14 0M12 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z' },
  Materials: { h: 90, d: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5' },
  'Consumer Discretionary': { h: 300, d: 'M6 8h12l-1.2 12H7.2L6 8zM9 8a3 3 0 0 1 6 0' },
  'Consumer Staples': { h: 130, d: 'M3 4h2l3 12h10l2-8H7M9.5 19.5v1M16.5 19.5v1' },
};

const hueOf = (sym) => { let h = 7; for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };

function Logo({ sym, size }) {
  const [err, setErr] = useState(false);
  if (err) {
    const h = hueOf(sym);
    return (
      <View style={[st.logo, { width: size, height: size, borderRadius: size / 2, backgroundColor: `hsl(${h}, 28%, 20%)` }]}>
        <Text style={{ color: `hsl(${h}, 65%, 78%)`, fontWeight: '700', fontSize: size * 0.4 }}>{sym[0]}</Text>
      </View>
    );
  }
  return (
    <View style={[st.logo, { width: size, height: size, borderRadius: size / 2, backgroundColor: C.tile }]}>
      <Image source={{ uri: LOGO_URL(sym) }} onError={() => setErr(true)} style={{ width: size * 0.68, height: size * 0.68 }} resizeMode="contain" />
    </View>
  );
}

function StarIcon({ on, size = 21 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 4.2l2.45 4.96 5.48.8-3.96 3.86.93 5.45L12 16.7l-4.9 2.57.93-5.45L4.07 9.96l5.48-.8z"
        stroke={on ? C.gold : C.text3} strokeWidth={1.6} fill={on ? C.gold : 'none'} strokeLinejoin="round"
      />
    </Svg>
  );
}

function Mark({ w = 26 }) {
  return (
    <Svg width={w} height={w / 2} viewBox="0 0 100 46" fill="none">
      <Path d="M4 41 C 22 41, 26 24, 38 26 S 58 34, 68 22 S 86 4, 96 5" stroke={C.brand} strokeWidth={9} strokeLinecap="round" />
      <Circle cx={96} cy={5} r={7} fill={C.brandHi} />
    </Svg>
  );
}

// ---------------- price chart with haptic scrubbing ----------------
const RANGES = [{ k: '1M', n: 22 }, { k: '3M', n: 64 }, { k: '6M', n: 127 }, { k: '1Y', n: 0 }];

function Chart({ sym }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const [rangeKey, setRangeKey] = useState('1Y');
  const [scrub, setScrub] = useState(null); // {i, frac}
  const [w, setW] = useState(0);
  const lastIdx = useRef(-1);
  const H = 180;

  useEffect(() => {
    let live = true;
    fetch(PRICE_URL(sym)).then((r) => { if (!r.ok) throw new Error('http'); return r.json(); })
      .then((d) => live && setData(d)).catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [sym]);

  const view = useMemo(() => {
    if (!data) return null;
    const range = RANGES.find((r) => r.k === rangeKey);
    const n = range.n && range.n < data.close.length ? range.n : data.close.length;
    return { closes: data.close.slice(-n), dates: data.dates.slice(-n) };
  }, [data, rangeKey]);

  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (e, g) => Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderGrant: (e) => { tap('light'); update(e.nativeEvent.locationX); },
    onPanResponderMove: (e) => update(e.nativeEvent.locationX),
    onPanResponderRelease: () => { setScrub(null); lastIdx.current = -1; },
    onPanResponderTerminate: () => { setScrub(null); lastIdx.current = -1; },
  }), [view, w]);

  const update = (x) => {
    if (!view || !w) return;
    const frac = Math.min(1, Math.max(0, x / w));
    const i = Math.round(frac * (view.closes.length - 1));
    if (i !== lastIdx.current) { lastIdx.current = i; tap('select'); }
    setScrub({ i, frac });
  };

  if (failed) return <Text style={[st.dim, { padding: 16 }]}>Chart unavailable right now.</Text>;
  if (!view) return <ActivityIndicator color={C.text3} style={{ padding: 30 }} />;

  const { closes, dates } = view;
  const first = closes[0], last = closes[closes.length - 1];
  const up = last >= first;
  const col = up ? C.up : C.down;
  let min = Math.min(...closes), max = Math.max(...closes);
  if (max === min) max = min + 1;
  const X = (i) => (i / (closes.length - 1)) * w;
  const Y = (v) => 6 + (1 - (v - min) / (max - min)) * (H - 12);
  let path = '';
  for (let i = 0; i < closes.length; i++) path += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(closes[i]).toFixed(1);
  const area = path + `L${w} ${H}L0 ${H}Z`;

  const sIdx = scrub ? scrub.i : closes.length - 1;
  const sPrice = closes[sIdx];
  const delta = sPrice / first - 1;

  return (
    <View style={{ marginHorizontal: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 4, minHeight: 22 }}>
        <Text style={{ color: C.text, fontWeight: '700', fontSize: 15 }}>{money(sPrice)}</Text>
        <Text style={{ color: delta >= 0 ? C.up : C.down, fontWeight: '600', marginLeft: 8, fontSize: 13 }}>{pctv(delta)}</Text>
        <Text style={{ color: C.text3, fontSize: 12, marginLeft: 'auto' }}>
          {scrub ? day(dates[sIdx]) : 'past ' + rangeKey.replace('1M', 'month').replace('3M', '3 months').replace('6M', '6 months').replace('1Y', 'year')}
        </Text>
      </View>
      <View onLayout={(e) => setW(e.nativeEvent.layout.width)} {...pan.panHandlers}>
        {w > 0 && (
          <Svg width={w} height={H}>
            <Defs>
              <LinearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={col} stopOpacity="0.18" />
                <Stop offset="1" stopColor={col} stopOpacity="0" />
              </LinearGradient>
            </Defs>
            <Path d={area} fill="url(#cg)" />
            <SvgLine x1={0} x2={w} y1={Y(first)} y2={Y(first)} stroke="#3a3a40" strokeWidth={1} strokeDasharray="3,6" />
            <Path d={path} stroke={col} strokeWidth={2} fill="none" />
            {scrub && (
              <>
                <SvgLine x1={X(sIdx)} x2={X(sIdx)} y1={0} y2={H} stroke={C.text3} strokeWidth={1} />
                <Circle cx={X(sIdx)} cy={Y(sPrice)} r={4} fill={col} />
              </>
            )}
          </Svg>
        )}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 8 }}>
        {RANGES.map((r) => (
          <Pressable key={r.k} onPress={() => { tap('light'); setRangeKey(r.k); }}
            style={[st.rangeBtn, rangeKey === r.k && { backgroundColor: C.surface2 }]}>
            <Text style={{ color: rangeKey === r.k ? C.text : C.text3, fontWeight: '600', fontSize: 12 }}>{r.k}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// ---------------- strips + explain ----------------
function Strip({ cells, onCell, selKey }) {
  return (
    <View style={st.strip}>
      {cells.map((c, i) => (
        <Pressable key={i} disabled={!c.key} onPress={() => { tap('select'); onCell && onCell(c.key); }}
          style={[st.cell, i > 0 && { borderLeftWidth: 1, borderLeftColor: C.hairline }, c.key && selKey === c.key && { borderColor: C.brand, borderWidth: 1.5, borderRadius: 12 }]}>
          <Text style={st.cellK}>{c.k}</Text>
          <Text style={[st.cellV, c.cls === 'up' && { color: C.up }, c.cls === 'down' && { color: C.down }]}>{c.v}</Text>
          {!!c.sub && <Text style={st.cellSub}>{c.sub}</Text>}
        </Pressable>
      ))}
    </View>
  );
}

function explainFor(g, key, asOf) {
  const money2 = (v) => '$' + Number(v).toFixed(2);
  switch (key) {
    case 'final': return { t: 'Average Volatility Adjusted Returns: the mean of VAR 12-1 and VAR 6-1. Every stock is ranked by this.', m: `(${g('score_12').toFixed(2)} + ${g('score_6').toFixed(2)}) ÷ 2 = ${g('final_score').toFixed(2)}` };
    case 's12': return { t: 'Volatility-adjusted return: the 12-1 return divided by 12-month volatility. Reward per unit of risk.', m: `${pctv(g('return_12_1'))} ÷ ${(g('volatility_12m') * 100).toFixed(1)}% = ${g('score_12').toFixed(2)}` };
    case 's6': return { t: 'Same reward-per-risk idea for the 6-1 return over 6-month volatility.', m: `${pctv(g('return_6_1'))} ÷ ${(g('volatility_6m') * 100).toFixed(1)}% = ${g('score_6').toFixed(2)}` };
    case 'r12': return { t: 'Price move from 12 months ago to 1 month ago. The most recent month is skipped on purpose — standard momentum practice.', m: `${money2(g('price_12m_ago'))} (${day(g('date_12m_ago'))}) → ${money2(g('price_1m_ago'))} (${day(g('date_1m_ago'))}) = ${pctv(g('return_12_1'))}` };
    case 'r6': return { t: 'Same idea over the shorter window: 6 months ago to 1 month ago.', m: `${money2(g('price_6m_ago'))} (${day(g('date_6m_ago'))}) → ${money2(g('price_1m_ago'))} (${day(g('date_1m_ago'))}) = ${pctv(g('return_6_1'))}` };
    case 'v12': return { t: 'How bumpy the ride has been: typical daily swings over 12 months, annualized (× √252).', m: `daily swings × √252 = ${(g('volatility_12m') * 100).toFixed(1)}%` };
    case 'v6': return { t: 'Same bumpiness measure over the last 6 months.', m: `daily swings × √252 = ${(g('volatility_6m') * 100).toFixed(1)}%` };
    case 'mcapx': return { t: 'Market capitalization: what the whole company is worth at the latest price.', m: mcapFmt(g('market_cap')) };
    default: return null;
  }
}

// ---------------- stock sheet ----------------
function StockSheet({ row, IDX, DATA, watch, onToggleWatch, onClose }) {
  const [explain, setExplain] = useState(null);
  const [quote, setQuote] = useState(null);
  const sym = row ? row[IDX.symbol] : null;
  useEffect(() => {
    setQuote(null);
    if (!sym) return;
    let live = true;
    fetch(QUOTE_URL(sym)).then((r) => (r.ok ? r.json() : null))
      .then((q) => { if (live && q && q.price != null) setQuote(q); }).catch(() => {});
    return () => { live = false; };
  }, [sym]);
  if (!row) return null;
  const g = (c) => row[IDX[c]];
  const on = watch.has(sym);
  const total = DATA.total || DATA.rows.length;
  const idxCount = DATA.ranked_counts ? DATA.ranked_counts[g('index')] : null;
  const secMeta = (DATA.sectors || []).find((s) => s.sector === g('sector'));
  const onCell = (key) => setExplain((e) => (e === key ? null : key));
  const ex = explain ? explainFor(g, explain) : null;

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bg }}>
        <View style={st.sheetNav}>
          <Pressable onPress={() => { tap('light'); onClose(); }} hitSlop={10}><Text style={{ color: C.text, fontWeight: '600' }}>Close</Text></Pressable>
          <Text style={{ color: C.text, fontWeight: '700', fontSize: 16 }}>{sym}</Text>
          <Pressable onPress={() => { tap(on ? 'light' : 'success'); onToggleWatch(sym); }} hitSlop={10}><StarIcon on={on} size={24} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 16, paddingBottom: 6 }}>
            <Logo sym={sym} size={52} />
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Text style={{ color: C.text, fontWeight: '700', fontSize: 20 }}>{sym}</Text>
              <Text style={{ color: C.text2, fontSize: 13 }} numberOfLines={1}>{g('name')}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: C.text, fontWeight: '700', fontSize: 19 }}>{money(quote ? quote.price : g('last_price'))}</Text>
              {quote ? (
                <Text style={{ color: quote.change_pct >= 0 ? C.up : C.down, fontSize: 11, fontWeight: '600' }}>
                  {(quote.change_pct >= 0 ? '+' : '') + quote.change_pct.toFixed(2) + '% today'}
                </Text>
              ) : (
                <Text style={{ color: C.text3, fontSize: 11 }}>{day(g('last_date'))}</Text>
              )}
            </View>
          </View>
          <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingBottom: 8, flexWrap: 'wrap' }}>
            <View style={st.badge}><Text style={st.badgeT}>{INDEX_NAME[g('index')]}</Text></View>
            {!!g('sector') && <View style={st.badge}><Text style={st.badgeT}>{g('sector')}</Text></View>}
          </View>

          <Chart sym={sym} />

          <Text style={st.secLabel}>Rank</Text>
          <Strip cells={[
            { k: 'Universe', v: '#' + g('rank_1500'), sub: 'of ' + total },
            { k: 'Index', v: '#' + g('rank_index'), sub: idxCount ? 'of ' + idxCount : '' },
            ...(g('sector') ? [{ k: 'Sector', v: '#' + g('rank_sector'), sub: secMeta ? 'of ' + secMeta.count : '' }] : []),
          ]} />

          <Text style={st.secLabel}>VAR — volatility-adjusted return</Text>
          <Strip selKey={explain} onCell={onCell} cells={[
            { k: 'Average', v: g('final_score').toFixed(2), sub: 'ranked by this', key: 'final', cls: g('final_score') >= 0 ? 'up' : 'down' },
            { k: '12-1', v: g('score_12').toFixed(2), key: 's12', cls: g('score_12') >= 0 ? 'up' : 'down' },
            { k: '6-1', v: g('score_6').toFixed(2), key: 's6', cls: g('score_6') >= 0 ? 'up' : 'down' },
          ]} />
          {ex && ['final', 's12', 's6'].includes(explain) && <ExplainBox ex={ex} />}

          <Text style={st.secLabel}>Return (skips latest month)</Text>
          <Strip selKey={explain} onCell={onCell} cells={[
            { k: '12-1', v: pctv(g('return_12_1')), key: 'r12', cls: g('return_12_1') >= 0 ? 'up' : 'down' },
            { k: '6-1', v: pctv(g('return_6_1')), key: 'r6', cls: g('return_6_1') >= 0 ? 'up' : 'down' },
          ]} />
          {ex && ['r12', 'r6'].includes(explain) && <ExplainBox ex={ex} />}

          <Text style={st.secLabel}>Volatility &amp; size</Text>
          <Strip selKey={explain} onCell={onCell} cells={[
            { k: 'Vol 12M', v: (g('volatility_12m') * 100).toFixed(1) + '%', key: 'v12' },
            { k: 'Vol 6M', v: (g('volatility_6m') * 100).toFixed(1) + '%', key: 'v6' },
            { k: 'Mkt Cap', v: g('market_cap') ? mcapFmt(g('market_cap')) : '—', key: 'mcapx' },
          ]} />
          {ex && ['v12', 'v6', 'mcapx'].includes(explain) && <ExplainBox ex={ex} />}

          <Text style={[st.dim, { padding: 16, fontSize: 12 }]}>Tap any number to see exactly how it was calculated.</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function ExplainBox({ ex }) {
  return (
    <View style={st.explain}>
      <Text style={{ color: C.text2, fontSize: 13, lineHeight: 19 }}>{ex.t}</Text>
      <View style={st.explainMath}><Text style={{ color: C.text, fontSize: 13, fontWeight: '600' }}>{ex.m}</Text></View>
    </View>
  );
}

// ---------------- main app ----------------
export default function App() {
  const [DATA, setDATA] = useState(null);
  const [error, setError] = useState(null);
  const [screen, setScreen] = useState('home');
  const [view, setView] = useState('all');
  const [mode, setMode] = useState('voladj');
  const [query, setQuery] = useState('');
  const [watch, setWatch] = useState(new Set());
  const [openSym, setOpenSym] = useState(null);
  const [searchRows, setSearchRows] = useState(null);

  // While only the slim top-100 is loaded, search the API instead of the
  // partial list; once the full dataset lands this is bypassed entirely.
  useEffect(() => {
    if (!DATA || !DATA.partial || !query) { setSearchRows(null); return; }
    const t = setTimeout(() => {
      fetch(SEARCH_URL(query)).then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setSearchRows(d.rows)).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [DATA, query]);

  const IDX = useMemo(() => {
    const m = {};
    if (DATA) DATA.columns.forEach((c, i) => { m[c] = i; });
    return m;
  }, [DATA]);
  const BYSYM = useMemo(() => {
    const m = {};
    if (DATA) DATA.rows.forEach((r) => { m[r[IDX.symbol]] = r; });
    if (searchRows) searchRows.forEach((r) => { m[r[IDX.symbol]] = r; });
    return m;
  }, [DATA, IDX, searchRows]);

  useEffect(() => {
    // Fast first paint: slim top-100 from the API, then the full 1500 swaps in.
    fetch(TOP_URL).then((r) => { if (!r.ok) throw new Error('http'); return r.json(); })
      .then((d) => setDATA((prev) => (prev && !prev.partial ? prev : { ...d, partial: true })))
      .catch(() => {});
    fetch(DATA_URL, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(setDATA).catch((e) => setDATA((prev) => { if (!prev) setError(String(e.message || e)); return prev; }));
    AsyncStorage.getItem('watch').then((v) => { if (v) setWatch(new Set(JSON.parse(v))); }).catch(() => {});
  }, []);

  const toggleWatch = useCallback((sym) => {
    setWatch((prev) => {
      const next = new Set(prev);
      next.has(sym) ? next.delete(sym) : next.add(sym);
      AsyncStorage.setItem('watch', JSON.stringify([...next])).catch(() => {});
      return next;
    });
  }, []);

  const rows = useMemo(() => {
    if (!DATA) return [];
    let rs = DATA.partial && query && searchRows ? searchRows : DATA.rows;
    if (view === 'watch') rs = rs.filter((r) => watch.has(r[IDX.symbol]));
    else if (view !== 'all') rs = rs.filter((r) => r[IDX.index] === view);
    if (query) {
      const q = query.toLowerCase();
      rs = rs.filter((r) =>
        String(r[IDX.symbol]).toLowerCase().includes(q) ||
        String(r[IDX.name]).toLowerCase().includes(q) ||
        String(r[IDX.sector]).toLowerCase().includes(q));
    }
    if (mode === 'mcap') {
      const i = IDX.market_cap;
      rs = rs.slice().sort((a, b) => (b[i] || 0) - (a[i] || 0));
    }
    return rs;
  }, [DATA, IDX, view, query, watch, mode, searchRows]);

  const cfg = MODES[mode];

  const renderRow = useCallback(({ item: r }) => {
    const sym = r[IDX.symbol];
    const on = watch.has(sym);
    const v1 = r[IDX[cfg.cols[0]]];
    const v2 = cfg.cols[1] ? r[IDX[cfg.cols[1]]] : undefined;
    const colOf = (v) => (v == null ? C.text2 : cfg.signed ? (v > 0 ? C.up : v < 0 ? C.down : C.text2) : C.text);
    return (
      <Pressable onPress={() => { tap('light'); setOpenSym(sym); }} style={({ pressed }) => [st.card, pressed && { transform: [{ scale: 0.985 }], backgroundColor: C.surface2 }]}>
        <Logo sym={sym} size={42} />
        <View style={{ flex: 1, marginLeft: 12, marginRight: 6 }}>
          <Text style={{ color: C.text, fontWeight: '700', fontSize: 16 }}>{sym}</Text>
          <Text style={{ color: C.text2, fontSize: 12.5, marginTop: 1 }} numberOfLines={1}>{r[IDX.name]}</Text>
        </View>
        <Text style={[st.chipTxt, { color: colOf(v1) }]}>{v1 == null ? '—' : cfg.fmt(v1)}</Text>
        {cfg.cols[1] ? <Text style={[st.chipTxt, { color: colOf(v2) }]}>{v2 == null ? '—' : cfg.fmt(v2)}</Text> : <View style={{ width: 62 }} />}
        <Pressable hitSlop={8} onPress={() => { tap(on ? 'light' : 'success'); toggleWatch(sym); }} style={{ paddingLeft: 8 }}>
          <StarIcon on={on} />
        </Pressable>
      </Pressable>
    );
  }, [IDX, cfg, watch, toggleWatch]);

  const body = () => {
    if (error) return <Text style={[st.dim, { padding: 40, textAlign: 'center' }]}>Failed to load: {error}</Text>;
    if (!DATA) return <ActivityIndicator color={C.text3} style={{ marginTop: 60 }} size="large" />;

    if (screen === 'sectors') {
      return (
        <ScrollView>
          <Text style={[st.secLabel, { marginTop: 12 }]}>Equal-weighted VAR · 12-1 / 6-1</Text>
          {(DATA.sectors || []).map((s) => {
            const meta = SECTOR_ICONS[s.sector] || { h: 210, d: 'M4 17l5-6 4 3 7-9' };
            return (
              <Pressable key={s.sector} onPress={() => { tap('light'); setQuery(s.sector); setView('all'); setScreen('home'); }} style={st.card}>
                <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: `hsl(${meta.h}, 30%, 20%)`, alignItems: 'center', justifyContent: 'center' }}>
                  <Svg width={21} height={21} viewBox="0 0 24 24" fill="none">
                    <Path d={meta.d} stroke={`hsl(${meta.h}, 65%, 68%)`} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                  </Svg>
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ color: C.text, fontWeight: '700', fontSize: 15 }}>{s.sector}</Text>
                  <Text style={{ color: C.text2, fontSize: 12 }}>#{s.rank} · {s.count} stocks</Text>
                </View>
                <Text style={[st.chipTxt, { color: s.score_12 >= 0 ? C.up : C.down }]}>{s.score_12.toFixed(2)}</Text>
                <Text style={[st.chipTxt, { color: s.score_6 >= 0 ? C.up : C.down }]}>{s.score_6.toFixed(2)}</Text>
              </Pressable>
            );
          })}
          <View style={{ height: 30 }} />
        </ScrollView>
      );
    }

    if (screen === 'about') {
      const c = DATA.constituent_counts;
      return (
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {[['Prices as of', DATA.as_of], ['Stocks ranked', (DATA.total || DATA.rows.length) + ' of ' + (c.sp500 + c.sp400 + c.sp600)], ['Last update', DATA.generated_at.replace('T', ' ').replace('Z', ' UTC')]].map(([k, v]) => (
            <View key={k} style={st.kv}><Text style={{ color: C.text2 }}>{k}</Text><Text style={{ color: C.text, fontWeight: '600' }}>{v}</Text></View>
          ))}
          <Text style={st.aboutH}>What this is</Text>
          <Text style={st.aboutP}>All S&amp;P 1500 stocks (S&amp;P 500 + MidCap 400 + SmallCap 600), ranked by risk-adjusted momentum — best first. Updated automatically every trading night.</Text>
          <Text style={st.aboutH}>How the numbers work</Text>
          <Text style={st.aboutP}>12-1 / 6-1 return — the move over the past 12 or 6 months, skipping the most recent month.{'\n\n'}Volatility — how bumpy the ride was, from daily swings, annualized.{'\n\n'}VAR — return ÷ volatility: reward per unit of risk. Ranked by Avg VAR, the mean of the 12-1 and 6-1 VARs.</Text>
          <Text style={st.aboutH}>Fine print</Text>
          <Text style={st.aboutP}>Research use only — not investment advice. Data may contain errors.</Text>
        </ScrollView>
      );
    }

    return (
      <>
        <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
          <View style={st.searchBox}>
            <TextInput value={query} onChangeText={setQuery} placeholder="Symbol, company, or sector" placeholderTextColor={C.text3}
              style={{ color: C.text, fontSize: 14, paddingVertical: 8, flex: 1 }} autoCorrect={false} autoCapitalize="none" />
            {!!query && <Pressable onPress={() => { tap('light'); setQuery(''); }} hitSlop={8}><Text style={{ color: C.text3, fontSize: 15 }}>✕</Text></Pressable>}
          </View>
          <View style={{ flexDirection: 'row', marginTop: 8, marginBottom: 4 }}>
            {Object.keys(MODES).map((m) => (
              <Pressable key={m} onPress={() => { tap('select'); setMode(m); }} style={[st.pill, mode === m && { backgroundColor: C.surface2, borderColor: C.hairline }]}>
                <Text style={{ color: mode === m ? C.text : C.text3, fontWeight: '600', fontSize: 12.5 }}>{MODES[m].label}</Text>
              </Pressable>
            ))}
            <View style={{ flex: 1 }} />
            <View style={{ justifyContent: 'center' }}>
              <Text style={{ color: C.text3, fontSize: 11, fontWeight: '600' }}>{cfg.head[0]}{cfg.head[1] ? ' / ' + cfg.head[1] : ''}</Text>
            </View>
          </View>
        </View>
        {view === 'watch' && rows.length === 0 ? (
          <Text style={[st.dim, { padding: 40, textAlign: 'center' }]}>Nothing here yet.{'\n'}Tap the star on any stock to add it.</Text>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(r) => r[IDX.symbol]}
            renderItem={renderRow}
            initialNumToRender={12}
            maxToRenderPerBatch={16}
            windowSize={9}
            contentContainerStyle={{ paddingBottom: 20 }}
          />
        )}
      </>
    );
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
        <StatusBar barStyle="light-content" />
        <View style={st.brandRow}>
          <Mark />
          <Text style={{ color: C.text, fontWeight: '700', fontSize: 17, marginLeft: 8 }}>S&amp;P 1500 Momentum</Text>
          {DATA && <Text style={{ color: C.text3, fontSize: 11, marginLeft: 'auto' }}>{DATA.as_of}</Text>}
        </View>
        {screen === 'home' && (
          <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.hairline }}>
            {VIEWS.map((v) => (
              <Pressable key={v.k} onPress={() => { tap('select'); setView(v.k); }} style={[st.tab, view === v.k && { borderBottomColor: C.brand }]}>
                <Text style={{ color: view === v.k ? C.text : C.text2, fontWeight: '600', fontSize: 13 }}>{v.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={{ flex: 1 }}>{body()}</View>
        <View style={st.tabbar}>
          {[['home', 'Rankings'], ['sectors', 'Sectors'], ['about', 'About']].map(([k, label]) => (
            <Pressable key={k} onPress={() => { tap('select'); setScreen(k); }} style={{ flex: 1, alignItems: 'center', paddingVertical: 10 }}>
              <Text style={{ color: screen === k ? C.text : C.text3, fontWeight: '600', fontSize: 13 }}>{label}</Text>
            </Pressable>
          ))}
        </View>
        {openSym && BYSYM[openSym] && (
          <StockSheet row={BYSYM[openSym]} IDX={IDX} DATA={DATA} watch={watch} onToggleWatch={toggleWatch} onClose={() => setOpenSym(null)} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const st = StyleSheet.create({
  brandRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  searchBox: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.surface2, borderRadius: 10, paddingHorizontal: 12 },
  pill: { borderRadius: 999, borderWidth: 1, borderColor: 'transparent', paddingHorizontal: 13, paddingVertical: 7, marginRight: 6 },
  card: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginVertical: 5,
    padding: 13, backgroundColor: C.surface, borderWidth: 1, borderColor: C.hairline, borderRadius: 16,
  },
  logo: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.hairline, overflow: 'hidden' },
  chipTxt: { width: 62, textAlign: 'right', fontWeight: '700', fontSize: 14.5, fontVariant: ['tabular-nums'] },
  tabbar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.hairline, backgroundColor: '#0a0a0a' },
  sheetNav: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.hairline,
  },
  badge: { backgroundColor: C.surface2, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 4, marginRight: 6, marginTop: 4 },
  badgeT: { color: C.text2, fontSize: 11.5, fontWeight: '600' },
  secLabel: { color: C.text3, fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 },
  strip: { flexDirection: 'row', marginHorizontal: 16, backgroundColor: C.surface, borderWidth: 1, borderColor: C.hairline, borderRadius: 12, overflow: 'hidden' },
  cell: { flex: 1, paddingVertical: 11, alignItems: 'center' },
  cellK: { color: C.text3, fontSize: 10.5, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  cellV: { color: C.text, fontSize: 17, fontWeight: '700', marginTop: 3, fontVariant: ['tabular-nums'] },
  cellSub: { color: C.text3, fontSize: 10.5, marginTop: 1 },
  explain: { marginHorizontal: 16, marginTop: 10, padding: 13, backgroundColor: C.surface, borderLeftWidth: 3, borderLeftColor: C.brand, borderRadius: 12 },
  explainMath: { backgroundColor: C.surface2, borderRadius: 8, padding: 10, marginTop: 8 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: C.hairline },
  aboutH: { color: C.text, fontWeight: '700', fontSize: 15, marginTop: 18, marginBottom: 6 },
  aboutP: { color: C.text2, fontSize: 13.5, lineHeight: 20 },
  dim: { color: C.text3, fontSize: 13.5 },
});
