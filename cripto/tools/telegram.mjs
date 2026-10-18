// Bot de Telegram: avisa las señales del día de la estrategia NNFX diaria (mismo motor que la pestaña Cripto).
// Corre después del cierre diario (00:00 UTC = 21:00 UY). Uso:
//   node cripto/tools/telegram.mjs [state.json]
// Env: TELEGRAM_TOKEN, TELEGRAM_CHAT_ID (secretos del repo; sin token = modo prueba, solo imprime)
//      PAPER_START (2026-10-17), START (100), RISK (2), BUDGET (4), LEV (3), PAIRS, AT (YYYY-MM-DD para simular otro día), FORCE=1 (reenviar)
// Nunca imprime el token ni el chat_id: los logs de Actions de un repo público son públicos.
import fs from 'fs';
import vm from 'vm';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NNFX = createRequire(import.meta.url)(path.join(DIR, 'engine.js'));
const ctx = {}; vm.runInNewContext(fs.readFileSync(path.join(DIR, 'events.js'), 'utf8') + ';this.EVENTS=EVENTS', ctx);
const EV = new Set([...ctx.EVENTS.fomc, ...ctx.EVENTS.cpi]);

const env = process.env, DAY = 864e5, MMR = 0.005;
const STATE = process.argv[2] || 'bot-state.json';
const S = {
  pairs: (env.PAIRS || 'BTCUSDT,ETHUSDT,SOLUSDT,DOGEUSDT,BNBUSDT,XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,LTCUSDT,DOTUSDT,TRXUSDT').split(',').map(s => s.trim()).filter(Boolean),
  risk: +(env.RISK || 2), start: +(env.START || 100), budget: +(env.BUDGET || 4), maxLev: +(env.LEV || 3),
  paperStart: Date.parse(env.PAPER_START || '2026-10-17'),
};
const TOKEN = env.TELEGRAM_TOKEN || '', CHAT = env.TELEGRAM_CHAT_ID || '';
const AT = env.AT ? Date.parse(env.AT) : null;
const CACHE = env.CACHE_DIR || '.cache/vision';
const diag = [];

async function getJSON(u) { const r = await fetch(u, { headers: { 'user-agent': 'mis-gastos-bot' } }); if (!r.ok) throw new Error(r.status + ' ' + u.split('?')[0]); return r.json(); }
const bar = x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], ct: +x[6] });

// --- fuente 1: Binance Futuros en vivo (como la app). Desde EE.UU. suele dar 451.
async function fapi(p) {
  const k = await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${p}&interval=1d&limit=1000`);
  let fund = null;
  try { const f = await getJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${p}&limit=1000`); fund = {}; f.forEach(x => { const d = Math.floor(x.fundingTime / DAY) * DAY; fund[d] = (fund[d] || 0) + +x.fundingRate; }); } catch (e) { }
  return { src: 'Futuros', b: k.map(bar), fund };
}
// --- fuente 2: archivo público de Futuros (data.binance.vision) hasta anteayer + vela de ayer y apertura de hoy de Spot.
// Los zips diarios de Futuros salen ~08:00 UTC del día siguiente, por eso la última vela cerrada viene de Spot.
async function zipRows(url) {
  const f = path.join(CACHE, url.replace(/^https:\/\/data\.binance\.vision\/data\//, '').replace(/\//g, '_'));
  if (!fs.existsSync(f)) {
    const r = await fetch(url); if (r.status === 404) return null; if (!r.ok) throw new Error(r.status + ' ' + url);
    fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  return execFileSync('unzip', ['-p', f]).toString().trim().split('\n').map(l => l.split(',')).filter(x => /^\d/.test(x[0]));
}
const ym = t => new Date(t).toISOString().slice(0, 7), ymd = t => new Date(t).toISOString().slice(0, 10);
async function vision(p, today) {
  const base = 'https://data.binance.vision/data/futures/um', bars = new Map(), fund = {};
  const first = today - 1005 * DAY, curM = ym(today);
  const months = []; for (let d = new Date(first); ym(+d) < curM; d.setUTCMonth(d.getUTCMonth() + 1, 1)) months.push(ym(+d));
  await Promise.all(months.map(async m => {
    const k = await zipRows(`${base}/monthly/klines/${p}/1d/${p}-1d-${m}.zip`); (k || []).forEach(x => bars.set(+x[0], bar(x)));
    const f = await zipRows(`${base}/monthly/fundingRate/${p}/${p}-fundingRate-${m}.zip`).catch(() => null);
    (f || []).forEach(x => { const d = Math.floor(+x[0] / DAY) * DAY; fund[d] = (fund[d] || 0) + +x[2]; });
  }));
  const days = []; for (let t = Date.parse(curM + '-01'); t < today - DAY; t += DAY) days.push(t);
  await Promise.all(days.map(async t => { const k = await zipRows(`${base}/daily/klines/${p}/1d/${p}-1d-${ymd(t)}.zip`); (k || []).forEach(x => bars.set(+x[0], bar(x))); }));
  // lo que falte (ayer, y anteayer si el zip todavía no salió) y la vela de hoy: Spot
  const lastF = Math.max(...bars.keys());
  const sp = (await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${p}&interval=1d&startTime=${lastF + DAY}&limit=10`)).map(bar);
  sp.forEach(x => bars.set(x.t, x));
  const b = [...bars.values()].sort((a, c) => a.t - c.t).slice(-1000);
  for (let i = 1; i < b.length; i++) if (b[i].t - b[i - 1].t !== DAY) throw new Error('hueco en velas ' + p + ' ' + ymd(b[i].t));
  return { src: sp.length > 1 ? 'Futuros (archivo) + Spot ayer' : 'Futuros (archivo)', b, fund };
}
// --- fuente 3: solo Spot (mismo respaldo que la app)
async function spot(p) { return { src: 'Spot', b: (await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${p}&interval=1d&limit=1000`)).map(bar), fund: null }; }

async function loadPair(p, today) {
  for (const [name, fn] of [['fapi', () => fapi(p)], ['vision', () => vision(p, today)], ['spot', () => spot(p)]]) {
    try { const r = await fn(); if (r.b.length > 210) return r; diag.push(`${p} ${name}: pocas velas`); } catch (e) { diag.push(`${p} ${name}: ${String(e.message).slice(0, 80)}`); }
  }
  throw new Error('sin datos para ' + p);
}

// ---- formato (igual que la pestaña Hoy)
const px = v => { if (v == null || isNaN(v)) return '—'; const a = Math.abs(v); return v.toLocaleString('es-UY', { maximumFractionDigits: a >= 1000 ? 1 : a >= 1 ? 4 : 7 }); };
const n2 = (v, d = 2) => (v == null || isNaN(v) ? '—' : v.toLocaleString('es-UY', { minimumFractionDigits: d, maximumFractionDigits: d }));
const coin = p => p.replace(/USDT$/, ''), side = s => s > 0 ? '🟢 LONG' : '🔴 SHORT';
const fdUTC = t => new Date(t).toLocaleDateString('es-UY', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: '2-digit' });
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function sizing(t) {
  const risk$ = t.eqAt * S.risk / 100, dist = Math.abs(t.e - t.sl0), qty = risk$ / dist, notional = qty * t.e;
  const usedN = t.usedN || 0; let lev = 1; while (lev < S.maxLev && (usedN + notional) / lev > t.eqAt) lev++;
  const margin = notional / lev, liq = lev === 1 && t.s > 0 ? null : t.s > 0 ? t.e * (1 - 1 / lev + MMR) : t.e * (1 + 1 / lev - MMR);
  return { risk$, qty, notional, lev, margin, liq, stopPct: dist / t.e * 100 };
}

async function main() {
  const now = AT ? AT + 10 * 60e3 : Date.now(), today = Math.floor(now / DAY) * DAY, lastClosed = today - DAY;
  const out = await Promise.all(S.pairs.map(async p => {
    try {
      let { src, b, fund: fm } = await loadPair(p, today);
      if (AT) b = b.filter(x => x.t <= today);
      if (b[b.length - 1].t < today) { const l = b[b.length - 1]; b.push({ t: l.t + DAY, o: l.c, h: l.c, l: l.c, c: l.c, ct: l.t + 2 * DAY - 1 }); }
      const fund = fm ? b.map(x => fm[x.t] || 0) : null;
      return { p, src, b, ...NNFX.runPair(b, EV, NNFX.CFG, fund) };
    } catch (e) { return { p, err: e.message }; }
  }));
  const R = { pairs: out.filter(x => !x.err), errs: out.filter(x => x.err) };
  if (!R.pairs.length) throw new Error('no se pudo bajar ningún par');
  const all = [];
  for (const P of R.pairs) {
    P.trades.forEach(t => all.push({ ...t, p: P.p }));
    const last = P.b[P.b.length - 1];
    if (P.open) all.push({ ...P.open, p: P.p, open: true, t1: Infinity, R: 0, price: last.c });
    if (P.openAdd) all.push({ ...P.openAdd, p: P.p, open: true, t1: Infinity, R: 0, price: last.c });
  }
  const pp = NNFX.portfolio(all, { risk: S.risk / 100, budget: S.budget / 100, lev: S.maxLev, start: S.start, since: S.paperStart });
  const openPos = pp.stillOpen.filter(t => t.open);
  const srcs = [...new Set(R.pairs.map(P => P.src))].join(' + ');

  const acts = [];
  pp.taken.filter(t => t.t0 === today).forEach(t => {
    const z = sizing(t);
    acts.push(`<b>${t.add ? 'Re-compra' : 'Abrir'} ${coin(t.p)}</b> ${side(t.s)}\n` +
      (t.add ? `La 1ª ya tocó TP1 y cerró en ${t.s > 0 ? 'máximo' : 'mínimo'} de 20 días.\n` : '') +
      `Entrada aprox. ${px(t.e)} · ATR ${px(Math.abs(t.tp - t.e))}\n` +
      `Stop ${px(t.sl0)} (−${n2(z.stopPct, 1)}%) · TP1 50% ${px(t.tp)}\n` +
      `Cantidad ${px(z.qty)} ${coin(t.p)} · nocional ${n2(z.notional)} USDT\n` +
      `${z.lev}x aislado · margen ${n2(z.margin)} · riesgo ${n2(z.risk$)} USDT` + (z.liq ? ` · liq. ${px(z.liq)}` : ''));
  });
  pp.skipped.filter(t => t.t0 === today).forEach(t => acts.push(`<b>${t.add ? 'Re-compra' : 'Señal'} ${coin(t.p)}: no entra</b> ${side(t.s)}\n` +
    (t.why === 'sin margen' ? `El nocional total pasaría ${S.maxLev}× tu saldo.` : `Cupo de riesgo lleno (${n2(t.usedR, 1)} de ${S.budget}% en uso).`)));
  pp.taken.filter(t => !t.open && t.t1 === today).forEach(t => acts.push(`<b>Cerrar ${coin(t.p)}${t.add ? ' (re-compra)' : ''}</b> ${side(t.s)}\nMotivo: ${esc(t.why)}. Cerrá lo que quede a mercado (≈ ${n2(t.R)} R).`));
  pp.taken.filter(t => !t.open && t.t1 === lastClosed && t.why && t.why.startsWith('stop')).forEach(t => acts.push(`<b>${coin(t.p)}: ${esc(t.why)}</b> ${side(t.s)}\nSe tocó en la vela de ayer. Si el stop estaba puesto ya está cerrada (${n2(t.R)} R).`));
  openPos.filter(t => t.tpT === lastClosed).forEach(t => acts.push(`<b>${coin(t.p)}${t.add ? ' (re-compra)' : ''}: TP1 alcanzado</b> ${side(t.s)}\nSe cerró la mitad en ${px(t.tp)}. Mové el stop de lo que queda a la entrada: ${px(t.e)}.`));

  const evToday = EV.has(NNFX.day(today));
  const usedR = openPos.reduce((a, t) => a + (t.half ? 0 : t.amt / pp.final * 100), 0);
  let msg = `<b>Cripto · vela del ${fdUTC(lastClosed)}</b>\n`;
  if (evToday) msg += `⚠️ FOMC / CPI hoy: no se abren posiciones nuevas.\n`;
  msg += '\n' + (acts.length ? acts.join('\n\n') : 'Nada para hacer hoy.') + '\n\n';
  msg += `Saldo paper ${n2(pp.final)} USDT · ${openPos.length} abierta${openPos.length === 1 ? '' : 's'} · riesgo ${n2(usedR, 1)} de ${S.budget}%\n`;
  msg += `<i>Datos: ${esc(srcs)}. Confirmá en la pestaña Cripto antes de operar.</i>`;
  if (R.errs.length) msg += `\nNo se pudo bajar: ${R.errs.map(e => coin(e.p)).join(', ')}.`;

  const dayKey = ymd(today), st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const result = { day: dayKey, actions: acts.length, sources: srcs, diag: diag.slice(0, 40), preview: msg };
  if (!TOKEN) { console.log('[modo prueba, sin token]\n' + msg); fs.writeFileSync(STATE, JSON.stringify({ ...st, lastPreview: result }, null, 1)); return; }
  if (st.lastSent === dayKey && !env.FORCE) { console.log('ya enviado hoy'); return; }
  let chat = CHAT;
  if (!chat) {
    // primera vez: tomar el chat de quien le mandó /start al bot y contestarle ahí con su chat_id (no se imprime en el log)
    const u = await getJSON(`https://api.telegram.org/bot${TOKEN}/getUpdates`).catch(() => null);
    const m = u && u.result.map(x => x.message).filter(Boolean).pop();
    if (!m) { console.log('Falta TELEGRAM_CHAT_ID y nadie le mandó /start al bot todavía.'); fs.writeFileSync(STATE, JSON.stringify({ ...st, lastError: { at: new Date().toISOString(), msg: u ? 'sin /start en getUpdates' : 'token inválido o getUpdates falló' } }, null, 1)); process.exitCode = 1; return; }
    chat = String(m.chat.id);
    await send(chat, `Hola 👋 Soy tu bot de señales cripto. Tu chat_id es <code>${chat}</code>: guardalo en GitHub como secreto TELEGRAM_CHAT_ID.`);
  }
  if (acts.length || evToday || env.SEND_EMPTY === '1') await send(chat, msg);
  fs.writeFileSync(STATE, JSON.stringify({ ...st, lastSent: dayKey, lastRun: result }, null, 1));
  console.log(`enviado: ${acts.length} acciones, fuentes ${srcs}`);
}
async function send(chat, text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }) });
  if (!r.ok) throw new Error('Telegram ' + r.status + ' ' + (await r.text()).replace(TOKEN, '***').slice(0, 200));
}
main().catch(e => { const m = String(e.message).split(TOKEN || '\u0000').join('***'); console.error(m); try { const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}; fs.writeFileSync(STATE, JSON.stringify({ ...st, lastError: { at: new Date().toISOString(), msg: m.slice(0, 300) } }, null, 1)); } catch {} process.exitCode = 1; });
