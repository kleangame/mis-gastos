'use strict';
const VERSION = '1.1.0';
if (window.parent !== window) document.body.classList.add('embed');
const DEF = { pairs: 'BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,TRXUSDT', risk: 2, start: 100, cap: 3, maxLev: 3, paperStart: null };
const S = Object.assign({}, DEF, JSON.parse(localStorage.getItem('nnfx.settings') || '{}'));
const DAY = 864e5, MMR = 0.005;
if (!S.paperStart) { S.paperStart = Math.floor(Date.now() / DAY) * DAY; save(); }
const taken = JSON.parse(localStorage.getItem('nnfx.taken') || '{}');
const EV = new Set([...EVENTS.fomc, ...EVENTS.cpi]);
let R = null; // último cálculo

function save() { localStorage.setItem('nnfx.settings', JSON.stringify(S)); }
const $ = s => document.querySelector(s);
const tz = { timeZone: 'America/Montevideo' };
const fd = t => new Date(t).toLocaleDateString('es-UY', { ...tz, day: '2-digit', month: '2-digit', year: '2-digit' });
const fdUTC = t => new Date(t).toLocaleDateString('es-UY', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: '2-digit' });
const px = v => { if (v == null || isNaN(v)) return '—'; const a = Math.abs(v); return v.toLocaleString('es-UY', { maximumFractionDigits: a >= 1000 ? 1 : a >= 1 ? 4 : 7 }); };
const n2 = (v, d = 2) => (v == null || isNaN(v) ? '—' : v.toLocaleString('es-UY', { minimumFractionDigits: d, maximumFractionDigits: d }));
const side = s => s > 0 ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>';
const cls = v => v > 0 ? 'g' : v < 0 ? 'r' : '';
const coin = p => p.replace(/USDT$/, '');
const pair = p => p.replace(/USDT$/, '/USDT');
let chartPair = null, charts = [];

async function getJSON(u) { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); return r.json(); }
async function klines(p) {
  const srcs = [['Futuros', `https://fapi.binance.com/fapi/v1/klines?symbol=${p}&interval=1d&limit=1000`], ['Spot', `https://data-api.binance.vision/api/v3/klines?symbol=${p}&interval=1d&limit=1000`]];
  for (const [name, u] of srcs) {
    try { const k = await getJSON(u); if (Array.isArray(k) && k.length > 210) return { src: name, b: k.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], ct: x[6] })) }; } catch (e) { }
  }
  throw new Error('sin datos para ' + p);
}
async function funding(p) {
  try { const f = await getJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${p}&limit=1000`); const m = {}; f.forEach(x => { const d = Math.floor(x.fundingTime / DAY) * DAY; m[d] = (m[d] || 0) + +x.fundingRate; }); return m; } catch (e) { return null; }
}

async function load() {
  $('#sub').textContent = 'Bajando velas diarias…'; $('#refresh').disabled = true;
  const pairs = S.pairs.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
  const out = await Promise.all(pairs.map(async p => {
    try {
      const [{ src, b }, fm] = await Promise.all([klines(p), funding(p)]);
      if (b[b.length - 1].ct < Date.now()) { const l = b[b.length - 1]; b.push({ t: l.t + DAY, o: l.c, h: l.c, l: l.c, c: l.c, ct: l.t + 2 * DAY - 1 }); }
      const fund = fm ? b.map(x => fm[x.t] || 0) : null;
      return { p, src, b, ...NNFX.runPair(b, EV, NNFX.CFG, fund), fundOk: !!fm };
    } catch (e) { return { p, err: e.message }; }
  }));
  R = { pairs: out.filter(x => !x.err), errs: out.filter(x => x.err), at: Date.now() };
  compute(); render();
  $('#refresh').disabled = false;
}

function compute() {
  const all = [];
  for (const P of R.pairs) {
    P.trades.forEach(t => all.push({ ...t, p: P.p }));
    if (P.open) { const o = P.open, last = P.b[P.b.length - 1]; all.push({ ...o, p: P.p, open: true, t1: Infinity, R: 0, price: last.c }); }
  }
  const opt = { cap: S.cap, risk: S.risk / 100, start: S.start };
  R.today = Math.max(...R.pairs.map(P => P.b[P.b.length - 1].t));
  R.paper = NNFX.portfolio(all, { ...opt, since: S.paperStart });
  R.bt = NNFX.portfolio(all, { ...opt, since: Date.parse('2025-01-01') });
  R.btStats = NNFX.stats(R.bt.taken.filter(t => !t.open));
}

function sizing(t) {
  const risk$ = t.eqAt * S.risk / 100, dist = Math.abs(t.e - t.sl0), qty = risk$ / dist, notional = qty * t.e;
  let lev = 1; while (lev < S.maxLev && notional / lev > t.eqAt / S.cap) lev++;
  const margin = notional / lev, liq = lev === 1 && t.s > 0 ? null : t.s > 0 ? t.e * (1 - 1 / lev + MMR) : t.e * (1 + 1 / lev - MMR);
  return { risk$, qty, notional, lev, margin, liq, stopPct: dist / t.e * 100, tooBig: margin > t.eqAt / S.cap * 1.001 };
}

function render() { renderHoy(); renderPaper(); renderPares(); renderAjustes(); }

function renderHoy() {
  const today = R.today, lastClosed = today - DAY, srcs = [...new Set(R.pairs.map(P => P.src))].join(' + ');
  const pp = R.paper, openPos = pp.stillOpen.filter(t => t.open), unreal = openPos.reduce((a, t) => a + t.eqAt * S.risk / 100 * unrealR(t), 0);
  const next = today + DAY, h = Math.max(0, (next - Date.now()) / 36e5);
  $('#sub').textContent = `Próximo cierre diario 21:00 UY (en ${Math.floor(h)} h ${Math.round((h % 1) * 60)} min) · ${srcs}`;
  let html = `<div class="card"><div class="row"><div><div class="muted">Saldo paper (cerrado)</div><div class="big">${n2(pp.final)} <span class="muted">USDT</span></div></div>
    <div style="text-align:right"><div class="muted">Abierto</div><div class="${cls(unreal)}">${unreal >= 0 ? '+' : ''}${n2(unreal)} USDT</div><div class="muted">${openPos.length}/${S.cap} posiciones</div></div></div></div>`;
  const evToday = EV.has(NNFX.day(today));
  if (evToday) html += `<div class="card"><span class="pill warn">FOMC / CPI hoy</span> No se abren posiciones nuevas en la vela de hoy.</div>`;
  const acts = [];
  // entradas de hoy
  pp.taken.filter(t => t.t0 === today).forEach(t => {
    const z = sizing(t);
    acts.push(`<div class="card"><div class="row"><b>Abrir ${coin(t.p)}</b>${side(t.s)}</div>
      <div class="grid"><div><span>Entrada aprox.</span><span>${px(t.e)}</span></div><div><span>Stop</span><span class="r">${px(t.sl0)}</span></div>
      <div><span>TP1 (50%)</span><span class="g">${px(t.tp)}</span></div><div><span>Stop a</span><span>${n2(z.stopPct, 1)}%</span></div>
      <div><span>Cantidad</span><span>${px(z.qty)} ${coin(t.p)}</span></div><div><span>Nocional</span><span>${n2(z.notional)} USDT</span></div>
      <div><span>Apalancam.</span><span>${z.lev}x aislado</span></div><div><span>Margen</span><span>${n2(z.margin)} USDT</span></div>
      <div><span>Riesgo</span><span>${n2(z.risk$)} USDT</span></div><div><span>Liquidación</span><span>${z.liq ? px(z.liq) : 'no aplica'}</span></div></div>
      <ol class="steps"><li>Orden a mercado ${t.s > 0 ? 'Buy/Long' : 'Sell/Short'} de ${px(z.qty)} ${coin(t.p)}.</li><li>Stop-market reduce-only en ${px(t.sl0)} (todo).</li><li>Take-profit reduce-only en ${px(t.tp)} por la mitad (${px(z.qty / 2)}).</li></ol>
      ${chk(t)}</div>`);
  });
  // salidas en la apertura de hoy
  pp.taken.filter(t => !t.open && t.t1 === today).forEach(t => acts.push(`<div class="card"><div class="row"><b>Cerrar ${coin(t.p)}</b>${side(t.s)}</div><div class="note">Motivo: ${t.why}. Cerrá lo que quede a mercado. Resultado aprox. <b class="${cls(t.R)}">${n2(t.R)} R</b>.</div></div>`));
  // stops tocados en la vela de ayer
  pp.taken.filter(t => !t.open && t.t1 === lastClosed && t.why && t.why.startsWith('stop')).forEach(t => acts.push(`<div class="card"><div class="row"><b>${coin(t.p)}: ${t.why}</b>${side(t.s)}</div><div class="note">Se tocó en la vela de ayer. Si tu stop estaba puesto, la posición ya está cerrada (${n2(t.R)} R).</div></div>`));
  // TP1 tocado ayer
  openPos.filter(t => t.tpT === lastClosed).forEach(t => acts.push(`<div class="card"><div class="row"><b>${coin(t.p)}: TP1 alcanzado</b>${side(t.s)}</div><div class="note">Se cerró la mitad en ${px(t.tp)}. Mové el stop de lo que queda a la entrada: ${px(t.e)}.</div></div>`));
  html += `<h2>Qué hacer hoy</h2>` + (acts.length ? acts.join('') : `<div class="card empty">Nada para hacer hoy. La próxima revisión es a las 21:00.</div>`);
  html += `<h2>Posiciones abiertas</h2>` + (openPos.length ? openPos.map(t => {
    const u = unrealR(t);
    return `<div class="card"><div class="row"><b>${coin(t.p)}</b>${side(t.s)}</div><div class="grid">
      <div><span>Desde</span><span>${fdUTC(t.t0)}</span></div><div><span>Entrada</span><span>${px(t.e)}</span></div>
      <div><span>Stop actual</span><span class="r">${px(t.sl)}</span></div><div><span>TP1</span><span>${t.half ? 'hecho ✓' : px(t.tp)}</span></div>
      <div><span>Precio</span><span>${px(t.price)}</span></div><div><span>Ahora</span><span class="${cls(u)}">${n2(u)} R</span></div></div></div>`;
  }).join('') : `<div class="card empty">Sin posiciones abiertas.</div>`);
  if (R.errs.length) html += `<div class="card note">No se pudo bajar: ${R.errs.map(e => e.p).join(', ')}.</div>`;
  $('#tab-hoy').innerHTML = html; bindChk();
}
function unrealR(t) { const frac = t.half ? 0.5 : 1; return (t.R || 0) + frac * t.s * (t.price - t.e) / t.r - t.cost; }
const key = t => `${t.p}|${t.t0}`;
const chk = t => `<label class="chk"><input type="checkbox" data-k="${key(t)}" ${taken[key(t)] ? 'checked' : ''}> La tomé en Binance</label>`;
function bindChk() { document.querySelectorAll('input[data-k]').forEach(i => i.onchange = () => { if (i.checked) taken[i.dataset.k] = 1; else delete taken[i.dataset.k]; localStorage.setItem('nnfx.taken', JSON.stringify(taken)); }); }

function curveSVG(pf, start) {
  const pts = [[pf.curve.length ? pf.curve[0][0] - DAY : 0, start], ...pf.curve]; if (pts.length < 2) return '';
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys, start), y1 = Math.max(...ys, start);
  const X = x => 4 + (x - x0) / (x1 - x0 || 1) * 312, Y = y => 116 - (y - y0) / (y1 - y0 || 1) * 108;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
  return `<svg viewBox="0 0 320 120"><line x1="4" x2="316" y1="${Y(start)}" y2="${Y(start)}" stroke="#2c3644" stroke-dasharray="3 3"/><path d="${d}" fill="none" stroke="#4da3ff" stroke-width="2"/></svg>`;
}
function tradeRows(list) {
  return `<table><tr><th>Par</th><th>Lado</th><th>Entrada</th><th>Salida</th><th>R</th><th>USDT</th></tr>` + list.slice().reverse().map(t =>
    `<tr><td>${pair(t.p)}${taken[key(t)] ? ' ✓' : ''}</td><td>${t.s > 0 ? 'L' : 'S'}</td><td>${fdUTC(t.t0)}</td><td>${t.open ? 'abierta' : fdUTC(t.t1)}</td><td class="${cls(t.R)}">${t.open ? '—' : n2(t.R)}</td><td class="${cls(t.pnl)}">${t.open ? '—' : n2(t.pnl)}</td></tr>`).join('') + `</table>`;
}
function renderPaper() {
  const pp = R.paper, closed = pp.taken.filter(t => !t.open), st = NNFX.stats(closed), bt = R.bt, bs = R.btStats;
  let html = `<h2>Paper trading desde ${fdUTC(S.paperStart)}</h2><div class="card"><div class="row"><div class="big">${n2(pp.final)} USDT</div><div class="${cls(pp.ret)}">${pp.ret >= 0 ? '+' : ''}${n2(pp.ret, 1)}%</div></div>
    ${curveSVG(pp, S.start)}<div class="grid"><div><span>Operaciones</span><span>${st.n}</span></div><div><span>Ganadoras</span><span>${n2(st.win, 0)}%</span></div>
    <div><span>Promedio</span><span>${n2(st.expR)} R</span></div><div><span>Factor benef.</span><span>${st.n ? n2(st.pf) : '—'}</span></div>
    <div><span>Peor caída</span><span>${n2(pp.maxdd, 1)}%</span></div><div><span>Abiertas</span><span>${pp.stillOpen.length}</span></div></div>
    ${st.n < 30 ? '<div class="note">Con menos de 30 operaciones el resultado todavía es ruido. Hacen falta varios meses.</div>' : ''}</div>`;
  html += pp.taken.length ? `<div class="card">${tradeRows(pp.taken)}</div>` : `<div class="card empty">Todavía no hubo señales desde que empezó el paper trading.</div>`;
  html += `<h2>Control: misma app desde 01/01/2025</h2><div class="card"><div class="row"><div class="big">${n2(bt.final)} USDT</div><div class="${cls(bt.ret)}">${bt.ret >= 0 ? '+' : ''}${n2(bt.ret, 1)}%</div></div>${curveSVG(bt, S.start)}
    <div class="grid"><div><span>Operaciones</span><span>${bs.n}</span></div><div><span>Ganadoras</span><span>${n2(bs.win, 0)}%</span></div><div><span>Promedio</span><span>${n2(bs.expR)} R</span></div><div><span>Peor caída</span><span>${n2(bt.maxdd, 1)}%</span></div></div>
    <div class="note">Sirve para comprobar que la app calcula igual que el backtest (allí: 100 → 181,5 USDT, caída 10,1%). No es una prueba nueva: estos datos ya se usaron para elegir la estrategia.</div></div>
    <details class="card"><summary>Operaciones del control</summary>${tradeRows(bt.taken)}</details>`;
  $('#tab-paper').innerHTML = html;
}
function renderPares() {
  if (chartPair && R.pairs.some(P => P.p === chartPair)) return renderChart(chartPair);
  chartPair = null;
  const dir = v => v > 0 ? '<span class="g">▲</span>' : v < 0 ? '<span class="r">▼</span>' : '·';
  const rows = R.pairs.map(P => {
    const s = P.state, dist = (s.c - s.sma) / s.atr, inPos = P.open;
    let st = inPos ? side(inPos.s) : '<span class="pill wait">espera</span>';
    return `<tr data-pair="${P.p}"><td><b>${pair(P.p)}</b><div class="muted">${px(s.c)}</div></td><td>${dir(s.c - s.sma)} ${n2(dist, 1)}</td><td>${dir(s.aroon)}</td><td>${dir(s.hma)}</td><td>${dir(s.c - s.s200)}</td><td>${st} <span class="chev">›</span></td></tr>`;
  }).join('');
  $('#tab-pares').innerHTML = `<h2>Estado al último cierre · tocá un par para ver la gráfica</h2><div class="card"><table class="tap"><tr><th>Par</th><th>SMA50 (ATR)</th><th>Aroon</th><th>HMA</th><th>SMA200</th><th></th></tr>${rows}</table>
    <div class="note">Para entrar en long tienen que estar todas en ▲ y el precio a 1 ATR o menos de la SMA50 (al revés para short), con un cruce reciente de Aroon o de la SMA50. Datos: ${[...new Set(R.pairs.map(P => P.src))].join(', ')}${R.pairs.some(P => !P.fundOk) ? '; funding no disponible, se calcula sin funding' : ''}.</div></div>`;
  document.querySelectorAll('tr[data-pair]').forEach(tr => tr.onclick = () => { chartPair = tr.dataset.pair; renderChart(chartPair); scrollTo(0, 0); });
}
function aroonUD(h, l, n) {
  const up = [], dn = [];
  for (let i = 0; i < h.length; i++) {
    if (i < n) { up.push(NaN); dn.push(NaN); continue; }
    let ai = 0, bi = 0; for (let k = 0; k <= n; k++) { if (h[i - n + k] > h[i - n + ai]) ai = k; if (l[i - n + k] < l[i - n + bi]) bi = k; }
    up.push(ai / n * 100); dn.push(bi / n * 100);
  }
  return { up, dn };
}
function renderChart(p) {
  charts.forEach(c => c.remove()); charts = [];
  const P = R.pairs.find(x => x.p === p), I = P.I, b = P.b, s = P.state, cs = getComputedStyle(document.documentElement);
  const col = k => cs.getPropertyValue(k).trim();
  const o = P.open, last = b[b.length - 1];
  const dir = v => v > 0 ? '<span class="g">▲ sube</span>' : v < 0 ? '<span class="r">▼ baja</span>' : '·';
  $('#tab-pares').innerHTML = `<div class="row" style="margin-top:12px"><button class="back" id="ch-back">‹ Pares</button><span class="muted">velas diarias</span></div>
    <div class="card"><div class="row"><div><b style="font-size:20px">${pair(p)}</b><div class="muted">${px(last.c)} USDT</div></div><div>${o ? side(o.s) : '<span class="pill wait">sin posición</span>'}</div></div>
    <div id="ch-main" class="chart"></div>
    <div class="legend"><span><i style="background:${col('--b')}"></i>SMA 50</span><span><i style="background:${col('--y')}"></i>HMA 20</span><span><i style="background:${col('--mu')}"></i>SMA 200</span></div>
    <div class="muted" style="margin-top:8px">Aroon 25</div><div id="ch-aroon" class="chart small"></div>
    <div class="legend"><span><i style="background:${col('--g')}"></i>Aroon arriba</span><span><i style="background:${col('--r')}"></i>Aroon abajo</span></div>
    <div class="grid"><div><span>SMA 50</span><span>${px(s.sma)}</span></div><div><span>SMA 200</span><span>${px(s.s200)}</span></div>
    <div><span>Aroon</span><span>${dir(s.aroon)}</span></div><div><span>HMA 20</span><span>${dir(s.hma)}</span></div>
    <div><span>ATR 14</span><span>${px(s.atr)}</span></div><div><span>A la SMA 50</span><span>${n2((s.c - s.sma) / s.atr, 1)} ATR</span></div></div>
    ${o ? `<div class="note">Posición abierta desde ${fdUTC(o.t0)}: entrada ${px(o.e)}, stop ${px(o.sl)}${o.half ? ', TP1 hecho' : `, TP1 ${px(o.tp)}`}.</div>` : ''}
    <div class="note">Flechas: entradas (▲ long, ▼ short) y salidas (●) de la estrategia. Pellizcá o arrastrá para moverte.</div></div>`;
  $('#ch-back').onclick = () => { chartPair = null; charts.forEach(c => c.remove()); charts = []; renderPares(); };
  const opts = h => ({ height: h, layout: { background: { color: 'transparent' }, textColor: col('--mu'), fontSize: 11 }, grid: { vertLines: { visible: false }, horzLines: { color: col('--line') } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false }, crosshair: { mode: 0 }, handleScale: { axisPressedMouseMove: false } });
  const T = t => Math.floor(t / 1000);
  const main = LightweightCharts.createChart($('#ch-main'), { ...opts(320), width: $('#ch-main').clientWidth || innerWidth - 60 });
  const ar = LightweightCharts.createChart($('#ch-aroon'), { ...opts(110), width: $('#ch-aroon').clientWidth || innerWidth - 60, timeScale: { visible: false } });
  charts = [main, ar];
  const cd = main.addCandlestickSeries({ upColor: col('--g'), downColor: col('--r'), wickUpColor: col('--g'), wickDownColor: col('--r'), borderVisible: false });
  cd.setData(b.map(x => ({ time: T(x.t), open: x.o, high: x.h, low: x.l, close: x.c })));
  const line = (arr, color, w = 2) => { const sr = main.addLineSeries({ color, lineWidth: w, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); sr.setData(b.map((x, i) => ({ time: T(x.t), value: arr[i] })).filter(d => !isNaN(d.value))); };
  line(I.bl, col('--b')); line(I.hm, col('--y'), 1.5); line(I.s200, col('--mu'), 1.5);
  const mk = [];
  P.trades.forEach(t => { mk.push({ time: T(t.t0), position: t.s > 0 ? 'belowBar' : 'aboveBar', shape: t.s > 0 ? 'arrowUp' : 'arrowDown', color: t.s > 0 ? col('--g') : col('--r') });
    mk.push({ time: T(t.t1), position: t.s > 0 ? 'aboveBar' : 'belowBar', shape: 'circle', color: t.R > 0 ? col('--g') : col('--r'), text: (t.R > 0 ? '+' : '') + t.R.toFixed(1) + 'R' }); });
  if (o) {
    mk.push({ time: T(o.t0), position: o.s > 0 ? 'belowBar' : 'aboveBar', shape: o.s > 0 ? 'arrowUp' : 'arrowDown', color: o.s > 0 ? col('--g') : col('--r'), text: 'abierta' });
    cd.createPriceLine({ price: o.e, color: col('--mu'), lineWidth: 1, lineStyle: 2, title: 'entrada' });
    cd.createPriceLine({ price: o.sl, color: col('--r'), lineWidth: 1, lineStyle: 2, title: 'stop' });
    if (!o.half) cd.createPriceLine({ price: o.tp, color: col('--g'), lineWidth: 1, lineStyle: 2, title: 'TP1' });
  }
  mk.sort((a, b) => a.time - b.time); cd.setMarkers(mk);
  const A = aroonUD(I.h, I.l, NNFX.CFG.aroon);
  const al = (arr, color) => { const sr = ar.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); sr.setData(b.map((x, i) => ({ time: T(x.t), value: arr[i] })).filter(d => !isNaN(d.value))); };
  al(A.up, col('--g')); al(A.dn, col('--r'));
  const from = T(b[Math.max(0, b.length - 180)].t), to = T(last.t) + 86400 * 3;
  main.timeScale().setVisibleRange({ from, to }); ar.timeScale().setVisibleRange({ from, to });
  let sync = false;
  main.timeScale().subscribeVisibleLogicalRangeChange(r => { if (sync || !r) return; sync = true; ar.timeScale().setVisibleLogicalRange(r); sync = false; });
  ar.timeScale().subscribeVisibleLogicalRangeChange(r => { if (sync || !r) return; sync = true; main.timeScale().setVisibleLogicalRange(r); sync = false; });
}
addEventListener('resize', () => { if (chartPair && charts.length) { charts[0].applyOptions({ width: $('#ch-main').clientWidth || innerWidth - 60 }); charts[1].applyOptions({ width: $('#ch-aroon').clientWidth }); } });
function renderAjustes() {
  $('#tab-ajustes').innerHTML = `<h2>Cuenta paper</h2><div class="card">
    <label>Saldo inicial (USDT)</label><input id="s-start" type="number" min="10" step="1" value="${S.start}">
    <label>Riesgo por operación</label><select id="s-risk">${[1, 2, 3].map(v => `<option value="${v}" ${S.risk == v ? 'selected' : ''}>${v}%</option>`).join('')}</select>
    <label>Máximo de posiciones abiertas</label><select id="s-cap">${[2, 3, 4, 5].map(v => `<option ${S.cap == v ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <label>Apalancamiento máximo</label><select id="s-lev">${[1, 2, 3].map(v => `<option value="${v}" ${S.maxLev == v ? 'selected' : ''}>${v}x</option>`).join('')}</select>
    <label>Inicio del paper trading</label><input id="s-paper" type="date" value="${new Date(S.paperStart).toISOString().slice(0, 10)}">
    <label>Pares (separados por coma)</label><textarea id="s-pairs" rows="3">${S.pairs}</textarea>
    <button class="btn" id="s-save">Guardar</button><button class="btn sec" id="s-def">Volver a los valores probados</button></div>
    <h2>Estrategia</h2><div class="card note" style="margin-top:0">Velas diarias (cierre 21:00 UY). Señal Aroon 25, línea base SMA 50, confirmación pendiente de HMA 20, solo a favor de la SMA 200 del par, precio a ≤1 ATR de la SMA 50, regla de 7 velas, una vela de gracia y continuación. Stop 1 × ATR 14, TP1 1 × ATR con la mitad y stop a la entrada; el resto sale con Aroon en contra o cierre del otro lado de la SMA 50. Sin entradas en días de FOMC o CPI. Costos simulados: 0,05% comisión + 0,03% deslizamiento por lado, funding real cuando está disponible.</div>
    <div class="card note">Solo simula: no se conecta a tu cuenta de Binance ni ejecuta órdenes. Señales v${VERSION}.</div>`;
  $('#s-save').onclick = () => {
    S.start = +$('#s-start').value || 100; S.risk = +$('#s-risk').value; S.cap = +$('#s-cap').value; S.maxLev = +$('#s-lev').value;
    S.paperStart = Date.parse($('#s-paper').value) || S.paperStart; const np = $('#s-pairs').value.replace(/\s/g, '').toUpperCase();
    const reload = np !== S.pairs; S.pairs = np; save(); if (reload) load(); else { compute(); render(); }
  };
  $('#s-def').onclick = () => { Object.assign(S, { ...DEF, paperStart: S.paperStart }); save(); load(); };
}

document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab)); scrollTo(0, 0);
});
$('#refresh').onclick = load;
document.addEventListener('visibilitychange', () => { if (!document.hidden && R && Date.now() - R.at > 10 * 60e3) load(); });

load().catch(e => { $('#sub').textContent = 'Error: ' + e.message; });
