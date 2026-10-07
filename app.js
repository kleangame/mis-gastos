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
const CASH = 'cash';

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
  queue:    store.get('mg.queue', []),
  cfg:      store.get('mg.cfg', { url: '', token: '', currency: 'UYU' }),
  lastSync: store.get('mg.lastSync', null),
  syncError: null, syncing: false,
  view: 'home', offset: 0, query: '', catFilter: 'Todas',
  editingId: null, selCat: CATS[0].name, selType: 'expense', budgetCat: null, editingCardId: null,
};
function persist() {
  store.set('mg.expenses', S.expenses); store.set('mg.budgets', S.budgets); store.set('mg.cards', S.cards); store.set('mg.recurring', S.recurring);
  store.set('mg.queue', S.queue); store.set('mg.cfg', S.cfg); store.set('mg.lastSync', S.lastSync);
}
const connected = () => !!(S.cfg.url && S.cfg.token);

// ---------- Utilidades ----------
const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const ALL_CATS = [...CATS, ...INCOME_CATS];
const cat = (name) => ALL_CATS.find((c) => c.name === name) || CATS[CATS.length - 1];
const card = (id) => S.cards.find((c) => c.id === id);
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
const nInst = (e) => (!isIncome(e) && e.method && e.method !== CASH ? Math.max(1, Number(e.installments) || 1) : 1);

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
function installmentAmount(e, k) {
  const n = nInst(e), base = r2(Number(e.amount) / n);
  return k === n - 1 ? r2(Number(e.amount) - base * (n - 1)) : base;
}
// Lo que impacta en un mes: cada cuota es una entrada virtual que apunta al movimiento original.
function entriesForMonth(key) {
  const out = [];
  for (const e of S.expenses) {
    const n = nInst(e);
    if (n === 1 && !(e.method && e.method !== CASH && !isIncome(e))) {
      if (monthKey(parseLocal(e.date)) === key) out.push({ ...e, src: e, k: 0, n: 1, value: Number(e.amount) });
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
    if (ruleActive(r, key)) out.push({ ...r, src: r, fixed: true, k: 0, n: 1, value: Number(r.amount), date: ruleDate(r, key), updated: '' });
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
// Deuda pendiente de una tarjeta: cuotas del mes actual en adelante.
function cardStats(c) {
  const now = nowKey();
  let outstanding = 0, thisMonth = 0;
  const plans = [], future = Array(6).fill(0);
  for (const e of S.expenses) {
    if (isIncome(e) || e.method !== c.id) continue;
    const n = nInst(e), first = firstInstallmentKey(e);
    let rem = 0, remCount = 0;
    for (let k = 0; k < n; k++) {
      const key = first + k, v = installmentAmount(e, k);
      if (key >= now) { rem += v; remCount++; }
      if (key === now) thisMonth += v;
      if (key >= now && key < now + 6) future[key - now] += v;
    }
    outstanding += rem;
    if (remCount > 0) {
      const current = Math.min(Math.max(now - first + 1, 0), n);
      plans.push({ e, n, current, rem, cuota: installmentAmount(e, 0), startsLater: first > now });
    }
  }
  for (const r of S.recurring) {
    if (isIncome(r) || r.method !== c.id) continue;
    const v = Number(r.amount);
    if (ruleActive(r, now)) { outstanding += v; thisMonth += v; }
    for (let i = 0; i < 6; i++) if (ruleActive(r, now + i)) future[i] += v;
    if (ruleActive(r, now) || ymKey(r.start) > now) plans.push({ e: r, fixed: true, rem: ruleActive(r, now) ? v : 0, cuota: v });
  }
  plans.sort((a, b) => b.rem - a.rem);
  const limit = Number(c.limit) || 0;
  return { outstanding: r2(outstanding), thisMonth: r2(thisMonth), plans, future, limit, util: limit ? outstanding / limit : 0, available: r2(limit - outstanding) };
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
  const cd = !inc && x.method && x.method !== CASH ? card(x.method) : null;
  const sub = [x.fixed ? 'Fijo' : null, x.note ? x.category : null, cd ? cd.name : null, x.n > 1 ? `cuota ${x.k + 1}/${x.n}` : null].filter(Boolean).join(' · ') || dayLabel(x.date);
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
  const onCard = sumV(exp.filter((e) => e.method && e.method !== CASH));
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
  const filters = ['Todas', 'Ingresos', 'Fijos', 'Tarjeta', ...CATS.map((c) => c.name)];
  const items = monthEntries(S.offset)
    .filter((e) => S.catFilter === 'Todas'
      || (S.catFilter === 'Ingresos' && isIncome(e))
      || (S.catFilter === 'Fijos' && e.fixed)
      || (S.catFilter === 'Tarjeta' && !isIncome(e) && e.method && e.method !== CASH)
      || e.category === S.catFilter)
    .filter((e) => !q || (e.note || '').toLowerCase().includes(q) || e.category.toLowerCase().includes(q))
    .sort(sortDesc);
  const groups = {};
  items.forEach((e) => (groups[e.date] = groups[e.date] || []).push(e));
  const net = (list) => sumV(incomesOf(list)) - sumV(expensesOf(list));
  $('view-list').innerHTML = `
    ${header('Movimientos')}
    ${monthPicker()}
    <label class="search">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 109.5 16a6.5 6.5 0 004.2-1.6l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 110-9 4.5 4.5 0 010 9z"/></svg>
      <input id="search" type="search" placeholder="Buscar" value="${esc(S.query)}">
    </label>
    <div class="chips">${filters.map((n) => {
      const lbl = n === 'Todas' ? n : n === 'Ingresos' ? '💰 Ingresos' : n === 'Tarjeta' ? '💳 Tarjeta' : n === 'Fijos' ? '📌 Fijos' : cat(n).emoji + ' ' + n;
      return `<button class="chip ${S.catFilter === n ? 'on' : ''}" data-action="filter" data-cat="${n}">${lbl}</button>`;
    }).join('')}</div>
    ${items.length ? Object.entries(groups).map(([date, list]) => {
      const n = net(list);
      return `<div class="section-h"><span>${dayLabel(date)}</span><span>${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n))}</span></div>
      <div class="group">${list.map(entryRow).join('')}</div>`;
    }).join('')
      : `<div class="empty"><b>Nada por acá</b>${q || S.catFilter !== 'Todas' ? 'Probá con otra búsqueda o filtro.' : 'Todavía no hay movimientos este mes.'}</div>`}
  `;
}

function renderCards() {
  const stats = S.cards.map((c) => ({ c, s: cardStats(c) }));
  const totLimit = stats.reduce((a, x) => a + x.s.limit, 0);
  const totOut = stats.reduce((a, x) => a + x.s.outstanding, 0);
  const totMonth = stats.reduce((a, x) => a + x.s.thisMonth, 0);
  const future = Array(6).fill(0); stats.forEach((x) => x.s.future.forEach((v, i) => (future[i] += v)));
  const maxF = Math.max(...future, 1);
  const util = totLimit ? totOut / totLimit : 0;
  $('view-cards').innerHTML = `
    ${header('Tarjetas', 'new-card')}
    ${!S.cards.length ? `<div class="empty"><b>Sin tarjetas</b>Agregá tu tarjeta con su límite para medir la utilización y las cuotas.</div>
      <button class="btn" data-action="new-card">Agregar tarjeta</button>` : `
    <div class="card hero">
      <small>Utilización total del crédito</small>
      <div class="big">${Math.round(util * 100)}%</div>
      <div class="progress ${utilClass(util)}"><i style="width:${Math.min(util, 1) * 100}%"></i></div>
      <div class="meta"><span>Deuda ${fmt(totOut)}</span><span>Límite ${fmt(totLimit)}</span></div>
      <div class="split">
        <div><small>A pagar este mes</small><b>${fmt(totMonth)}</b></div>
        <div><small>Disponible</small><b>${fmt(totLimit - totOut)}</b></div>
      </div>
    </div>
    ${stats.map(({ c, s }) => `
      <button class="ccard" style="background:${cardColor(c)}" data-action="edit-card" data-id="${esc(c.id)}">
        <div class="cname"><span>${esc(c.name)}</span><span>${Math.round(s.util * 100)}%</span></div>
        <div class="chip-ic"></div>
        <small>Disponible</small>
        <div class="avail">${fmt(s.available)}</div>
        <div class="progress ${utilClass(s.util)}"><i style="width:${Math.min(s.util, 1) * 100}%"></i></div>
        <div class="meta"><span>Usado ${fmt(s.outstanding)} de ${fmt(s.limit)}</span><span>${c.closingDay ? 'Cierra el ' + c.closingDay : ''}</span></div>
      </button>
      ${s.plans.length ? `
        <div class="section-h"><span>Cuotas · ${esc(c.name)}</span><span>${fmt(s.thisMonth)} este mes</span></div>
        <div class="group">${s.plans.map((p) => `
          <button class="row with-icon" data-action="edit-expense" data-id="${esc(p.e.id)}">
            ${icon(cat(p.e.category))}
            <span class="ri"><b>${esc(p.e.note || p.e.category)}</b>
              <small>${p.fixed ? `Fijo · ${fmt(p.cuota)}/mes · ${p.e.end ? 'hasta ' + ymLabel(p.e.end) : 'sin fin'}` : p.n > 1 ? (p.startsLater ? `Empieza el mes que viene · ${p.n} cuotas` : `Cuota ${p.current} de ${p.n}`) + ` · ${fmt(p.cuota)}/mes` : 'Un pago'}</small></span>
            <span class="amt">${fmt(p.rem)}</span>
          </button>`).join('')}
        </div>
        <p class="footer-note">A la derecha, lo que resta pagar de cada compra.</p>` : ''}
    `).join('')}
    <div class="section-h"><span>Próximos 6 meses</span></div>
    <div class="card">
      <div class="months">${future.map((v, i) => `
        <div><b>${v ? compact(v) : ''}</b><i style="height:${(v / maxF) * 80}px"></i><span>${keyLabel(nowKey() + i, true)}</span></div>`).join('')}
      </div>
    </div>
    <p class="footer-note">Cuánto vas a pagar de tarjeta cada mes por las cuotas ya registradas.</p>`}
  `;
}

function fixedSection() {
  const key = nowKey() + S.offset;
  const rules = [...S.recurring].sort((a, b) => (isIncome(a) - isIncome(b)) || b.amount - a.amount);
  const net = rules.filter((r) => ruleActive(r, key)).reduce((s, r) => s + (isIncome(r) ? 1 : -1) * Number(r.amount), 0);
  return `<div class="section-h"><span>Fijos mensuales</span><button data-action="new-fixed">Agregar</button></div>
    ${rules.length ? `<div class="group">${rules.map((r) => {
      const on = ruleActive(r, key), cd = r.method && r.method !== CASH ? card(r.method) : null;
      return `<button class="row with-icon" data-action="edit-expense" data-id="${esc(r.id)}" style="${on ? '' : 'opacity:.5'}">
        ${icon(cat(r.category))}
        <span class="ri"><b>${esc(r.note || r.category)}</b><small>${esc(ruleRange(r))}${cd ? ' · ' + esc(cd.name) : ''} · día ${r.day}</small></span>
        <span class="amt ${isIncome(r) ? 'income' : ''}">${isIncome(r) ? '+' : '-'}${fmt(r.amount)}</span>
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
      <label class="row"><span>URL del script</span><input id="cfg-url" type="url" placeholder="https://script.google.com/…" value="${esc(S.cfg.url)}" ${connected() ? 'readonly' : ''}></label>
      <label class="row"><span>Clave</span><input id="cfg-token" type="password" placeholder="Tu clave secreta" value="${esc(S.cfg.token)}" ${connected() ? 'readonly' : ''}></label>
    </div>
    ${connected()
      ? `<button class="btn" data-action="sync-now" ${S.syncing ? 'disabled' : ''}>Sincronizar ahora</button>
         <div class="group"><button class="row danger center" data-action="disconnect">Desconectar hoja</button></div>`
      : `<button class="btn" data-action="connect">Conectar hoja</button>
         <p class="footer-note">Cada movimiento se guarda como una fila en tu Google Sheet. Las instrucciones están en LEEME.md.</p>`}
    <div class="section-h"><span>General</span></div>
    <div class="group">
      <label class="row"><span>Moneda</span>
        <select id="cfg-currency">${CURRENCIES.map((c) => `<option ${c === S.cfg.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
    </div>
    <div class="section-h"><span>Datos</span></div>
    <div class="group">
      <button class="row blue" data-action="export">Exportar CSV<span></span></button>
      <button class="row danger" data-action="wipe">Borrar datos de este dispositivo</button>
    </div>
    <p class="footer-note">${S.expenses.length} movimientos, ${S.recurring.length} fijos y ${S.cards.length} tarjetas guardados. Borrar los datos locales no toca tu Google Sheet.</p>
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
    if (!S.queue.length) { S.expenses = data.expenses; S.budgets = data.budgets; S.cards = data.cards || []; S.recurring = data.recurring || []; }
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
async function connect() {
  const url = $('cfg-url').value.trim(), token = $('cfg-token').value.trim();
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) return toast('Pegá la URL de la app web de Apps Script');
  if (!token) return toast('Ingresá la clave que pusiste en el script');
  S.cfg.url = url; S.cfg.token = token;
  // Sube lo que ya había en el teléfono (el servidor evita duplicados por id).
  S.queue = [
    ...S.cards.map((c) => ({ type: 'card', card: c })),
    ...S.recurring.map((r) => ({ type: 'recurring', rule: r })),
    ...S.expenses.map((e) => ({ type: 'upsert', expense: e })),
    ...Object.entries(S.budgets).map(([category, amount]) => ({ type: 'budget', category, amount })),
  ];
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
  $('f-date').value = rule ? ruleDate(rule, ymKey(rule.start)) : e ? e.date : isoDate(new Date());
  $('f-rec').checked = rule ? true : fixed;
  $('f-end-mode').value = rule && rule.end ? 'date' : '';
  $('f-end').value = rule && rule.end ? rule.end : '';
  $('f-note').value = e ? e.note || '' : '';
  $('f-method').innerHTML = `<option value="${CASH}">Efectivo / débito</option>` +
    S.cards.map((c) => `<option value="${esc(c.id)}">💳 ${esc(c.name)}</option>`).join('');
  $('f-method').value = e && e.method && card(e.method) ? e.method : (S.view === 'cards' && S.cards[0] ? S.cards[0].id : CASH);
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
  $('f-pay-group').hidden = inc;
  renderCatGrid(); updateInstHint(); updateRec();
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
  const amount = parseAmount($('f-amount').value);
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
  updateInstHint();
}
function updateInstHint() {
  const isCard = S.selType === 'expense' && $('f-method').value !== CASH && !$('f-rec').checked;
  $('f-inst-row').hidden = !isCard;
  const n = Number($('f-inst').value) || 1, amount = parseAmount($('f-amount').value);
  const show = isCard && n > 1 && amount > 0;
  $('f-inst-hint').hidden = !show;
  if (show) $('f-inst-hint').textContent = `${n} cuotas de ${fmt(r2(amount / n))}. Se reparten mes a mes en tu balance y en la tarjeta.`;
}
function saveExpense() {
  const amount = parseAmount($('f-amount').value);
  if (!(amount > 0)) { $('f-amount').focus(); return toast('Ingresá un monto válido'); }
  const date = $('f-date').value || isoDate(new Date());
  const inc = S.selType === 'income';
  const method = inc ? CASH : $('f-method').value;
  const installments = method === CASH ? 1 : Number($('f-inst').value) || 1;
  const wasEditing = !!S.editingId;
  if ($('f-rec').checked) {
    const d = parseLocal(date);
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const end = $('f-end-mode').value === 'date' ? $('f-end').value : '';
    if (end && ymKey(end) < ymKey(start)) return toast('El último mes no puede ser anterior al primero');
    if (S.editingId && !S.editingRule) deleteExpense(S.editingId);   // un gasto común pasó a fijo
    upsertRecurring({ id: S.editingRule ? S.editingId : uid(), type: S.selType, amount: r2(amount), category: S.selCat,
      note: $('f-note').value.trim(), method, day: d.getDate(), start, end });
    $('sheet').close(); render();
    return toast(wasEditing ? 'Fijo actualizado' : 'Fijo mensual guardado');
  }
  if (S.editingRule) deleteRecurring(S.editingId);   // un fijo pasó a gasto común
  upsertExpense({ id: S.editingId || uid(), type: S.selType, amount: r2(amount), category: S.selCat, date,
    note: $('f-note').value.trim(), method, installments });
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
  $('c-delete-group').hidden = !c;
  $('csheet').showModal();
  if (!c) setTimeout(() => $('c-name').focus(), 120);
}
function saveCard() {
  const name = $('c-name').value.trim(), limit = parseAmount($('c-limit').value);
  const closing = parseInt($('c-close').value, 10);
  if (!name) return toast('Poné un nombre, por ejemplo "Visa BROU"');
  if (!(limit > 0)) return toast('Ingresá el límite de crédito');
  upsertCard({ id: S.editingCardId || uid(), name, limit: r2(limit), closingDay: closing >= 1 && closing <= 31 ? closing : '' });
  $('csheet').close();
  toast('Tarjeta guardada');
}

function exportCSV() {
  const rows = [['id', 'tipo', 'fecha', 'monto', 'categoria', 'nota', 'medio', 'cuotas']]
    .concat([...S.expenses].sort(sortDesc).map((e) => [e.id, isIncome(e) ? 'ingreso' : 'gasto', e.date, e.amount, e.category, e.note || '',
      e.method && e.method !== CASH ? (card(e.method)?.name || 'tarjeta') : 'efectivo', nInst(e)]));
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
    'pick-cat': () => { S.selCat = el.dataset.cat; renderCatGrid(); },
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
    'wipe': () => {
      if (confirm('¿Borrar todos los datos de este dispositivo?')) {
        S.expenses = []; S.budgets = {}; S.cards = []; S.recurring = []; S.queue = []; persist(); render();
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
  if (ev.target.id === 'f-amount') updateRec();
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'cfg-currency') { S.cfg.currency = ev.target.value; persist(); setMoney(); }
  if (ev.target.id === 'f-method' || ev.target.id === 'f-inst') updateInstHint();
  if (['f-rec', 'f-end-mode', 'f-end', 'f-date'].includes(ev.target.id)) updateRec();
});
['sheet', 'bsheet', 'csheet'].forEach((id) => $(id).addEventListener('click', (ev) => { if (ev.target.id === id) ev.target.close(); }));
$('f-amount').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveExpense(); });

window.addEventListener('online', () => sync());
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));

setMoney();
show('home');
sync();
