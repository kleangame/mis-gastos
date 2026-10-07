// Mis Gastos — web app móvil estilo iOS, sincronizada con Google Sheets (Apps Script).
// Gastos, ingresos, balance, presupuestos y tarjetas de crédito con cuotas.
// Funciona offline: guarda una copia local y una cola de cambios que se envía al reconectar.

const CATS = [
  { name: 'Comida',     emoji: '🍔', color: '#FF9500' },
  { name: 'Transporte', emoji: '🚌', color: '#007AFF' },
  { name: 'Casa',       emoji: '🏠', color: '#AF52DE' },
  { name: 'Servicios',  emoji: '💡', color: '#5AC8FA' },
  { name: 'Compras',    emoji: '🛍️', color: '#FFCC00' },
  { name: 'Ocio',       emoji: '🎮', color: '#FF2D55' },
  { name: 'Salud',      emoji: '💊', color: '#34C759' },
  { name: 'Otros',      emoji: '📦', color: '#8E8E93' },
];
const INCOME_CATS = [
  { name: 'Sueldo',         emoji: '💼', color: '#34C759' },
  { name: 'Freelance',      emoji: '💻', color: '#30B0C7' },
  { name: 'Ventas',         emoji: '🏷️', color: '#5856D6' },
  { name: 'Regalos',        emoji: '🎁', color: '#FF2D55' },
  { name: 'Otros ingresos', emoji: '💰', color: '#A2845E' },
];
const CARD_COLORS = [
  'linear-gradient(135deg,#1c1c1e,#48484a)', 'linear-gradient(135deg,#0a3d91,#2f7ae5)',
  'linear-gradient(135deg,#5b1f8a,#a24bd6)', 'linear-gradient(135deg,#0b6e4f,#2fb380)',
  'linear-gradient(135deg,#8a1c1c,#e0533f)',
];
const CURRENCIES = ['UYU', 'USD', 'ARS', 'EUR', 'BRL', 'CLP', 'MXN', 'COP', 'PEN'];
const MONTHS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const CASH = 'cash';           // id de la cuenta Efectivo (también usado por datos de versiones anteriores)
const APP_VERSION = '6.1.0';
// Hoja plantilla con el script ya incluido (modo simple). /copy abre «Hacer una copia» en Google Sheets.
const TEMPLATE_URL = '';
const ACC_TYPES = {
  cash:    { label: 'Efectivo',  emoji: '💵', color: '#34C759' },
  bank:    { label: 'Banco',     emoji: '🏦', color: '#007AFF' },
  savings: { label: 'Ahorro',    emoji: '🐷', color: '#FF9500' },
  invest:  { label: 'Inversión', emoji: '📈', color: '#5856D6' },
};

// ---------- Estado y almacenamiento ----------
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};
const S = {
  expenses: store.get('mg.expenses', []),   // movimientos: gastos e ingresos
  budgets:  store.get('mg.budgets', {}),
  cards:    store.get('mg.cards', []),
  recurring: store.get('mg.recurring', []), // gastos/ingresos fijos mensuales
  accounts: store.get('mg.accounts', null),  // cuentas: banco, efectivo, ahorro, inversión
  transfers: store.get('mg.transfers', []),  // transferencias, pagos de tarjeta y ajustes de saldo
  queue:    store.get('mg.queue', []),
  cfg:      { usdRate: 0, rateDate: '', ...store.get('mg.cfg', { url: '', token: '', currency: 'UYU' }) },
  lastSync: store.get('mg.lastSync', null),
  syncError: null, syncing: false,
  view: 'home', offset: 0, query: '', catFilter: 'Todas',
  editingId: null, selCat: CATS[0].name, selType: 'expense', selCur: '', budgetCat: null, editingCardId: null,
};
function persist() {
  store.set('mg.expenses', S.expenses); store.set('mg.budgets', S.budgets); store.set('mg.cards', S.cards); store.set('mg.recurring', S.recurring);
  store.set('mg.accounts', S.accounts); store.set('mg.transfers', S.transfers);
  store.set('mg.queue', S.queue); store.set('mg.cfg', S.cfg); store.set('mg.lastSync', S.lastSync);
}
const connected = () => !!(S.cfg.url && S.cfg.token);

// ---------- Utilidades ----------
const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const ALL_CATS = [...CATS, ...INCOME_CATS];
const cat = (name) => ALL_CATS.find((c) => c.name === name) || CATS[CATS.length - 1];
const card = (id) => S.cards.find((c) => c.id === id);
const account = (id) => (S.accounts || []).find((a) => a.id === id);
const isCardM = (m) => !!card(m);
const accIcon = (a) => { const t = ACC_TYPES[a.type] || ACC_TYPES.bank; return `<span class="ci" style="background:${t.color}">${t.emoji}</span>`; };
const cardColor = (c) => CARD_COLORS[Math.max(0, S.cards.indexOf(c)) % CARD_COLORS.length];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const r2 = (n) => Math.round(n * 100) / 100;
let money;
function setMoney() {
  money = new Intl.NumberFormat('es-UY', { style: 'currency', currency: S.cfg.currency, maximumFractionDigits: 2 });
  const sym = money.formatToParts(0).find((p) => p.type === 'currency')?.value || '$';
  document.querySelectorAll('#cur-symbol, .cur-symbol-b').forEach((el) => (el.textContent = sym));
}
const fmt = (n) => money.format(n || 0);
// ---------- Dólares ----------
// Un movimiento puede cargarse en USD. Guarda la cotización del día en que se cargó (rate),
// así el historial no cambia cuando se mueve el dólar. Los fijos en USD usan la cotización actual.
const USD = 'USD';
const usdMode = () => S.cfg.currency !== USD;            // si la moneda principal ya es USD, no hace falta
const isUSD = (e) => e.currency === USD && usdMode();
const rateOf = (e) => Number(e.rate) || Number(S.cfg.usdRate) || 0;
const baseAmount = (e) => isUSD(e) ? r2(Number(e.amount) * rateOf(e)) : Number(e.amount);
const usdFmt = new Intl.NumberFormat('es-UY', { style: 'currency', currency: 'USD', currencyDisplay: 'symbol', maximumFractionDigits: 2 });
const fmtUSD = (n) => usdFmt.format(n || 0).replace(/^USD\s?/, 'US$ ');
const rateLabel = (r) => new Intl.NumberFormat('es-UY', { maximumFractionDigits: 2 }).format(r);
async function fetchRate(manual = false) {
  if (!usdMode()) return;
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    const r = data && data.rates && data.rates[S.cfg.currency];
    if (!r) throw new Error('sin cotización');
    S.cfg.usdRate = r2(r); S.cfg.rateDate = new Date().toISOString(); S.cfg.rateManual = false;
    persist(); if (S.view === 'settings' || manual) render();
    if (manual) toast(`Dólar actualizado: ${rateLabel(S.cfg.usdRate)}`);
  } catch (err) { if (manual) toast('No se pudo obtener la cotización'); }
}
const accUSD = (a) => !!a && a.currency === USD && usdMode();
const accCur = (a) => (accUSD(a) ? USD : '');
const entryCur = (e) => (isUSD(e) ? USD : '');
const fmtCur = (n, cur) => (cur === USD ? fmtUSD(n) : fmt(n));
const toBase = (n, cur, rate) => (cur === USD ? n * (Number(rate) || Number(S.cfg.usdRate) || 0) : n);
// Convierte entre la moneda principal ('') y USD.
const conv = (amt, from, to, rate) => (from === to || !(rate > 0) ? amt : from === USD ? amt * rate : amt / rate);
const dateOnly = (iso) => String(iso || '').slice(0, 10);
const rateStale = () => !S.cfg.usdRate || (!S.cfg.rateManual && Date.now() - new Date(S.cfg.rateDate || 0).getTime() > 6 * 3600e3);
const compact = (n) => new Intl.NumberFormat('es-UY', { style: 'currency', currency: S.cfg.currency, notation: 'compact', maximumFractionDigits: 1 }).format(n);
const parseAmount = (s) => {
  s = String(s).trim().replace(/\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');   // "100.000" = cien mil
  return parseFloat(s);
};
const parseLocal = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthKey = (d) => d.getFullYear() * 12 + d.getMonth();
const nowKey = () => monthKey(new Date());
const keyLabel = (k, short = false) => { const m = MONTHS[k % 12]; return short ? m.slice(0, 3) : `${m[0].toUpperCase()}${m.slice(1)} ${Math.floor(k / 12)}`; };
const isIncome = (e) => e.type === 'income';
const nInst = (e) => (!isIncome(e) && isCardM(e.method) ? Math.max(1, Number(e.installments) || 1) : 1);

// ---------- Fijos ----------
// Regla: { id, type, amount, category, note, method, day, start: 'YYYY-MM', end: 'YYYY-MM' | '' (para siempre) }
const ymKey = (ym) => { const [y, m] = ym.split('-').map(Number); return y * 12 + m - 1; };
const ymLabel = (ym) => keyLabel(ymKey(ym), true) + ' ' + ym.slice(0, 4);
const ruleActive = (r, key) => key >= ymKey(r.start) && (!r.end || key <= ymKey(r.end));
const ruleRange = (r) => r.end ? `${ymLabel(r.start)} – ${ymLabel(r.end)}` : `Desde ${ymLabel(r.start)} · sin fin`;
function ruleDate(r, key) {
  const y = Math.floor(key / 12), m = key % 12;
  return isoDate(new Date(y, m, Math.min(Number(r.day) || 1, new Date(y, m + 1, 0).getDate())));
}

// ---------- Cuotas ----------
// Una compra en N cuotas se reparte en N meses. Si la tarjeta tiene día de cierre y la compra
// es posterior a ese día, la primera cuota cae el mes siguiente.
function firstInstallmentKey(e) {
  const d = parseLocal(e.date);
  const c = card(e.method);
  const shift = c && Number(c.closingDay) && d.getDate() > Number(c.closingDay) ? 1 : 0;
  return monthKey(d) + shift;
}
function instCur(e, k) {   // cuota en la moneda original del movimiento
  const n = nInst(e), total = Number(e.amount), base = r2(total / n);
  return k === n - 1 ? r2(total - base * (n - 1)) : base;
}
function installmentAmount(e, k) {
  const n = nInst(e), total = baseAmount(e), base = r2(total / n);
  return k === n - 1 ? r2(total - base * (n - 1)) : base;
}
// Lo que impacta en un mes: cada cuota es una entrada virtual que apunta al movimiento original.
function entriesForMonth(key) {
  const out = [];
  for (const e of S.expenses) {
    const n = nInst(e);
    if (n === 1 && !(isCardM(e.method) && !isIncome(e))) {
      if (monthKey(parseLocal(e.date)) === key) out.push({ ...e, src: e, k: 0, n: 1, value: baseAmount(e) });
      continue;
    }
    const first = firstInstallmentKey(e);
    const k = key - first;
    if (k >= 0 && k < n) {
      const d = parseLocal(e.date);
      const y = Math.floor(key / 12), m = key % 12;
      // La primera cuota usa la fecha de compra; las siguientes se muestran el día 1 de su mes.
      const day = k === 0 && first === monthKey(d) ? d.getDate() : 1;
      out.push({ ...e, src: e, k, n, value: installmentAmount(e, k), date: isoDate(new Date(y, m, day)) });
    }
  }
  for (const r of S.recurring) {
    if (ruleActive(r, key)) out.push({ ...r, src: r, fixed: true, k: 0, n: 1, value: baseAmount(r), date: ruleDate(r, key), updated: '' });
  }
  return out;
}
const monthEntries = (off) => entriesForMonth(nowKey() + off);
const sumV = (arr) => arr.reduce((s, e) => s + e.value, 0);
const expensesOf = (arr) => arr.filter((e) => !isIncome(e));
const incomesOf = (arr) => arr.filter(isIncome);
const byCategory = (items) => {
  const m = {}; items.forEach((e) => (m[e.category] = (m[e.category] || 0) + e.value));
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
};
// ---------- Cuentas ----------
// Saldo = saldo inicial + ingresos − gastos + transferencias, contando solo lo posterior a la creación de la cuenta
// (lo anterior ya está reflejado en el saldo inicial) y hasta hoy.
function accountBalance(a) {
  const cur = accCur(a), today = isoDate(new Date()), sd = dateOnly(a.since);
  let b = Number(a.initial) || 0;
  for (const e of S.expenses) {
    if (e.method !== a.id || e.date > today || !(e.date > sd || String(e.updated || '') > String(a.since || ''))) continue;
    const v = conv(Number(e.amount), entryCur(e), cur, rateOf(e));
    b += isIncome(e) ? v : -v;
  }
  for (const r of S.recurring) {
    if (r.method !== a.id) continue;
    for (let k = ymKey(r.start); k <= nowKey(); k++) {
      if (!ruleActive(r, k)) continue;
      const d = ruleDate(r, k);
      if (d > today || d <= sd || d < dateOnly(r.created)) continue;
      const v = conv(Number(r.amount), entryCur(r), cur, Number(S.cfg.usdRate) || 1);
      b += isIncome(r) ? v : -v;
    }
  }
  for (const t of S.transfers) {
    if (t.date > today) continue;
    if (t.from === a.id) b -= Number(t.amount) || 0;
    if (t.to === a.id) b += Number(t.toAmount) || 0;
  }
  return r2(b);
}
const accountBase = (a) => toBase(accountBalance(a), accCur(a));

// Tarjeta: deuda en pesos y en dólares por separado. Cuenta las cuotas desde que la tarjeta se registró
// (las anteriores se asumen pagadas) hasta este mes, menos los pagos de resumen.
function cardStats(c) {
  const now = nowKey(), sinceK = c.since ? monthKey(parseLocal(dateOnly(c.since))) : now;
  const debt = { '': 0, USD: 0 }, fut = { '': 0, USD: 0 }, thisMonth = { '': 0, USD: 0 };
  const plans = [], future = Array(6).fill(0);
  for (const e of S.expenses) {
    if (isIncome(e) || e.method !== c.id) continue;
    const cur = entryCur(e), n = nInst(e), first = firstInstallmentKey(e);
    let rem = 0, remCount = 0;
    for (let k = 0; k < n; k++) {
      const key = first + k, v = instCur(e, k);
      if (key <= now && key >= sinceK) debt[cur] += v;
      if (key > now) fut[cur] += v;
      if (key >= now) { rem += v; remCount++; }
      if (key === now) thisMonth[cur] += v;
      if (key >= now && key < now + 6) future[key - now] += toBase(v, cur, rateOf(e));
    }
    if (remCount > 0) {
      const current = Math.min(Math.max(now - first + 1, 0), n);
      plans.push({ e, cur, n, current, rem: r2(rem), cuota: instCur(e, 0), startsLater: first > now });
    }
  }
  for (const r of S.recurring) {
    if (isIncome(r) || r.method !== c.id) continue;
    const cur = entryCur(r), v = Number(r.amount);
    for (let k = Math.max(sinceK, ymKey(r.start)); k <= now; k++) if (ruleActive(r, k)) debt[cur] += v;
    if (ruleActive(r, now)) thisMonth[cur] += v;
    for (let i = 0; i < 6; i++) if (ruleActive(r, now + i)) future[i] += toBase(v, cur);
    if (ruleActive(r, now) || ymKey(r.start) > now) plans.push({ e: r, cur, fixed: true, rem: ruleActive(r, now) ? v : 0, cuota: v });
  }
  for (const t of S.transfers) if (t.kind === 'payment' && t.to === c.id) debt[t.cur === USD ? USD : ''] -= Number(t.toAmount) || 0;
  debt[''] = r2(debt['']); debt.USD = r2(debt.USD);
  plans.sort((a, b) => toBase(b.rem, b.cur) - toBase(a.rem, a.cur));
  const owed = Math.max(debt[''], 0) + fut[''] + toBase(Math.max(debt.USD, 0) + fut.USD, USD);
  const limit = Number(c.limit) || 0;
  return { debt, fut, thisMonth, plans, future, limit, outstanding: r2(owed), util: limit ? owed / limit : 0, available: r2(limit - owed),
    hasUSD: !!(debt.USD || fut.USD || thisMonth.USD) };
}

// ---------- Componentes ----------
const sortDesc = (a, b) => b.date.localeCompare(a.date) || String(b.updated || '').localeCompare(String(a.updated || ''));
function dayLabel(iso) {
  const d = parseLocal(iso), t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((t - d) / 864e5);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Ayer';
  return new Intl.DateTimeFormat('es-UY', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
}
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
const icon = (c) => `<span class="ci" style="background:${c.color}">${c.emoji}</span>`;
const progressClass = (p) => (p > 1 ? 'over' : p > .8 ? 'warn' : '');
// Utilización de crédito: hasta 30% sana, 30-80% atención, más de 80% alta.
const utilClass = (u) => (u > .8 ? 'over' : u > .3 ? 'warn' : '');
const monthPicker = () => `<div class="month">
    <button data-action="prev-month" aria-label="Mes anterior">‹</button>
    <span>${keyLabel(nowKey() + S.offset)}</span>
    <button data-action="next-month" aria-label="Mes siguiente">›</button>
  </div>`;
const header = (title, action = 'new-expense') => `
  <div class="nav">${action ? `<button class="icon-btn" data-action="${action}" aria-label="Agregar">+</button>` : ''}</div>
  <h1 class="large-title">${title}</h1>`;
function entryRow(x) {
  const c = cat(x.category), inc = isIncome(x);
  const cd = !inc && isCardM(x.method) ? card(x.method) : null;
  const ac = !cd && S.accounts.length > 1 ? account(x.method) : null;
  const sub = [x.fixed ? 'Fijo' : null, x.note ? x.category : null, cd ? cd.name : ac ? ac.name : null, x.n > 1 ? `cuota ${x.k + 1}/${x.n}` : null, isUSD(x) ? (x.n > 1 ? fmtUSD(r2(x.amount / x.n)) : fmtUSD(x.amount)) : null].filter(Boolean).join(' · ') || dayLabel(x.date);
  return `<button class="row with-icon" data-action="edit-expense" data-id="${esc(x.id)}">
    ${icon(c)}
    <span class="ri"><b>${esc(x.note || x.category)}</b><small>${esc(sub)}</small></span>
    <span class="amt ${inc ? 'income' : ''}">${inc ? '+' : '-'}${fmt(x.value)}</span>
  </button>`;
}
function donutSVG(rows, total) {
  const r = 52, C = 2 * Math.PI * r;
  let acc = 0;
  const segs = rows.map(([name, v]) => {
    const len = (v / total) * C;
    const s = `<circle r="${r}" cx="70" cy="70" fill="none" stroke="${cat(name).color}" stroke-width="18"
      stroke-dasharray="${Math.max(len - 1.5, 0.01)} ${C}" stroke-dashoffset="${-acc}" transform="rotate(-90 70 70)"/>`;
    acc += len; return s;
  }).join('');
  return `<svg class="donut" viewBox="0 0 140 140">
    <circle r="${r}" cx="70" cy="70" fill="none" stroke="var(--fill)" stroke-width="18"/>${segs}
    <text x="70" y="66" text-anchor="middle" font-size="11" opacity=".6">Gastos</text>
    <text x="70" y="84" text-anchor="middle" font-size="14" font-weight="700">${esc(compact(total))}</text>
  </svg>`;
}

// ---------- Vistas ----------
function renderHome() {
  const entries = monthEntries(S.offset).sort(sortDesc);
  const exp = expensesOf(entries), inc = incomesOf(entries);
  const spent = sumV(exp), earned = sumV(inc), balance = earned - spent;
  const prevSpent = sumV(expensesOf(monthEntries(S.offset - 1)));
  const key = nowKey() + S.offset, name = MONTHS[key % 12], prevName = MONTHS[(key + 11) % 12];
  const budgetTotal = Object.values(S.budgets).reduce((s, v) => s + Number(v), 0);
  const pct = budgetTotal ? spent / budgetTotal : 0;
  const rows = byCategory(exp);
  const onCard = sumV(exp.filter((e) => isCardM(e.method)));
  const fixedSpent = sumV(exp.filter((e) => e.fixed));
  let delta = '';
  if (prevSpent > 0) {
    const d = (spent - prevSpent) / prevSpent;
    delta = `<span class="delta ${d > 0 ? 'up' : 'down'}">Gastos ${d > 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}% vs. ${prevName}</span>`;
  }
  $('view-home').innerHTML = `
    ${header('Resumen')}
    ${monthPicker()}
    <div class="card hero">
      <small>Balance de ${name}</small>
      <div class="big ${balance < 0 ? 'neg' : ''}">${balance < 0 ? '-' : ''}${fmt(Math.abs(balance))}</div>
      ${delta}
      <div class="split">
        <div><small class="income">▲ Ingresos</small><b>${fmt(earned)}</b></div>
        <div><small class="danger">▼ Gastos</small><b>${fmt(spent)}</b></div>
      </div>
      ${fixedSpent ? `<div class="meta" style="margin-top:10px"><span>📌 Gastos fijos del mes</span><span>${fmt(fixedSpent)}</span></div>` : ''}
      ${onCard ? `<div class="meta" style="margin-top:${fixedSpent ? 4 : 10}px"><span>💳 Con tarjeta este mes</span><span>${fmt(onCard)}</span></div>` : ''}
      ${budgetTotal ? `
        <div class="progress ${progressClass(pct)}"><i style="width:${Math.min(pct, 1) * 100}%"></i></div>
        <div class="meta"><span>${Math.round(pct * 100)}% del presupuesto</span>
          <span>${pct > 1 ? 'Excedido ' + fmt(spent - budgetTotal) : 'Quedan ' + fmt(budgetTotal - spent)}</span></div>` : ''}
    </div>
    ${rows.length ? `
      <div class="section-h"><span>Gastos por categoría</span></div>
      <div class="card donut-wrap">
        ${donutSVG(rows, spent)}
        <div class="legend">${rows.slice(0, 6).map(([n, v]) => `
          <div><i style="background:${cat(n).color}"></i><span>${n}</span><em>${v / spent < .01 ? '<1' : Math.round((v / spent) * 100)}%</em></div>`).join('')}
        </div>
      </div>` : ''}
    ${entries.length ? `
      <div class="section-h"><span>Recientes</span><button data-tab="list">Ver todos</button></div>
      <div class="group">${entries.slice(0, 5).map(entryRow).join('')}</div>`
    : `<div class="empty"><b>Sin movimientos en ${name}</b>Tocá + para registrar un gasto o ingreso.</div>`}
  `;
}

function renderList() {
  const q = S.query.trim().toLowerCase();
  const filters = ['Todas', 'Ingresos', 'Fijos', 'Tarjeta', 'Transferencias', ...CATS.map((c) => c.name)];
  const items = monthEntries(S.offset)
    .filter((e) => S.catFilter === 'Todas'
      || (S.catFilter === 'Ingresos' && isIncome(e))
      || (S.catFilter === 'Fijos' && e.fixed)
      || (S.catFilter === 'Tarjeta' && !isIncome(e) && isCardM(e.method))
      || e.category === S.catFilter)
    .filter((e) => !q || (e.note || '').toLowerCase().includes(q) || e.category.toLowerCase().includes(q))
    .concat(S.catFilter === 'Todas' || S.catFilter === 'Transferencias' ? transfersForMonth(nowKey() + S.offset)
      .filter((t) => !q || transferTitle(t).toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q)) : [])
    .filter((e) => S.catFilter !== 'Transferencias' || e.isTransfer)
    .sort(sortDesc);
  const groups = {};
  items.forEach((e) => (groups[e.date] = groups[e.date] || []).push(e));
  const net = (list) => { const l = list.filter((e) => !e.isTransfer); return sumV(incomesOf(l)) - sumV(expensesOf(l)); };
  $('view-list').innerHTML = `
    ${header('Movimientos')}
    ${monthPicker()}
    <label class="search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 109.5 16a6.5 6.5 0 004.2-1.6l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 110-9 4.5 4.5 0 010 9z"/></svg>
      <input id="search" type="search" placeholder="Buscar" value="${esc(S.query)}">
    </label>
    <div class="chips">${filters.map((n) => {
      const lbl = n === 'Todas' ? n : n === 'Ingresos' ? '💰 Ingresos' : n === 'Tarjeta' ? '💳 Tarjeta' : n === 'Transferencias' ? '⇄ Transferencias' : n === 'Fijos' ? '📌 Fijos' : cat(n).emoji + ' ' + n;
      return `<button class="chip ${S.catFilter === n ? 'on' : ''}" data-action="filter" data-cat="${n}">${lbl}</button>`;
    }).join('')}</div>
    ${items.length ? Object.entries(groups).map(([date, list]) => {
      const n = net(list);
      return `<div class="section-h"><span>${dayLabel(date)}</span><span>${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n))}</span></div>
      <div class="group">${list.map((x) => x.isTransfer ? transferRow(x) : entryRow(x)).join('')}</div>`;
    }).join('')
      : `<div class="empty"><b>Nada por acá</b>${q || S.catFilter !== 'Todas' ? 'Probá con otra búsqueda o filtro.' : 'Todavía no hay movimientos este mes.'}</div>`}
  `;
}

function transfersForMonth(key) {
  return S.transfers.filter((t) => monthKey(parseLocal(t.date)) === key).map((t) => ({ ...t, isTransfer: true }));
}
function transferTitle(t) {
  if (t.kind === 'payment') return 'Pago ' + (card(t.to)?.name || 'tarjeta');
  if (t.kind === 'adjust') return (account(t.to)?.type === 'invest' ? 'Valor · ' : 'Ajuste · ') + (account(t.to)?.name || '');
  return t.note || 'Transferencia';
}
function transferRow(t) {
  const from = account(t.from), to = account(t.to) || card(t.to);
  const sub = t.kind === 'adjust' ? (t.note || 'Corrección manual')
    : [from?.name, to?.name].filter(Boolean).join(' → ') + (t.kind === 'payment' && t.cur === USD ? ' · ' + fmtUSD(t.toAmount) : '') + (t.kind === 'payment' && t.note ? ' · ' + t.note : '');
  const amt = t.kind === 'adjust' ? `${t.toAmount < 0 ? '-' : '+'}${fmtCur(Math.abs(t.toAmount), accCur(account(t.to)))}` : fmtCur(t.amount, accCur(from));
  return `<button class="row with-icon" data-action="edit-transfer" data-id="${esc(t.id)}">
    <span class="ci" style="background:#8E8E93">${t.kind === 'payment' ? '💳' : t.kind === 'adjust' ? '✏️' : '⇄'}</span>
    <span class="ri"><b>${esc(transferTitle(t))}</b><small>${esc(sub)}</small></span>
    <span class="amt muted">${amt}</span>
  </button>`;
}
function accountRow(a) {
  const bal = accountBalance(a), cur = accCur(a), t = ACC_TYPES[a.type] || ACC_TYPES.bank;
  const goal = Number(a.goal) || 0, p = goal ? Math.max(bal, 0) / goal : 0;
  let sub = t.label + (cur === USD ? ' · USD' : '');
  if (goal) {
    sub = `${Math.round(p * 100)}% de ${fmtCur(goal, cur)}`;
    if (a.goalDate && bal < goal) {
      const months = ymKey(a.goalDate) - nowKey() + 1;
      if (months > 0) sub += ` · ${fmtCur(r2((goal - bal) / months), cur)}/mes`;
    }
  }
  return `<button class="row with-icon ${goal ? 'brow' : ''}" data-action="edit-account" data-id="${esc(a.id)}">
    ${goal ? '<div class="top">' : ''}${accIcon(a)}
    <span class="ri"><b>${esc(a.name)}</b><small>${esc(sub)}</small></span>
    <span class="amt ${bal < 0 ? 'danger' : ''}">${bal < 0 ? '-' : ''}${fmtCur(Math.abs(bal), cur)}${cur === USD ? `<small>≈ ${fmt(Math.abs(accountBase(a)))}</small>` : ''}</span>
    ${goal ? `</div><div class="progress ${p >= 1 ? '' : ''}"><i style="width:${Math.min(p, 1) * 100}%;background:var(--green)"></i></div>` : ''}
  </button>`;
}
function debtLine(s) {
  const parts = [];
  if (s.debt[''] || !s.hasUSD) parts.push(fmt(Math.max(s.debt[''], 0)));
  if (s.hasUSD) parts.push(fmtUSD(Math.max(s.debt.USD, 0)));
  return parts.join(' + ');
}
function renderCards() {
  const avail = S.accounts.filter((a) => a.type === 'cash' || a.type === 'bank');
  const saved = S.accounts.filter((a) => a.type === 'savings' || a.type === 'invest');
  const have = S.accounts.reduce((s, a) => s + accountBase(a), 0);
  const stats = S.cards.map((c) => ({ c, s: cardStats(c) }));
  const owe = stats.reduce((a, x) => a + x.s.outstanding, 0);
  const totLimit = stats.reduce((a, x) => a + x.s.limit, 0);
  const future = Array(6).fill(0); stats.forEach((x) => x.s.future.forEach((v, i) => (future[i] += v)));
  const maxF = Math.max(...future, 1);
  const util = totLimit ? owe / totLimit : 0;
  const net = have - owe;
  $('view-cards').innerHTML = `
    ${header('Cuentas', 'new-account')}
    <div class="card hero">
      <small>Patrimonio neto</small>
      <div class="big ${net < 0 ? 'neg' : ''}">${net < 0 ? '-' : ''}${fmt(Math.abs(net))}</div>
      <div class="split">
        <div><small class="income">Tengo</small><b>${fmt(have)}</b></div>
        <div><small class="danger">Debo</small><b>${fmt(owe)}</b></div>
      </div>
    </div>
    ${S.cfg.setupPending ? `<div class="card setup">
      <b>Configurá tus cuentas</b>
      <p>Poné cuánto efectivo tenés hoy, agregá tus cuentas del banco y asociá cada tarjeta a la cuenta desde la que la pagás. Lo que cargaste antes queda en Efectivo.</p>
      <div class="actions"><button class="btn small" data-action="edit-account" data-id="${CASH}">Empezar</button><button class="link" data-action="setup-done">Listo</button></div>
    </div>` : ''}
    <div class="quick">
      <button data-action="new-account"><span>＋</span>Cuenta</button>
      <button data-action="new-transfer"><span>⇄</span>Transferir</button>
      <button data-action="new-card"><span>💳</span>Tarjeta</button>
    </div>
    <div class="section-h"><span>Disponible</span></div>
    <div class="group">${avail.map(accountRow).join('') || '<div class="row"><span class="val">Sin cuentas</span></div>'}</div>
    ${saved.length ? `<div class="section-h"><span>Ahorro e inversiones</span></div>
      <div class="group">${saved.map(accountRow).join('')}</div>` : ''}
    <div class="section-h"><span>Tarjetas</span>${S.cards.length ? `<span>${Math.round(util * 100)}% del crédito usado</span>` : ''}</div>
    ${!S.cards.length ? `<div class="group"><button class="row blue" data-action="new-card">Agregar tarjeta de crédito<span></span></button></div>` : ''}
    ${stats.map(({ c, s }) => `
      <button class="ccard" style="background:${cardColor(c)}" data-action="edit-card" data-id="${esc(c.id)}">
        <div class="cname"><span>${esc(c.name)}</span><span>${Math.round(s.util * 100)}%</span></div>
        <div class="chip-ic"></div>
        <small>Saldo a pagar</small>
        <div class="avail ${s.hasUSD && s.debt[''] ? 'two' : ''}">${debtLine(s)}</div>
        <div class="progress ${utilClass(s.util)}"><i style="width:${Math.min(s.util, 1) * 100}%"></i></div>
        <div class="meta"><span>Disponible ${fmt(s.available)} de ${fmt(s.limit)}</span><span>${c.closingDay ? 'Cierra el ' + c.closingDay : ''}</span></div>
      </button>
      <button class="btn pay" data-action="pay-card" data-id="${esc(c.id)}">Pagar resumen${account(c.payFrom) ? ' desde ' + esc(account(c.payFrom).name) : ''}</button>
      ${s.plans.length ? `
        <div class="section-h"><span>Cuotas · ${esc(c.name)}</span></div>
        <div class="group">${s.plans.map((p) => `
          <button class="row with-icon" data-action="edit-expense" data-id="${esc(p.e.id)}">
            ${icon(cat(p.e.category))}
            <span class="ri"><b>${esc(p.e.note || p.e.category)}</b>
              <small>${p.fixed ? `Fijo · ${fmtCur(p.cuota, p.cur)}/mes · ${p.e.end ? 'hasta ' + ymLabel(p.e.end) : 'sin fin'}` : p.n > 1 ? (p.startsLater ? `Empieza el mes que viene · ${p.n} cuotas` : `Cuota ${p.current} de ${p.n}`) + ` · ${fmtCur(p.cuota, p.cur)}/mes` : 'Un pago'}</small></span>
            <span class="amt">${fmtCur(p.rem, p.cur)}</span>
          </button>`).join('')}
        </div>` : ''}
    `).join('')}
    ${S.cards.length ? `<div class="section-h"><span>Cuotas próximos 6 meses</span></div>
    <div class="card">
      <div class="months">${future.map((v, i) => `
        <div><b>${v ? compact(v) : ''}</b><i style="height:${(v / maxF) * 80}px"></i><span>${keyLabel(nowKey() + i, true)}</span></div>`).join('')}
      </div>
    </div>
    <p class="footer-note">Lo que vas a pagar de tarjeta cada mes por las cuotas ya registradas (en dólares, convertido a ${esc(S.cfg.currency)}).</p>` : ''}
  `;
}

function fixedSection() {
  const key = nowKey() + S.offset;
  const rules = [...S.recurring].sort((a, b) => (isIncome(a) - isIncome(b)) || baseAmount(b) - baseAmount(a));
  const net = rules.filter((r) => ruleActive(r, key)).reduce((s, r) => s + (isIncome(r) ? 1 : -1) * baseAmount(r), 0);
  return `<div class="section-h"><span>Fijos mensuales</span><button data-action="new-fixed">Agregar</button></div>
    ${rules.length ? `<div class="group">${rules.map((r) => {
      const on = ruleActive(r, key), cd = isCardM(r.method) ? card(r.method) : account(r.method);
      return `<button class="row with-icon" data-action="edit-expense" data-id="${esc(r.id)}" style="${on ? '' : 'opacity:.5'}">
        ${icon(cat(r.category))}
        <span class="ri"><b>${esc(r.note || r.category)}</b><small>${esc(ruleRange(r))}${cd ? ' · ' + esc(cd.name) : ''} · día ${r.day}${isUSD(r) ? ' · ' + fmtUSD(r.amount) : ''}</small></span>
        <span class="amt ${isIncome(r) ? 'income' : ''}">${isIncome(r) ? '+' : '-'}${fmt(baseAmount(r))}</span>
      </button>`;
    }).join('')}</div>
    <p class="footer-note">Neto fijo de ${MONTHS[key % 12]}: ${net < 0 ? '-' : '+'}${fmt(Math.abs(net))}. Los atenuados no corren este mes.</p>`
    : `<div class="group"><button class="row blue" data-action="new-fixed">Agregar alquiler, sueldo, suscripciones…<span></span></button></div>`}`;
}

function renderBudgets() {
  const exp = expensesOf(monthEntries(S.offset));
  const spent = Object.fromEntries(byCategory(exp));
  const budgetTotal = Object.values(S.budgets).reduce((s, v) => s + Number(v), 0);
  const spentBudgeted = Object.keys(S.budgets).reduce((s, k) => s + (spent[k] || 0), 0);
  const pct = budgetTotal ? spentBudgeted / budgetTotal : 0;
  $('view-budgets').innerHTML = `
    ${header('Presupuestos', null)}
    ${monthPicker()}
    <div class="card hero">
      <small>Disponible este mes</small>
      <div class="big">${budgetTotal ? fmt(Math.max(budgetTotal - spentBudgeted, 0)) : '—'}</div>
      ${budgetTotal ? `
        <div class="progress ${progressClass(pct)}"><i style="width:${Math.min(pct, 1) * 100}%"></i></div>
        <div class="meta"><span>Gastado ${fmt(spentBudgeted)}</span><span>Límite ${fmt(budgetTotal)}</span></div>`
        : '<span class="delta" style="color:var(--label2)">Definí un límite por categoría para controlar tu mes.</span>'}
    </div>
    ${fixedSection()}
    <div class="section-h"><span>Categorías</span></div>
    <div class="group">${CATS.map((c) => {
      const b = Number(S.budgets[c.name] || 0), s = spent[c.name] || 0, p = b ? s / b : 0;
      return `<button class="row brow" data-action="edit-budget" data-cat="${c.name}">
        <div class="top">${icon(c)}
          <span class="ri"><b>${c.name}</b><small>${b ? `${fmt(s)} de ${fmt(b)}` : s ? `${fmt(s)} · sin límite` : 'Sin límite · tocá para definir'}</small></span>
          ${b ? `<span class="amt ${p > 1 ? 'danger' : ''}">${p > 1 ? '-' + fmt(s - b) : fmt(b - s)}</span>` : '<span class="chev"></span>'}
        </div>
        ${b ? `<div class="progress ${progressClass(p)}"><i style="width:${Math.min(p, 1) * 100}%"></i></div>` : ''}
      </button>`;
    }).join('')}</div>
    <p class="footer-note">Las compras en cuotas cuentan en cada mes por el valor de la cuota.</p>
  `;
}

function renderSettings() {
  const st = S.syncing ? ['busy', 'Sincronizando…'] : S.syncError ? ['err', 'Error: ' + S.syncError]
    : connected() ? ['ok', S.lastSync ? 'Sincronizado ' + new Date(S.lastSync).toLocaleString('es-UY', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : 'Conectado']
    : ['', 'Solo en este dispositivo'];
  $('view-settings').innerHTML = `
    ${header('Ajustes', null)}
    <div class="section-h"><span>Google Sheets</span></div>
    <div class="group">
      <div class="row"><span>Estado</span><span class="val"><i class="status-dot ${st[0]}"></i>${esc(st[1])}</span></div>
      ${S.queue.length ? `<div class="row"><span>Cambios pendientes</span><span class="val">${S.queue.length}</span></div>` : ''}
    </div>
    ${connected()
      ? `<button class="btn" data-action="sync-now" ${S.syncing ? 'disabled' : ''}>Sincronizar ahora</button>
         <div class="group"><button class="row danger center" data-action="disconnect">Desconectar hoja</button></div>`
      : `<div class="card steps">
          <b>Guardá tus datos en tu Google Sheet</b>
          <ol>
            <li>Tocá <b>Crear mi hoja</b> y después «Hacer una copia».</li>
            <li>En la copia: Extensiones → Apps Script → <b>Implementar</b> → Nueva implementación → Implementar, y aceptá los permisos.</li>
            <li>En la hoja, menú <b>Mis Gastos → Conectar celular</b>, y escaneá el QR.</li>
          </ol>
          <button class="btn" data-action="create-sheet">Crear mi hoja</button>
          <button class="link" data-action="paste-code">¿Te dio un código? Pegalo acá</button>
        </div>
        <details class="adv">
          <summary>Configuración avanzada</summary>
          <div class="group">
            <label class="row"><span>URL del script</span><input id="cfg-url" type="url" placeholder="https://script.google.com/…" value="${esc(S.cfg.url)}"></label>
            <label class="row"><span>Clave</span><input id="cfg-token" type="password" placeholder="Tu clave secreta" value="${esc(S.cfg.token)}"></label>
          </div>
          <button class="btn" data-action="connect">Conectar hoja</button>
          <p class="footer-note">Para quien ya tiene el script pegado en su propia hoja. Las instrucciones están en el README.</p>
        </details>`}
    <div class="section-h"><span>General</span></div>
    <div class="group">
      <label class="row"><span>Moneda</span>
        <select id="cfg-currency">${CURRENCIES.map((c) => `<option ${c === S.cfg.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
      ${usdMode() ? `<label class="row"><span>Dólar (1 US$)</span><input id="cfg-rate" inputmode="decimal" placeholder="Cotización" value="${S.cfg.usdRate ? String(S.cfg.usdRate).replace('.', ',') : ''}"></label>
      <button class="row blue" data-action="refresh-rate">Actualizar cotización<span class="val">${S.cfg.rateDate ? (S.cfg.rateManual ? 'manual' : new Date(S.cfg.rateDate).toLocaleString('es-UY', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })) : ''}</span></button>` : ''}
    </div>
    ${usdMode() ? `<p class="footer-note">Podés cargar movimientos en dólares. Se convierten a ${esc(S.cfg.currency)} con la cotización del día en que los cargás; los fijos en dólares usan la cotización actual.</p>` : ''}
    <div class="section-h"><span>Datos</span></div>
    <div class="group">
      <button class="row blue" data-action="backup">Guardar copia de seguridad<span></span></button>
      <button class="row blue" data-action="restore">Restaurar copia de seguridad<span></span></button>
      <button class="row blue" data-action="export">Exportar CSV<span></span></button>
      <button class="row danger" data-action="wipe">Borrar datos de este dispositivo</button>
    </div>
    <p class="footer-note">${S.expenses.length} movimientos, ${S.recurring.length} fijos, ${S.accounts.length} cuentas y ${S.cards.length} tarjetas guardados. Borrar los datos locales no toca tu Google Sheet.</p>
    <div class="section-h"><span>Acerca de</span></div>
    <div class="group">
      <div class="row"><span>Versión</span><span class="val" id="app-version">${APP_VERSION}</span></div>
    </div>
    <p class="footer-note center">Mis Gastos v${APP_VERSION}</p>
  `;
}

const VIEWS = { home: renderHome, list: renderList, cards: renderCards, budgets: renderBudgets, settings: renderSettings };
function render() { VIEWS[S.view](); }
function show(view) {
  S.view = view;
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === view));
  render(); window.scrollTo(0, 0);
}

// ---------- Cambios de datos ----------
function enqueue(op) {
  if (connected()) S.queue.push(op);
  persist(); render(); sync();
}
function upsertExpense(e) {
  e.updated = new Date().toISOString();
  const i = S.expenses.findIndex((x) => x.id === e.id);
  if (i >= 0) S.expenses[i] = e; else S.expenses.push(e);
  enqueue({ type: 'upsert', expense: e });
}
function deleteExpense(id) {
  S.expenses = S.expenses.filter((e) => e.id !== id);
  enqueue({ type: 'delete', id });
}
function setBudget(category, amount) {
  if (amount > 0) S.budgets[category] = amount; else delete S.budgets[category];
  enqueue({ type: 'budget', category, amount: amount > 0 ? amount : 0 });
}
function upsertCard(c) {
  c.updated = new Date().toISOString();
  const i = S.cards.findIndex((x) => x.id === c.id);
  if (i >= 0) S.cards[i] = c; else S.cards.push(c);
  enqueue({ type: 'card', card: c });
}
function upsertRecurring(r) {
  r.updated = new Date().toISOString();
  const i = S.recurring.findIndex((x) => x.id === r.id);
  if (i >= 0) S.recurring[i] = r; else S.recurring.push(r);
  enqueue({ type: 'recurring', rule: r });
}
function deleteRecurring(id) {
  S.recurring = S.recurring.filter((r) => r.id !== id);
  enqueue({ type: 'deleteRecurring', id });
}
function upsertAccount(a) {
  a.updated = new Date().toISOString();
  const i = S.accounts.findIndex((x) => x.id === a.id);
  if (i >= 0) S.accounts[i] = a; else S.accounts.push(a);
  enqueue({ type: 'account', account: a });
}
function deleteAccount(id) {
  S.accounts = S.accounts.filter((a) => a.id !== id);
  enqueue({ type: 'deleteAccount', id });
}
function upsertTransfer(t) {
  t.updated = new Date().toISOString();
  if (!t.created) t.created = t.updated;
  const i = S.transfers.findIndex((x) => x.id === t.id);
  if (i >= 0) S.transfers[i] = t; else S.transfers.push(t);
  enqueue({ type: 'transfer', transfer: t });
}
function deleteTransfer(id) {
  S.transfers = S.transfers.filter((t) => t.id !== id);
  enqueue({ type: 'deleteTransfer', id });
}
function deleteCard(id) {
  S.cards = S.cards.filter((c) => c.id !== id);
  enqueue({ type: 'deleteCard', id });
}

// ---------- Sincronización con Google Sheets ----------
async function api(body) {
  // Sin headers personalizados: así es una "simple request" y Apps Script no exige preflight CORS.
  const res = await fetch(S.cfg.url, { method: 'POST', body: JSON.stringify({ token: S.cfg.token, ...body }) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Respuesta inválida');
  return data;
}
async function sync(manual = false) {
  if (!connected() || S.syncing) return;
  S.syncing = true; S.syncError = null; if (S.view === 'settings') render();
  const ops = S.queue.slice();
  try {
    const data = await api({ action: 'sync', ops });
    S.queue = S.queue.slice(ops.length);
    if (!S.queue.length) {
      S.expenses = data.expenses; S.budgets = data.budgets; S.cards = data.cards || []; S.recurring = data.recurring || [];
      // Un script de una versión anterior no devuelve cuentas: se conservan las locales.
      if (Array.isArray(data.accounts) && data.accounts.length) S.accounts = data.accounts;
      if (Array.isArray(data.transfers)) S.transfers = data.transfers;
      ensureCash();
    }
    S.lastSync = new Date().toISOString();
    persist();
    if (manual) toast('Sincronizado con Google Sheets');
  } catch (err) {
    S.syncError = navigator.onLine ? err.message : 'sin conexión';
    if (manual) toast('No se pudo sincronizar: ' + S.syncError);
  } finally {
    S.syncing = false; render();
  }
  if (S.queue.length && !S.syncError) sync();
}
async function connect() { return connectWith($('cfg-url').value.trim(), $('cfg-token').value.trim()); }
// Código de conexión que muestra la hoja: base64 (web-safe) de "url|clave".
function decodeCode(code) {
  try {
    const b = code.trim().replace(/-/g, '+').replace(/_/g, '/');
    const [url, token] = atob(b + '==='.slice((b.length + 3) % 4)).split('|');
    return url && token ? { url, token } : null;
  } catch (e) { return null; }
}
async function connectFromHash() {
  const m = location.hash.match(/^#connect=([^&]+)&k=(.+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  show('settings');
  await connectWith(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  if (connected()) toast('¡Listo! Tu app quedó conectada a tu hoja');
}
// Copia de seguridad: un archivo JSON con todo lo guardado en este dispositivo.
function backup() {
  const data = { app: 'mis-gastos', version: APP_VERSION, date: new Date().toISOString(),
    expenses: S.expenses, budgets: S.budgets, cards: S.cards, recurring: S.recurring, accounts: S.accounts, transfers: S.transfers,
    cfg: { currency: S.cfg.currency, usdRate: S.cfg.usdRate } };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = `mis-gastos-${isoDate(new Date())}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Copia guardada');
}
function restore() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    try {
      const d = JSON.parse(await inp.files[0].text());
      if (d.app !== 'mis-gastos' || !Array.isArray(d.expenses)) throw new Error('formato');
      if (!confirm(`¿Reemplazar los datos de este dispositivo por la copia del ${new Date(d.date).toLocaleDateString('es-UY')}?`)) return;
      S.expenses = d.expenses; S.budgets = d.budgets || {}; S.cards = d.cards || []; S.recurring = d.recurring || [];
      S.accounts = d.accounts || null; S.transfers = d.transfers || [];
      if (d.cfg?.currency) { S.cfg.currency = d.cfg.currency; S.cfg.usdRate = d.cfg.usdRate || S.cfg.usdRate; }
      ensureCash(); S.cfg.setupPending = false; persist(); setMoney(); render();
      if (connected()) { queueAll(); persist(); sync(true); }
      toast('Copia restaurada');
    } catch (e) { toast('Ese archivo no es una copia de Mis Gastos'); }
  };
  inp.click();
}
function queueAll() {
  S.queue = [
    ...S.cards.map((c) => ({ type: 'card', card: c })),
    ...S.accounts.map((a) => ({ type: 'account', account: a })),
    ...S.recurring.map((r) => ({ type: 'recurring', rule: r })),
    ...S.transfers.map((t) => ({ type: 'transfer', transfer: t })),
    ...S.expenses.map((e) => ({ type: 'upsert', expense: e })),
    ...Object.entries(S.budgets).map(([category, amount]) => ({ type: 'budget', category, amount })),
  ];
}
async function connectWith(url, token) {
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return toast('Pegá la URL de la app web de Apps Script');
  if (!token) return toast('Ingresá la clave que pusiste en el script');
  S.cfg.url = url; S.cfg.token = token;
  // Sube lo que ya había en el teléfono (el servidor evita duplicados por id).
  queueAll();
  persist();
  await sync(true);
  if (S.syncError) { S.cfg.url = ''; S.cfg.token = ''; S.queue = []; persist(); render(); }
}

// ---------- Hoja de movimiento ----------
function openExpense(id = null, fixed = false) {
  const rule = id ? S.recurring.find((x) => x.id === id) : null;
  const e = rule || (id ? S.expenses.find((x) => x.id === id) : null);
  S.editingId = e ? e.id : null;
  S.editingRule = !!rule;
  S.selType = e ? (e.type || 'expense') : (S.catFilter === 'Ingresos' ? 'income' : 'expense');
  const cats = S.selType === 'income' ? INCOME_CATS : CATS;
  S.selCat = e ? e.category : (cats.some((c) => c.name === S.catFilter) ? S.catFilter : cats[0].name);
  $('f-amount').value = e ? String(e.amount).replace('.', ',') : '';
  S.selCur = e && isUSD(e) ? USD : '';
  $('f-rate').value = e && isUSD(e) && e.rate ? String(e.rate).replace('.', ',') : (S.cfg.usdRate ? String(S.cfg.usdRate).replace('.', ',') : '');
  if (rateStale()) fetchRate().then(() => { if (!$('f-rate').value && S.cfg.usdRate) { $('f-rate').value = String(S.cfg.usdRate).replace('.', ','); updateCur(); } });
  $('f-date').value = rule ? ruleDate(rule, ymKey(rule.start)) : e ? e.date : isoDate(new Date());
  $('f-rec').checked = rule ? true : fixed;
  $('f-end-mode').value = rule && rule.end ? 'date' : '';
  $('f-end').value = rule && rule.end ? rule.end : '';
  $('f-note').value = e ? e.note || '' : '';
  const valid = (m) => account(m) || card(m);
  S.selMethod = e && valid(e.method) ? e.method : valid(S.cfg.lastMethod) ? S.cfg.lastMethod : CASH;
  if (!e && account(S.selMethod)) S.selCur = accCur(account(S.selMethod));
  $('f-inst').innerHTML = Array.from({ length: 36 }, (_, i) => `<option value="${i + 1}">${i + 1 === 1 ? '1 pago' : i + 1 + ' cuotas'}</option>`).join('');
  $('f-inst').value = e ? String(nInst(e)) : '1';
  $('f-delete-group').hidden = !e;
  applyType();
  $('sheet').showModal();
  if (!e) setTimeout(() => $('f-amount').focus(), 120);
}
function applyType() {
  const inc = S.selType === 'income';
  document.querySelectorAll('#f-type button').forEach((b) => b.classList.toggle('on', b.dataset.type === S.selType));
  $('sheet-title').textContent = (S.editingId ? 'Editar ' : 'Nuevo ') + (inc ? 'ingreso' : 'gasto');
  const cats = inc ? INCOME_CATS : CATS;
  if (!cats.some((c) => c.name === S.selCat)) S.selCat = cats[0].name;
  if (inc && !account(S.selMethod)) S.selMethod = account(S.cfg.lastIncomeMethod) ? S.cfg.lastIncomeMethod : CASH;
  renderFrom();
  renderCatGrid(); updateCur(); updateRec();
}
function updateCur() {
  const usd = S.selCur === USD, fixed = $('f-rec').checked;
  $('f-cur').hidden = !usdMode();
  document.querySelectorAll('#f-cur button').forEach((b) => b.classList.toggle('on', (b.dataset.cur === USD) === usd));
  $('f-cur-local').textContent = S.cfg.currency;
  $('cur-symbol').textContent = usd ? 'US$' : (money.formatToParts(0).find((p) => p.type === 'currency')?.value || '$');
  $('f-rate-group').hidden = !usd || fixed;
  const amount = parseAmount($('f-amount').value);
  const rate = fixed ? Number(S.cfg.usdRate) : parseAmount($('f-rate').value);
  $('f-usd-hint').hidden = !usd;
  if (usd) $('f-usd-hint').textContent = !(rate > 0) ? 'Poné la cotización del dólar para convertirlo.'
    : (amount > 0 ? `≈ ${fmt(r2(amount * rate))} a ${rateLabel(rate)} por dólar.` : `Cotización: ${rateLabel(rate)} por dólar.`)
      + (fixed ? ' Cada mes se convierte con la cotización actual.' : '');
}
function renderFrom() {
  const inc = S.selType === 'income';
  $('f-from-label').textContent = inc ? 'A' : 'Desde';
  const opts = [...S.accounts.map((a) => ({ id: a.id, label: `${(ACC_TYPES[a.type] || ACC_TYPES.bank).emoji} ${a.name}` })),
    ...(inc ? [] : S.cards.map((c) => ({ id: c.id, label: `💳 ${c.name}` })))];
  $('f-from').innerHTML = opts.map((o) => `<button type="button" class="chip ${o.id === S.selMethod ? 'on' : ''}" data-action="pick-from" data-id="${esc(o.id)}">${esc(o.label)}</button>`).join('');
}
function renderCatGrid() {
  const cats = S.selType === 'income' ? INCOME_CATS : CATS;
  $('f-cats').innerHTML = cats.map((c) =>
    `<button type="button" class="${c.name === S.selCat ? 'on' : ''}" data-action="pick-cat" data-cat="${c.name}">${icon(c)}${c.name}</button>`).join('');
}
function updateRec() {
  const rec = $('f-rec').checked, byDate = $('f-end-mode').value === 'date';
  $('f-end-row').hidden = !rec;
  $('f-end-month-row').hidden = !(rec && byDate);
  $('f-date-label').textContent = rec ? 'Primer pago' : 'Fecha';
  if (rec && byDate && !$('f-end').value && $('f-date').value) {
    const d = parseLocal($('f-date').value);   // sugerencia: un año después
    $('f-end').value = `${d.getFullYear() + 1}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const amount = formBaseAmount();
  const show = rec && $('f-date').value;
  $('f-rec-hint').hidden = !show;
  if (show) {
    const d = parseLocal($('f-date').value), start = monthKey(d);
    const end = byDate && $('f-end').value ? ymKey($('f-end').value) : null;
    const months = end !== null ? end - start + 1 : null;
    $('f-rec-hint').textContent = months !== null && months < 1 ? 'El último mes tiene que ser igual o posterior al primer pago.'
      : `Se registra el día ${d.getDate()} de cada mes, desde ${keyLabel(start).toLowerCase()}` +
        (months ? ` hasta ${keyLabel(end).toLowerCase()} (${months} ${months === 1 ? 'mes' : 'meses'}${amount > 0 ? ', ' + fmt(amount * months) + ' en total' : ''}).` : ', sin fecha de fin.');
  }
  updateCur(); updateInstHint();
}
function formBaseAmount() {
  const a = parseAmount($('f-amount').value);
  if (S.selCur !== USD) return a;
  return a * ($('f-rec').checked ? Number(S.cfg.usdRate) : parseAmount($('f-rate').value));
}
function updateInstHint() {
  const isCard = S.selType === 'expense' && isCardM(S.selMethod) && !$('f-rec').checked;
  $('f-inst-row').hidden = !isCard;
  const n = Number($('f-inst').value) || 1, amount = formBaseAmount();
  const show = isCard && n > 1 && amount > 0;
  $('f-inst-hint').hidden = !show;
  if (show) $('f-inst-hint').textContent = `${n} cuotas de ${fmt(r2(amount / n))}. Se reparten mes a mes en tu balance y en la tarjeta.`;
}
function saveExpense() {
  const amount = parseAmount($('f-amount').value);
  if (!(amount > 0)) { $('f-amount').focus(); return toast('Ingresá un monto válido'); }
  const date = $('f-date').value || isoDate(new Date());
  const inc = S.selType === 'income';
  const method = S.selMethod || CASH;
  const installments = isCardM(method) && !inc ? Number($('f-inst').value) || 1 : 1;
  if (inc) S.cfg.lastIncomeMethod = method; else S.cfg.lastMethod = method;
  const wasEditing = !!S.editingId;
  const usd = S.selCur === USD && usdMode();
  const rate = usd ? parseAmount($('f-rate').value) : 0;
  if (usd && $('f-rec').checked && !(Number(S.cfg.usdRate) > 0)) return toast('Definí la cotización del dólar en Ajustes');
  if (usd && !$('f-rec').checked && !(rate > 0)) { $('f-rate').focus(); return toast('Ingresá la cotización del dólar'); }
  const cur = usd ? { currency: USD } : { currency: '' };
  if ($('f-rec').checked) {
    const d = parseLocal(date);
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const end = $('f-end-mode').value === 'date' ? $('f-end').value : '';
    if (end && ymKey(end) < ymKey(start)) return toast('El último mes no puede ser anterior al primero');
    if (S.editingId && !S.editingRule) deleteExpense(S.editingId);   // un gasto común pasó a fijo
    const prevRule = S.editingRule ? S.recurring.find((x) => x.id === S.editingId) : null;
    upsertRecurring({ id: S.editingRule ? S.editingId : uid(), created: prevRule?.created || new Date().toISOString(), type: S.selType, amount: r2(amount), category: S.selCat,
      note: $('f-note').value.trim(), method, day: d.getDate(), start, end, ...cur, rate: '' });
    $('sheet').close(); render();
    return toast(wasEditing ? 'Fijo actualizado' : 'Fijo mensual guardado');
  }
  if (S.editingRule) deleteRecurring(S.editingId);   // un fijo pasó a gasto común
  upsertExpense({ id: S.editingId || uid(), type: S.selType, amount: r2(amount), category: S.selCat, date,
    note: $('f-note').value.trim(), method, installments, ...cur, rate: usd ? r2(rate) : '' });
  $('sheet').close();
  const d = parseLocal(date);
  S.offset = Math.min(0, monthKey(d) - nowKey());
  render();
  toast(wasEditing ? 'Movimiento actualizado' : installments > 1 ? `Compra en ${installments} cuotas guardada` : inc ? 'Ingreso guardado' : 'Gasto guardado');
}

// ---------- Hojas de presupuesto y tarjeta ----------
function openBudget(category) {
  S.budgetCat = category;
  $('b-title').textContent = category;
  const b = S.budgets[category];
  $('b-amount').value = b ? String(b).replace('.', ',') : '';
  $('bsheet').showModal();
  setTimeout(() => $('b-amount').focus(), 120);
}
function openCard(id = null) {
  const c = id ? card(id) : null;
  S.editingCardId = c ? c.id : null;
  $('c-title').textContent = c ? 'Editar tarjeta' : 'Nueva tarjeta';
  $('c-name').value = c ? c.name : '';
  $('c-limit').value = c ? String(c.limit).replace('.', ',') : '';
  $('c-close').value = c && c.closingDay ? c.closingDay : '';
  $('c-pay').innerHTML = `<option value="">Sin asociar</option>` + S.accounts.filter((a) => a.type === 'bank' || a.type === 'cash')
    .map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  $('c-pay').value = c && account(c.payFrom) ? c.payFrom : (S.accounts.find((a) => a.type === 'bank')?.id || '');
  $('c-delete-group').hidden = !c;
  $('csheet').showModal();
  if (!c) setTimeout(() => $('c-name').focus(), 120);
}
function saveCard() {
  const name = $('c-name').value.trim(), limit = parseAmount($('c-limit').value);
  const closing = parseInt($('c-close').value, 10);
  if (!name) return toast('Poné un nombre, por ejemplo "Visa BROU"');
  if (!(limit > 0)) return toast('Ingresá el límite de crédito');
  const prev = card(S.editingCardId);
  upsertCard({ id: S.editingCardId || uid(), name, limit: r2(limit), closingDay: closing >= 1 && closing <= 31 ? closing : '',
    payFrom: $('c-pay').value, since: prev?.since || new Date().toISOString() });
  $('csheet').close();
  toast('Tarjeta guardada');
}

// ---------- Hoja de cuenta ----------
const numStr = (n) => (n || n === 0 ? String(n).replace('.', ',') : '');
function openAccount(id = null) {
  const a = id ? account(id) : null;
  S.editingAccountId = a ? a.id : null;
  $('a-title').textContent = a ? a.name : 'Nueva cuenta';
  $('a-name').value = a ? a.name : '';
  $('a-type').value = a ? a.type : 'bank';
  $('a-cur-row').hidden = !usdMode();
  $('a-cur').value = a ? (accUSD(a) ? USD : '') : '';
  $('a-cur').disabled = !!a;
  $('a-cur').options[0].textContent = S.cfg.currency;
  $('a-balance').value = a ? numStr(accountBalance(a)) : '';
  $('a-goal').value = a && a.goal ? numStr(a.goal) : '';
  $('a-goal-date').value = a && a.goalDate ? a.goalDate : '';
  $('a-delete-group').hidden = !a || a.id === CASH;
  $('a-actions').hidden = !a;
  const today = isoDate(new Date());
  const moves = a ? [
    ...S.expenses.filter((e) => e.method === a.id && e.date <= today).map((e) => ({ ...e, value: baseAmount(e), n: 1, k: 0 })),
    ...S.transfers.filter((t) => t.from === a.id || t.to === a.id).map((t) => ({ ...t, isTransfer: true })),
  ].sort(sortDesc).slice(0, 8) : [];
  $('a-moves').innerHTML = moves.length ? `<div class="section-h"><span>Últimos movimientos</span></div>
    <div class="group">${moves.map((x) => x.isTransfer ? transferRow(x) : entryRow(x)).join('')}</div>` : '';
  updateAccountForm();
  $('asheet').showModal();
  if (!a) setTimeout(() => $('a-name').focus(), 120);
}
function updateAccountForm() {
  const t = $('a-type').value, a = account(S.editingAccountId);
  $('a-goal-group').hidden = !(t === 'savings' || t === 'invest');
  $('a-balance-label').textContent = t === 'invest' ? 'Valor actual' : 'Saldo actual';
  $('a-hint').textContent = a ? (t === 'invest' ? 'Si cambiás el valor, se registra la ganancia o pérdida sin tocar tu balance del mes.'
    : 'Si cambiás el saldo, se registra un ajuste por la diferencia.') : 'Desde ahora, el saldo se mueve solo con cada gasto, ingreso o transferencia.';
}
function saveAccount() {
  const name = $('a-name').value.trim(), type = $('a-type').value;
  const bal = parseAmount($('a-balance').value);
  if (!name) return toast('Poné un nombre, por ejemplo "BROU caja de ahorro"');
  const goal = parseAmount($('a-goal').value);
  const extra = { goal: (type === 'savings' || type === 'invest') && goal > 0 ? r2(goal) : '', goalDate: (type === 'savings' || type === 'invest') ? $('a-goal-date').value : '' };
  const a = account(S.editingAccountId);
  if (a) {
    const cur = accountBalance(a);
    upsertAccount({ ...a, name, type, ...extra });
    if (!isNaN(bal) && r2(bal) !== cur) {
      upsertTransfer({ id: uid(), kind: 'adjust', from: '', to: a.id, amount: 0, toAmount: r2(bal - cur), cur: '', rate: '', date: isoDate(new Date()), note: '' });
    }
    if (a.id === CASH) S.cfg.setupPending = false;
  } else {
    upsertAccount({ id: uid(), name, type, currency: usdMode() ? $('a-cur').value : '', initial: isNaN(bal) ? 0 : r2(bal), since: new Date().toISOString(), ...extra });
  }
  persist();
  $('asheet').close(); render();
  toast(a ? 'Cuenta actualizada' : 'Cuenta creada');
}
function openAdjust(id) {
  const t = S.transfers.find((x) => x.id === id);
  if (!t) return;
  if (confirm(`${transferTitle(t)}: ${t.toAmount < 0 ? '-' : '+'}${fmtCur(Math.abs(t.toAmount), accCur(account(t.to)))}.\n¿Eliminar este ajuste?`)) { deleteTransfer(id); toast('Ajuste eliminado'); }
}

// ---------- Hoja de transferencia ----------
function accOptions(sel) {
  return S.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}${accUSD(a) ? ' (US$)' : ''}</option>`).join('');
}
function openTransfer(id = null, fromId = null) {
  if (S.accounts.length < 2) return toast('Agregá otra cuenta para transferir');
  const t = id ? S.transfers.find((x) => x.id === id) : null;
  S.editingTransferId = t ? t.id : null;
  const from = t ? t.from : fromId || (S.accounts.find((a) => a.type === 'bank') || S.accounts[0]).id;
  const to = t ? t.to : (S.accounts.find((a) => a.id !== from && a.type === 'cash') || S.accounts.find((a) => a.id !== from)).id;
  $('t-title').textContent = t ? 'Editar transferencia' : 'Transferir';
  $('t-from').innerHTML = accOptions(from);
  $('t-to').innerHTML = accOptions(to);
  $('t-amount').value = t ? numStr(t.amount) : '';
  $('t-rate').value = t && t.rate ? numStr(t.rate) : numStr(S.cfg.usdRate);
  $('t-date').value = t ? t.date : isoDate(new Date());
  $('t-note').value = t ? t.note || '' : '';
  $('t-delete-group').hidden = !t;
  updateTransfer();
  $('tsheet').showModal();
  if (!t) setTimeout(() => $('t-amount').focus(), 120);
}
function updateTransfer() {
  const fa = account($('t-from').value), ta = account($('t-to').value);
  const fc = accCur(fa), tc = accCur(ta), diff = fc !== tc;
  $('t-cur').textContent = fc === USD ? 'US$' : (money.formatToParts(0).find((p) => p.type === 'currency')?.value || '$');
  $('t-rate-group').hidden = !diff;
  const amt = parseAmount($('t-amount').value), rate = parseAmount($('t-rate').value);
  const show = diff && amt > 0 && rate > 0;
  $('t-hint').hidden = !show;
  if (show) $('t-hint').textContent = `Entran ${fmtCur(r2(conv(amt, fc, tc, rate)), tc)} en ${ta.name}.`;
}
function saveTransfer() {
  const from = $('t-from').value, to = $('t-to').value;
  if (from === to) return toast('Elegí dos cuentas distintas');
  const amt = parseAmount($('t-amount').value);
  if (!(amt > 0)) { $('t-amount').focus(); return toast('Ingresá un monto válido'); }
  const fc = accCur(account(from)), tc = accCur(account(to));
  const rate = fc !== tc ? parseAmount($('t-rate').value) : 0;
  if (fc !== tc && !(rate > 0)) return toast('Ingresá la cotización');
  const prev = S.transfers.find((x) => x.id === S.editingTransferId);
  upsertTransfer({ ...(prev || {}), id: S.editingTransferId || uid(), kind: 'transfer', from, to, amount: r2(amt),
    toAmount: r2(conv(amt, fc, tc, rate || 1)), cur: '', rate: rate ? r2(rate) : '', date: $('t-date').value || isoDate(new Date()), note: $('t-note').value.trim() });
  $('tsheet').close(); render();
  toast(S.editingTransferId ? 'Transferencia actualizada' : 'Transferencia guardada');
}

// ---------- Hoja de pago de resumen ----------
function openPay(cardId, id = null) {
  const c = card(cardId);
  if (!c) return;
  if (!S.accounts.length) return toast('Agregá una cuenta primero');
  const t = id ? S.transfers.find((x) => x.id === id) : null;
  S.payCard = c.id; S.editingTransferId = t ? t.id : null;
  const st = cardStats(c);
  S.payCur = t ? (t.cur === USD ? USD : '') : (st.debt[''] <= 0 && st.debt.USD > 0 ? USD : '');
  S.payMode = t ? 'other' : 'total';
  $('p-title').textContent = 'Pagar ' + c.name;
  $('p-cur').hidden = !usdMode() || !(st.hasUSD || (t && t.cur === USD));
  $('p-from').innerHTML = accOptions(t ? t.from : account(c.payFrom) ? c.payFrom : (S.accounts.find((a) => a.type === 'bank') || S.accounts[0]).id);
  $('p-amount').value = t ? numStr(t.toAmount) : '';
  $('p-rate').value = t && t.rate ? numStr(t.rate) : numStr(S.cfg.usdRate);
  $('p-date').value = t ? t.date : isoDate(new Date());
  $('p-delete-group').hidden = !t;
  updatePay(true);
  $('psheet').showModal();
}
function updatePay(reset = false) {
  const c = card(S.payCard), st = cardStats(c), owed = Math.max(st.debt[S.payCur], 0);
  const editing = S.transfers.find((x) => x.id === S.editingTransferId);
  const owedShown = editing ? owed + Number(editing.toAmount || 0) * ((editing.cur === USD ? USD : '') === S.payCur ? 1 : 0) : owed;
  document.querySelectorAll('#p-cur button').forEach((b) => b.classList.toggle('on', b.dataset.cur === S.payCur));
  document.querySelectorAll('#p-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.payMode));
  $('p-owed').textContent = `Saldo a pagar: ${fmtCur(owedShown, S.payCur)}`;
  $('p-sym').textContent = S.payCur === USD ? 'US$' : (money.formatToParts(0).find((p) => p.type === 'currency')?.value || '$');
  if (reset) {
    if (S.payMode === 'total') $('p-amount').value = numStr(r2(owedShown));
    else if (!editing) $('p-amount').value = '';
    $('p-amount').readOnly = S.payMode === 'total';
    $('p-amount').placeholder = S.payMode === 'min' ? 'Mínimo del resumen' : '0';
  }
  const fa = account($('p-from').value), fc = accCur(fa), diff = fc !== S.payCur;
  $('p-rate-group').hidden = !diff;
  const amt = parseAmount($('p-amount').value), rate = parseAmount($('p-rate').value);
  const ok = amt > 0 && (!diff || rate > 0);
  $('p-hint').hidden = !ok;
  if (ok) {
    const rest = r2(owedShown - amt);
    $('p-hint').textContent = `Se descuentan ${fmtCur(r2(conv(amt, S.payCur, fc, rate || 1)), fc)} de ${fa.name}.` +
      (rest > 0 ? ` Quedan ${fmtCur(rest, S.payCur)} pendientes en la tarjeta.` : '');
  }
}
function savePay() {
  const amt = parseAmount($('p-amount').value);
  if (!(amt > 0)) { $('p-amount').focus(); return toast(S.payMode === 'min' ? 'Ingresá el pago mínimo del resumen' : 'Ingresá el monto a pagar'); }
  const from = $('p-from').value, fc = accCur(account(from)), diff = fc !== S.payCur;
  const rate = diff ? parseAmount($('p-rate').value) : 0;
  if (diff && !(rate > 0)) return toast('Ingresá la cotización');
  const prev = S.transfers.find((x) => x.id === S.editingTransferId);
  upsertTransfer({ ...(prev || {}), id: S.editingTransferId || uid(), kind: 'payment', from, to: S.payCard, cur: S.payCur, toAmount: r2(amt),
    amount: r2(conv(amt, S.payCur, fc, rate || 1)), rate: rate ? r2(rate) : '', date: $('p-date').value || isoDate(new Date()), note: '' });
  $('psheet').close(); render();
  toast('Pago registrado');
}

function exportCSV() {
  const rows = [['id', 'tipo', 'fecha', `monto ${S.cfg.currency}`, 'categoria', 'nota', 'medio', 'cuotas', 'moneda original', 'monto original', 'cotizacion']]
    .concat([...S.expenses].sort(sortDesc).map((e) => [e.id, isIncome(e) ? 'ingreso' : 'gasto', e.date, baseAmount(e), e.category, e.note || '',
      card(e.method)?.name || account(e.method)?.name || 'Efectivo', nInst(e),
      isUSD(e) ? USD : S.cfg.currency, e.amount, isUSD(e) ? rateOf(e) : '']));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `movimientos-${isoDate(new Date())}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Eventos ----------
document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('[data-tab]');
  if (tab) return show(tab.dataset.tab);
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const actions = {
    'prev-month': () => { S.offset--; render(); },
    'next-month': () => { if (S.offset < 12) { S.offset++; render(); } },
    'new-expense': () => openExpense(),
    'new-fixed': () => openExpense(null, true),
    'edit-expense': () => openExpense(el.dataset.id),
    'close-sheet': () => $('sheet').close(),
    'set-type': () => { S.selType = el.dataset.type; applyType(); },
    'set-cur': () => { S.selCur = el.dataset.cur; if (S.selCur === USD && !$('f-rate').value && S.cfg.usdRate) $('f-rate').value = String(S.cfg.usdRate).replace('.', ','); updateRec(); },
    'refresh-rate': () => fetchRate(true),
    'pick-cat': () => { S.selCat = el.dataset.cat; renderCatGrid(); },
    'pick-from': () => {
      S.selMethod = el.dataset.id;
      const a = account(S.selMethod);
      if (a && !S.editingId) S.selCur = accCur(a);
      renderFrom(); updateRec();
    },
    'new-account': () => openAccount(),
    'edit-account': () => openAccount(el.dataset.id),
    'close-asheet': () => $('asheet').close(),
    'save-account': saveAccount,
    'delete-account': () => {
      const id = S.editingAccountId;
      const used = [...S.expenses, ...S.recurring].some((e) => e.method === id) || S.transfers.some((t) => t.from === id || t.to === id);
      if (!confirm(used ? '¿Eliminar esta cuenta? Sus gastos e ingresos pasan a Efectivo y se borran sus transferencias.' : '¿Eliminar esta cuenta?')) return;
      S.expenses.filter((e) => e.method === id).forEach((e) => upsertExpense({ ...e, method: CASH }));
      S.recurring.filter((r) => r.method === id).forEach((r) => upsertRecurring({ ...r, method: CASH }));
      S.transfers.filter((t) => t.from === id || t.to === id).forEach((t) => deleteTransfer(t.id));
      S.cards.filter((c) => c.payFrom === id).forEach((c) => upsertCard({ ...c, payFrom: '' }));
      deleteAccount(id); $('asheet').close(); toast('Cuenta eliminada');
    },
    'account-transfer': () => { $('asheet').close(); openTransfer(null, S.editingAccountId); },
    'new-transfer': () => openTransfer(),
    'edit-transfer': () => {
      const t = S.transfers.find((x) => x.id === el.dataset.id);
      if (!t) return;
      if (t.kind === 'payment') openPay(t.to, t.id);
      else if (t.kind === 'adjust') openAdjust(t.id);
      else openTransfer(t.id);
    },
    'close-tsheet': () => $('tsheet').close(),
    'save-transfer': saveTransfer,
    'delete-transfer': () => { if (confirm('¿Eliminar este movimiento?')) { deleteTransfer(S.editingTransferId); $('tsheet').close(); $('psheet').close(); toast('Eliminado'); } },
    'pay-card': () => openPay(el.dataset.id),
    'close-psheet': () => $('psheet').close(),
    'pay-cur': () => { S.payCur = el.dataset.cur; updatePay(true); },
    'pay-mode': () => { S.payMode = el.dataset.mode; updatePay(true); },
    'save-pay': savePay,
    'setup-done': () => { S.cfg.setupPending = false; persist(); render(); },
    'save-expense': saveExpense,
    'delete-expense': () => {
      if (S.editingRule) {
        if (confirm('¿Eliminar este fijo? Desaparece de todos los meses. Para que deje de correr desde ahora, mejor poné un último mes.')) { deleteRecurring(S.editingId); $('sheet').close(); toast('Fijo eliminado'); }
      } else if (confirm('¿Eliminar este movimiento? Si es en cuotas, se eliminan todas.')) { deleteExpense(S.editingId); $('sheet').close(); toast('Eliminado'); }
    },
    'filter': () => { S.catFilter = el.dataset.cat; render(); },
    'edit-budget': () => openBudget(el.dataset.cat),
    'close-bsheet': () => $('bsheet').close(),
    'save-budget': () => {
      const v = parseAmount($('b-amount').value);
      setBudget(S.budgetCat, v > 0 ? r2(v) : 0); $('bsheet').close();
    },
    'clear-budget': () => { setBudget(S.budgetCat, 0); $('bsheet').close(); },
    'new-card': () => openCard(),
    'edit-card': () => openCard(el.dataset.id),
    'close-csheet': () => $('csheet').close(),
    'save-card': saveCard,
    'delete-card': () => {
      const used = [...S.expenses, ...S.recurring].some((e) => e.method === S.editingCardId);
      if (confirm(used ? 'Esta tarjeta tiene compras registradas. ¿Eliminarla igual? Las compras quedan como efectivo.' : '¿Eliminar esta tarjeta?')) {
        S.expenses.filter((e) => e.method === S.editingCardId).forEach((e) => upsertExpense({ ...e, method: CASH, installments: 1 }));
        S.recurring.filter((r) => r.method === S.editingCardId).forEach((r) => upsertRecurring({ ...r, method: CASH }));
        deleteCard(S.editingCardId); $('csheet').close();
      }
    },
    'connect': connect,
    'sync-now': () => sync(true),
    'disconnect': () => {
      if (confirm('¿Desconectar la hoja? Tus datos quedan en Google Sheets y en este teléfono.')) {
        S.cfg.url = ''; S.cfg.token = ''; S.queue = []; S.syncError = null; persist(); render();
      }
    },
    'export': exportCSV,
    'backup': backup,
    'restore': restore,
    'create-sheet': () => {
      if (!TEMPLATE_URL) return toast('La plantilla todavía no está disponible. Usá la configuración avanzada.');
      window.open(TEMPLATE_URL, '_blank');
    },
    'paste-code': () => {
      const code = prompt('Pegá el código que te mostró la hoja (Mis Gastos → Conectar celular):');
      if (!code) return;
      const c = decodeCode(code);
      if (!c) return toast('Ese código no es válido');
      connectWith(c.url, c.token).then(() => { if (connected()) toast('¡Listo! Tu app quedó conectada a tu hoja'); });
    },
    'wipe': () => {
      if (confirm('¿Borrar todos los datos de este dispositivo?')) {
        S.expenses = []; S.budgets = {}; S.cards = []; S.recurring = []; S.transfers = []; S.accounts = null; S.queue = [];
        ensureCash(); persist(); render();
        if (connected()) sync(true);
      }
    },
  };
  actions[el.dataset.action]?.();
});
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'search') {
    S.query = ev.target.value;
    const pos = ev.target.selectionStart;
    renderList();
    const s = $('search'); s.focus(); s.setSelectionRange(pos, pos);
  }
  if (ev.target.id === 'f-amount' || ev.target.id === 'f-rate') updateRec();
  if (['t-amount', 't-rate'].includes(ev.target.id)) updateTransfer();
  if (['p-amount', 'p-rate'].includes(ev.target.id)) updatePay();
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'cfg-currency') { S.cfg.currency = ev.target.value; S.cfg.usdRate = 0; S.cfg.rateDate = ''; persist(); setMoney(); render(); fetchRate(); }
  if (ev.target.id === 'cfg-rate') {
    const r = parseAmount(ev.target.value);
    if (r > 0) { S.cfg.usdRate = r2(r); S.cfg.rateManual = true; S.cfg.rateDate = new Date().toISOString(); persist(); render(); toast('Cotización guardada'); }
  }
  if (ev.target.id === 'f-inst') updateInstHint();
  if (['t-from', 't-to'].includes(ev.target.id)) updateTransfer(true);
  if (ev.target.id === 'p-from') updatePay();
  if (ev.target.id === 'a-type') updateAccountForm();
  if (['f-rec', 'f-end-mode', 'f-end', 'f-date'].includes(ev.target.id)) updateRec();
});
['sheet', 'bsheet', 'csheet', 'asheet', 'tsheet', 'psheet'].forEach((id) => $(id).addEventListener('click', (ev) => { if (ev.target.id === id) ev.target.close(); }));
$('f-amount').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveExpense(); });

window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));

// ---------- Migración a cuentas (v6) ----------
function ensureCash() {
  if (!Array.isArray(S.accounts)) S.accounts = [];
  if (!account(CASH)) S.accounts.unshift({ id: CASH, name: 'Efectivo', type: 'cash', currency: '', initial: 0, since: new Date().toISOString() });
}
if (!Array.isArray(S.accounts)) {
  ensureCash();
  const now = new Date().toISOString();
  S.cards.forEach((c) => { if (!c.since) { c.since = now; if (connected()) S.queue.push({ type: 'card', card: c }); } });
  if (connected()) S.queue.push({ type: 'account', account: S.accounts[0] });
  S.cfg.setupPending = true;
  persist();
}
ensureCash();

setMoney();
show('home');
connectFromHash();
window.addEventListener('hashchange', connectFromHash);
sync();
if (rateStale()) fetchRate();
