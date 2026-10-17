// Motor de la estrategia NNFX diaria (port exacto de backtest/round3.py signals() + round4 masked() + nnfx.py simulate()).
(function (root) {
  const CFG = { aroon: 25, sma: 50, hma: 20, sma200: 200, atr: 14, slAtr: 1.0, tpAtr: 1.0, fee: 0.0005, slip: 0.0003, maxAge: 7, addOn: true, addLook: 20 };
  const sign = x => (Number.isNaN(x) ? NaN : x > 0 ? 1 : x < 0 ? -1 : 0);
  function sma(a, n) { const o = new Array(a.length).fill(NaN); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
  function wma(a, n) { const o = new Array(a.length).fill(NaN), W = n * (n + 1) / 2; for (let i = n - 1; i < a.length; i++) { let s = 0, bad = false; for (let k = 0; k < n; k++) { const v = a[i - n + 1 + k]; if (Number.isNaN(v)) { bad = true; break; } s += v * (k + 1); } o[i] = bad ? NaN : s / W; } return o; }
  function hma(a, n) { const w1 = wma(a, Math.floor(n / 2)), w2 = wma(a, n); return wma(w1.map((v, i) => 2 * v - w2[i]), Math.floor(Math.sqrt(n))); }
  function atr(h, l, c, n) { const o = []; let y; for (let i = 0; i < c.length; i++) { const tr = i === 0 ? h[i] - l[i] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])); y = i === 0 ? tr : y + (tr - y) / n; o.push(y); } return o; }
  function aroonDir(h, l, n) { const o = new Array(h.length).fill(0); for (let i = n; i < h.length; i++) { let ai = 0, bi = 0; for (let k = 0; k <= n; k++) { if (h[i - n + k] > h[i - n + ai]) ai = k; if (l[i - n + k] < l[i - n + bi]) bi = k; } o[i] = sign(ai - bi); } return o; }
  function indicators(b, cfg = CFG) {
    const o = b.map(x => x.o), h = b.map(x => x.h), l = b.map(x => x.l), c = b.map(x => x.c);
    const hm = hma(c, cfg.hma);
    return { o, h, l, c, A: atr(h, l, c, cfg.atr), s1: aroonDir(h, l, cfg.aroon), s2: hm.map((v, i) => { const d = i ? v - hm[i - 1] : NaN; return Number.isNaN(d) ? 0 : sign(d); }), bl: sma(c, cfg.sma), s200: sma(c, cfg.sma200), hm };
  }
  function signals(I, cfg = CFG) {
    const { c, A, s1, s2, bl: b } = I, n = c.length, e = new Array(n).fill(0), x = new Array(n).fill(0);
    const bs = c.map((v, i) => sign(v - b[i]));
    let age = 99, lastDir = 0, pend = null;
    for (let i = 1; i < n; i++) {
      if (Number.isNaN(b[i]) || Number.isNaN(A[i])) continue;
      age = s1[i] !== s1[i - 1] ? 0 : age + 1;
      const bflip = bs[i] !== bs[i - 1] && bs[i - 1] !== 0;
      if (bflip) lastDir = 0;
      if (s1[i] !== s1[i - 1] && s1[i] !== 0) x[i] = -s1[i];
      if (bflip) x[i] = -bs[i];
      const agree = (dr, near = true) => bs[i] === dr && s1[i] === dr && s2[i] === dr && (!near || Math.abs(c[i] - b[i]) <= A[i]);
      for (const dr of [1, -1]) {
        const trig = (s1[i] === dr && s1[i - 1] !== dr) || (bflip && bs[i] === dr && age <= cfg.maxAge);
        if (trig && agree(dr)) { e[i] = dr; lastDir = dr; pend = null; break; }
        if (pend && pend[0] === dr && agree(dr)) { e[i] = dr; lastDir = dr; pend = null; break; }
        if (trig && bs[i] === dr && s1[i] === dr) pend = [dr, i];
        else if (s1[i] === dr && s1[i - 1] !== dr && lastDir === dr && agree(dr, false)) { e[i] = dr; break; }
      }
      if (pend && pend[1] < i - 1) pend = null;
    }
    return { e, x };
  }
  // filtro SMA200 propia + bloqueo de entradas cuya vela de entrada (día siguiente) es FOMC/CPI
  function mask(b, I, e, events) {
    return e.map((v, i) => {
      if (!v) return 0;
      const s = I.s200[i]; if (!((v > 0 && I.c[i] > s) || (v < 0 && I.c[i] < s))) return 0;
      if (i + 1 < b.length && events.has(day(b[i + 1].t))) return 0;
      return v;
    });
  }
  const day = t => new Date(t).toISOString().slice(0, 10);
  // b: velas; la última puede estar en formación (solo se usa su apertura para entrar/salir)
  function simulate(b, I, es, xs, cfg = CFG, fund = null) {
    const { o, h, l, A, c } = I, trades = []; let pos = null, add = null;
    const ev = (q, t, k, px, frac) => { const r = frac * q.s * (px - q.e) / q.r; q.R += r; q.ev.push({ t, k, px, frac, R: r }); };
    const closeAdd = (t, px, why) => { ev(add, t, why, px, add.half ? 0.5 : 1); add.why = why; trades.push(fin(add, t, px)); add = null; };
    const newHigh = (i, s) => { if (i < cfg.addLook) return false; for (let k = i - cfg.addLook; k < i; k++) if (s > 0 ? c[k] >= c[i] : c[k] <= c[i]) return false; return true; };
    for (let i = 0; i < b.length - 1; i++) {
      if (add) {
        const frac = add.half ? 0.5 : 1;
        if (fund) add.f += -add.s * (fund[i] || 0) * frac * add.e / add.r;
        const hitSl = add.s > 0 ? l[i] <= add.sl : h[i] >= add.sl, hitTp = !add.half && (add.s > 0 ? h[i] >= add.tp : l[i] <= add.tp);
        if (hitSl) { add.why = add.half ? 'stop en entrada' : 'stop'; ev(add, b[i].t, add.why, add.sl, frac); trades.push(fin(add, b[i].t, add.sl)); add = null; }
        else if (hitTp) { ev(add, b[i].t, 'TP1', add.tp, 0.5); add.half = true; add.sl = add.e; add.tpT = b[i].t; }
      }
      if (pos) {
        const frac = pos.half ? 0.5 : 1;
        if (fund) pos.f += -pos.s * (fund[i] || 0) * frac * pos.e / pos.r;
        const hitSl = pos.s > 0 ? l[i] <= pos.sl : h[i] >= pos.sl;
        const hitTp = !pos.half && (pos.s > 0 ? h[i] >= pos.tp : l[i] <= pos.tp);
        if (hitSl) { pos.why = pos.half ? 'stop en entrada' : 'stop'; ev(pos, b[i].t, pos.why, pos.sl, frac); trades.push(fin(pos, b[i].t, pos.sl)); if (add) closeAdd(b[i].t, pos.sl, 'cierra con la 1ª (stop)'); pos = null; }
        else {
          if (hitTp) { ev(pos, b[i].t, 'TP1', pos.tp, 0.5); pos.half = true; pos.sl = pos.e; pos.tpT = b[i].t; }
          if (xs[i] === pos.s || es[i] === -pos.s) { pos.exitNext = true; pos.why = es[i] === -pos.s ? 'señal contraria' : (I.c[i] - I.bl[i]) * pos.s < 0 ? 'cruce SMA50' : 'cruce Aroon'; }
        }
      }
      if (pos && pos.exitNext) { const frac = pos.half ? 0.5 : 1, px = o[i + 1] * (1 - pos.s * cfg.slip); ev(pos, b[i + 1].t, pos.why, px, frac); trades.push(fin(pos, b[i + 1].t, px)); if (add) closeAdd(b[i + 1].t, px, pos.why); pos = null; }
      if (pos && cfg.addOn && pos.half && !pos.added && !add && newHigh(i, pos.s)) {
        const s = pos.s, ent = o[i + 1] * (1 + s * cfg.slip), r = cfg.slAtr * A[i];
        add = { s, e: ent, r, sl: ent - s * r, sl0: ent - s * r, tp: ent + s * cfg.tpAtr * A[i], half: false, R: 0, f: 0, t0: b[i + 1].t, sig: b[i].t, cost: 2 * cfg.fee * ent / r, add: true, parent: pos.t0, ev: [] };
        pos.added = true;
      }
      if (!pos && es[i] !== 0) {
        const s = es[i], ent = o[i + 1] * (1 + s * cfg.slip), r = cfg.slAtr * A[i];
        pos = { s, e: ent, r, sl: ent - s * r, sl0: ent - s * r, tp: ent + s * cfg.tpAtr * A[i], half: false, R: 0, f: 0, t0: b[i + 1].t, sig: b[i].t, cost: 2 * cfg.fee * ent / r, ev: [] };
      }
    }
    return { trades, open: pos, openAdd: add };
  }
  function fin(p, t1, px) { return { t0: p.t0, t1, s: p.s, e: p.e, sl0: p.sl0, tp: p.tp, half: p.half, px, why: p.why, R: p.R - p.cost + p.f, fees: p.f - p.cost, ev: p.ev, add: !!p.add, parent: p.parent }; }
  function runPair(b, events, cfg = CFG, fund = null) {
    const I = indicators(b, cfg), { e, x } = signals(I, cfg), es = mask(b, I, e, events);
    const sim = simulate(b, I, es, x, cfg, fund);
    const last = b.length - 2; // última vela cerrada
    return { I, es, x, ...sim, last, state: { c: I.c[last], sma: I.bl[last], s200: I.s200[last], aroon: I.s1[last], hma: I.s2[last], atr: I.A[last] } };
  }
  // cartera: tope de posiciones, riesgo % compuesto
  // cartera: cupo de riesgo abierto (posiciones con stop en entrada no cuentan), nocional total <= lev x saldo, riesgo % compuesto
  function portfolio(tr, { cap = Infinity, risk = 0.02, budget = 0.04, lev = 3, start = 100, since = null } = {}) {
    tr = tr.filter(t => since == null || t.t0 >= since).slice().sort((a, b) => a.t0 - b.t0);
    let eq = start, peak = start, dd = 0; const open = [], taken = [], skipped = [], curve = [];
    const close = upto => { open.sort((a, b) => a.t1 - b.t1); while (open.length && open[0].t1 !== Infinity && open[0].t1 <= upto) { const t = open.shift(); eq += t.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); curve.push([t.t1, eq]); } };
    const tp1 = t => { const e = (t.ev || []).find(x => x.k === 'TP1'); return e ? e.t : null; };
    const free = (o, at) => o.tpT != null && o.tpT < at;
    const tk = new Set();
    for (const t0 of tr) {
      close(t0.t0); if (t0.add && !tk.has(t0.p + '|' + t0.parent)) continue;
      const usedR = open.reduce((a, o) => a + (free(o, t0.t0) ? 0 : o.amt), 0), usedN = open.reduce((a, o) => a + o.not * (free(o, t0.t0) ? 0.5 : 1), 0);
      const amt = eq * risk, not = amt / (Math.abs(t0.e - t0.sl0) / t0.e);
      let why = null;
      if (open.length >= cap) why = 'tope de posiciones';
      else if (usedR + amt > eq * budget * 1.000001) why = 'cupo de riesgo lleno';
      else if (usedN + not > eq * lev) why = 'sin margen';
      if (why) { skipped.push({ ...t0, why, usedR: usedR / eq * 100 }); continue; }
      tk.add(t0.p + '|' + t0.t0); const t = { ...t0, tpT: tp1(t0), amt, not, usedN, pnl: amt * t0.R, eqAt: eq }; open.push(t); taken.push(t);
    }
    close(Infinity);
    return { n: taken.length, final: eq, ret: (eq / start - 1) * 100, maxdd: dd * 100, taken, skipped, curve, stillOpen: open };
  }
  function stats(tr) { const r = tr.map(t => t.R); if (!r.length) return { n: 0, win: 0, expR: 0, pf: 0, totR: 0 }; const gp = r.filter(x => x > 0).reduce((a, b) => a + b, 0), gl = -r.filter(x => x < 0).reduce((a, b) => a + b, 0); return { n: r.length, win: 100 * r.filter(x => x > 0).length / r.length, expR: r.reduce((a, b) => a + b, 0) / r.length, pf: gl ? gp / gl : 99, totR: r.reduce((a, b) => a + b, 0) }; }
  const api = { CFG, indicators, signals, mask, simulate, runPair, portfolio, stats, day };
  if (typeof module !== 'undefined') module.exports = api; else root.NNFX = api;
})(this);
