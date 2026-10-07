// Mis Gastos — web app móvil estilo iOS. Los datos viven solo en el celular; copias cifradas opcionales.
// Gastos, ingresos, balance, presupuestos y tarjetas de crédito con cuotas.
// Funciona offline. Datos en IndexedDB, cifrados si activás el bloqueo con PIN.

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
  { name: 'Rendimientos',   emoji: '📈', color: '#30D158' },
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
const APP_VERSION = '8.6.1';
const ACC_TYPES = {
  cash:    { label: 'Efectivo',  emoji: '💵', color: '#34C759' },
  bank:    { label: 'Banco',     emoji: '🏦', color: '#007AFF' },
  savings: { label: 'Ahorro',    emoji: '🐷', color: '#FF9500' },
  invest:  { label: 'Inversión', emoji: '📈', color: '#5856D6' },
};

// ---------- Estado y almacenamiento ----------
// Los datos viven en IndexedDB (más espacio y más estable que localStorage).
// Con el bloqueo activado, se guardan cifrados con una clave que solo se abre con tu PIN o tu huella.
const legacy = {   // localStorage: solo para migrar datos de versiones anteriores a la 8
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
};
const DATA_KEYS = ['expenses', 'budgets', 'cards', 'recurring', 'accounts', 'transfers', 'cats'];
const idb = {
  db: null,
  open() {
    return this.db ||= new Promise((res, rej) => {
      const r = indexedDB.open('mis-gastos', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('receipts'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req ? req.result : undefined); t.onerror = t.onabort = () => rej(t.error);
    });
  },
  get(store, k) { return this.run(store, 'readonly', (s) => s.get(k)); },
  set(store, k, v) { return this.run(store, 'readwrite', (s) => s.put(v, k)); },
  del(store, k) { return this.run(store, 'readwrite', (s) => s.delete(k)); },
  keys(store) { return this.run(store, 'readonly', (s) => s.getAllKeys()); },
  clear(store) { return this.run(store, 'readwrite', (s) => s.clear()); },
};
const S = {
  expenses: [], budgets: {}, cards: [], recurring: [], accounts: null, transfers: [], cats: [],
  cfg: { usdRate: 0, rateDate: '', currency: 'UYU' },
  receipts: new Set(),   // ids de movimientos con foto de recibo
  view: 'home', offset: 0, query: '', catFilter: 'Todas',
  editingId: null, selCat: CATS[0].name, selType: 'expense', selCur: '', budgetCat: null, editingCardId: null,
};
const dataObj = () => ({ ...Object.fromEntries(DATA_KEYS.map((k) => [k, S[k]])), cfg: S.cfg });
let saveChain = Promise.resolve(), saveQueued = false;
function persist() {
  if (saveQueued) return saveChain;
  saveQueued = true;
  return (saveChain = saveChain.then(async () => {
    saveQueued = false;
    await idb.set('kv', 'data', await seal(dataObj()));
  }).catch((e) => { console.error(e); toast('No se pudo guardar: ' + (e.message || e)); }));
}

// ---------- Cifrado local ----------
// DEK: clave aleatoria que cifra los datos. Se guarda envuelta con el PIN (PBKDF2) y, si querés, con tu huella (WebAuthn PRF).
let DEK = null, DEK_RAW = null;
const PIN_ITER = 600000;
const enc8 = (s) => new TextEncoder().encode(s);
async function aesSeal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: b64(iv), data: b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)) };
}
async function aesOpen(key, box) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data)));
}
const importAes = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function seal(obj) {
  return DEK ? { v: 1, enc: await aesSeal(DEK, enc8(JSON.stringify(obj))) } : { v: 1, plain: obj };
}
async function unseal(rec) {
  if (!rec) return null;
  if (rec.plain) return rec.plain;
  return JSON.parse(new TextDecoder().decode(await aesOpen(DEK, rec.enc)));
}
async function pinKey(pin, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc8(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function prfKey(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc8('mis-gastos-dek') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function wrapWithPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: b64(salt), iter: PIN_ITER, ...(await aesSeal(await pinKey(pin, salt, PIN_ITER), DEK_RAW)) };
}
async function unlockWithPin(lock, pin) {
  const raw = await aesOpen(await pinKey(pin, unb64(lock.pin.salt), lock.pin.iter), lock.pin);
  DEK_RAW = raw; DEK = await importAes(raw);
}
const bioSupported = () => !!(window.PublicKeyCredential && navigator.credentials?.create);
async function bioSecret(credId, prfSalt) {
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, timeout: 60000,
    allowCredentials: [{ type: 'public-key', id: credId }], userVerification: 'required',
    extensions: { prf: { eval: { first: prfSalt } } },
  } });
  const out = cred.getClientExtensionResults()?.prf?.results?.first;
  if (!out) throw new Error('prf');
  return new Uint8Array(out);
}
async function unlockWithBio(lock) {
  const secret = await bioSecret(unb64(lock.bio.credId), unb64(lock.bio.prfSalt));
  const raw = await aesOpen(await prfKey(secret), lock.bio);
  DEK_RAW = raw; DEK = await importAes(raw);
}
// Vuelve a guardar todo (datos, recibos, copia previa a restaurar) con la clave actual (o sin cifrar si no hay).
async function resealAll(prevDEK) {
  const cur = DEK;
  const items = [];
  for (const id of await idb.keys('receipts')) {
    DEK = prevDEK; const blob = await getReceipt(id); DEK = cur;
    if (blob) items.push([id, blob]);
  }
  DEK = prevDEK; const pre = await unseal(await idb.get('kv', 'preRestore')).catch(() => null); DEK = cur;
  for (const [id, blob] of items) await putReceipt(id, blob);
  if (pre) await idb.set('kv', 'preRestore', await seal(pre));
  await persist();
}

// ---------- Utilidades ----------
const $ = (id) => document.getElementById(id);
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
// Categorías propias: van antes de «Otros» / «Otros ingresos».
const userCats = (type) => (S.cats || []).filter((c) => (c.type || 'expense') === type);
const expCats = () => [...CATS.slice(0, -1), ...userCats('expense'), CATS[CATS.length - 1]];
const incCats = () => [...INCOME_CATS.slice(0, -1), ...userCats('income'), INCOME_CATS[INCOME_CATS.length - 1]];
const allCats = () => [...expCats(), ...incCats()];
const catsFor = (type) => (type === 'income' ? incCats() : expCats());
const cat = (name) => allCats().find((c) => c.name === name) || CATS[CATS.length - 1];
const card = (id) => S.cards.find((c) => c.id === id);
const account = (id) => (S.accounts || []).find((a) => a.id === id);
const isCardM = (m) => !!card(m);
// Bancos: agrupan varias cuentas (caja en pesos, en dólares, alimentación…).
const bankNames = () => [...new Set((S.accounts || []).map((a) => (a.bank || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
const sameBank = (v) => { const t = String(v || '').trim().slice(0, 24); return bankNames().find((b) => b.toLowerCase() === t.toLowerCase()) || t; };
const curName = (c) => (['UYU', 'ARS', 'MXN', 'COP', 'CLP'].includes(c) ? 'Pesos' : c === 'BRL' ? 'Reales' : c === 'EUR' ? 'Euros' : c === 'PEN' ? 'Soles' : c);
const accLabel = (a) => (a.bank && !a.name.toLowerCase().includes(a.bank.toLowerCase()) ? `${a.bank} · ${a.name}` : a.name);
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
    if (e.opening && (e.opening === 'balance' || key < e.openKey)) continue;   // deuda previa a usar la app: no es gasto de ese mes
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
    if (e.method !== a.id || e.date > today || e.noBalance || !(e.date > sd || String(e.updated || '') > String(a.since || ''))) continue;
    const v = conv(Number(e.amount), entryCur(e), cur, rateOf(e));
    b += isIncome(e) ? v : -v;
  }
  for (const r of S.recurring) {
    if (r.method !== a.id) continue;
    for (let k = ymKey(r.start); k <= nowKey(); k++) {
      if (!ruleActive(r, k)) continue;
      const d = ruleDate(r, k);
      if (d > today || d <= sd || d < dateOnly(r.created) || (r.paidKey && k <= r.paidKey)) continue;
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
// ---------- Rendimientos ----------
// Estimación con interés compuesto diario según la tasa anual que pusiste. Es solo una guía hasta que registres el real.
const canYield = (a) => !!a && a.type !== 'cash';
const yieldFrom = (a) => a.yieldFrom || dateOnly(a.since) || isoDate(new Date());
const daysSince = (iso) => Math.max(0, Math.round((parseLocal(isoDate(new Date())) - parseLocal(iso)) / 864e5));
function yieldEstimate(a, tna = Number(a.tna) || 0) {
  const bal = accountBalance(a), days = daysSince(yieldFrom(a));
  if (!(tna > 0) || bal <= 0 || !days) return { est: 0, days, bal };
  return { est: r2(bal * (Math.pow(1 + tna / 100 / 365, days) - 1)), days, bal };
}

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
      if (e.opening && key < e.openKey) continue;   // cuotas ya pagadas antes de cargarla
      if (key <= now && (key >= sinceK || e.opening)) debt[cur] += v;
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
// Muestra cualquier error inesperado en vez de fallar en silencio.
window.addEventListener('error', (ev) => { try { toast('Error: ' + (ev.message || 'desconocido')); } catch {} });
window.addEventListener('unhandledrejection', (ev) => { try { toast('Error: ' + (ev.reason?.message || ev.reason || 'desconocido')); } catch {} });
function toast(msg, action = null) {
  const t = $('toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) t.querySelector('button').onclick = () => { t.hidden = true; action.fn(); };
  t.hidden = false; t.classList.toggle('has-action', !!action);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), action ? 7000 : 2600);
}
const icon = (c) => `<span class="ci" style="background:${esc(c.color)}">${esc(c.emoji)}</span>`;
const progressClass = (p) => (p > 1 ? 'over' : p > .8 ? 'warn' : '');
// Utilización de crédito: hasta 30% sana, 30-80% atención, más de 80% alta.
const utilClass = (u) => (u > .8 ? 'over' : u > .3 ? 'warn' : '');
const monthPicker = () => `<div class="month">
    <button data-action="prev-month" aria-label="Mes anterior">‹</button>
    <span>${keyLabel(nowKey() + S.offset)}</span>
    <button data-action="next-month" aria-label="Mes siguiente">›</button>
  </div>`;
const header = (title, action = 'new-expense') => `
  <div class="nav">${action === 'new-expense' ? `<button class="icon-btn" data-action="scan-ticket" aria-label="Escanear ticket">📷</button>` : ''}${action ? `<button class="icon-btn" data-action="${action}" aria-label="Agregar">+</button>` : ''}</div>
  <h1 class="large-title">${title}</h1>`;
function entryRow(x) {
  const c = cat(x.category), inc = isIncome(x);
  const cd = !inc && isCardM(x.method) ? card(x.method) : null;
  const ac = !cd && S.accounts.length > 1 ? account(x.method) : null;
  const sub = [x.fixed ? 'Fijo' : null, x.note ? x.category : null, cd ? cd.name : ac ? ac.name : null, x.n > 1 ? `cuota ${x.k + 1}/${x.n}` : null, S.receipts.has(x.id) && !x.fixed ? '📎' : null, isUSD(x) ? (x.n > 1 ? fmtUSD(r2(x.amount / x.n)) : fmtUSD(x.amount)) : null].filter(Boolean).join(' · ') || dayLabel(x.date);
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


// ---------- Alertas de presupuesto ----------
function budgetUse(category, key) {
  const b = Number(S.budgets[category] || 0);
  if (!b) return null;
  const spent = sumV(expensesOf(entriesForMonth(key)).filter((e) => e.category === category));
  return { key, b, spent, p: spent / b };
}
function budgetAlertMsg(category, before, after) {
  if (!after) return '';
  if (after.p > 1 && before.p <= 1) return `⚠️ Te pasaste del presupuesto de ${category} por ${fmt(after.spent - after.b)}`;
  if (after.p >= .8 && before.p < .8) return `⚠️ ${category} ya va por el ${Math.round(after.p * 100)}% del presupuesto`;
  return '';
}
function budgetAlerts(key) {
  return Object.keys(S.budgets).map((c) => ({ c, ...budgetUse(c, key) })).filter((x) => x.b && x.p >= .8).sort((a, b) => b.p - a.p);
}

// ---------- Gráfico de los últimos meses ----------
function barsSVG(endKey) {
  const months = Array.from({ length: 6 }, (_, i) => endKey - 5 + i).map((k) => {
    const en = entriesForMonth(k);
    return { k, spent: sumV(expensesOf(en)), earned: sumV(incomesOf(en)) };
  });
  const max = Math.max(1, ...months.flatMap((m) => [m.spent, m.earned]));
  const W = 300, H = 130, base = 108, colW = W / 6, bw = 14;
  const bars = months.map((m, i) => {
    const x = i * colW + colW / 2, hs = (m.spent / max) * 92, he = (m.earned / max) * 92;
    return `<g class="${m.k === endKey ? 'cur' : ''}" data-action="goto-month" data-off="${m.k - nowKey()}" style="cursor:pointer">
      <rect x="${x - colW / 2}" y="0" width="${colW}" height="${H}" fill="transparent"/>
      <rect x="${x - bw - 1}" y="${base - he}" width="${bw}" height="${Math.max(he, 1)}" rx="3" fill="var(--green)" opacity="${m.earned ? 1 : .25}"/>
      <rect x="${x + 1}" y="${base - hs}" width="${bw}" height="${Math.max(hs, 1)}" rx="3" fill="var(--red)" opacity="${m.spent ? 1 : .25}"/>
      <text x="${x}" y="${base + 16}" text-anchor="middle">${keyLabel(m.k, true)}</text>
    </g>`;
  }).join('');
  const withData = months.filter((m) => m.spent);
  const avg = withData.length ? sumV(withData.map((m) => ({ value: m.spent }))) / withData.length : 0;
  return { svg: `<svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Ingresos y gastos de los últimos 6 meses">${bars}</svg>`, avg };
}



// ---------- Deuda anterior de una tarjeta ----------
// Para empezar con la tarjeta ya usada: compras en cuotas en curso y saldo del resumen. Cuenta como deuda, no como gasto del pasado.
function openDebt(cardId, id = null) {
  const e = id ? S.expenses.find((x) => x.id === id) : null;
  const c = card(e ? e.method : cardId); if (!c) return;
  S.debtCard = c.id; S.editingDebt = e ? e.id : null;
  S.debtKind = e ? e.opening : 'plan'; S.debtCur = e && isUSD(e) ? USD : '';
  const now = nowKey();
  $('d-title').textContent = c.name;
  $('d-note').value = e ? e.note || '' : '';
  if (e && e.opening === 'plan') {
    const n = nInst(e), left = n - Math.max(now - firstInstallmentKey(e), 0);
    $('d-amount').value = numStr(instCur(e, 0)); $('d-left').value = String(Math.max(left, 1)); $('d-total').value = e.totalGiven ? String(n) : '';
  } else { $('d-amount').value = e ? numStr(e.amount) : ''; $('d-left').value = ''; $('d-total').value = ''; }
  $('d-delete-group').hidden = !e;
  $('d-cur').hidden = !usdMode();
  updateDebt();
  $('dsheet').showModal();
}
function updateDebt() {
  const plan = S.debtKind === 'plan';
  document.querySelectorAll('#d-kind button').forEach((b) => b.classList.toggle('on', b.dataset.kind === S.debtKind));
  document.querySelectorAll('#d-cur button').forEach((b) => b.classList.toggle('on', b.dataset.cur === S.debtCur));
  $('d-left-row').hidden = $('d-total-row').hidden = !plan;
  $('d-amount-label').textContent = plan ? 'Valor de la cuota' : 'Saldo a pagar';
  $('d-note').placeholder = plan ? 'Heladera' : 'Resumen anterior';
  const amt = parseAmount($('d-amount').value), left = parseInt($('d-left').value, 10);
  $('d-hint').textContent = plan
    ? (amt > 0 && left > 0 ? `Quedan ${fmtCur(r2(amt * left), S.debtCur)} en ${plural(left, 'cuota')}, desde este mes. ` : '') + 'Las cuotas que ya pagaste no se cuentan.'
    : 'Lo que ya te facturaron y todavía no pagaste. Suma a la deuda de la tarjeta, no a tus gastos del mes.';
}
function saveDebt() {
  const c = card(S.debtCard); if (!c) return;
  const amt = parseAmount($('d-amount').value);
  if (!(amt > 0)) return toast(S.debtKind === 'plan' ? 'Poné el valor de la cuota' : 'Poné el saldo a pagar');
  const now = nowKey(), old = S.expenses.find((x) => x.id === S.editingDebt);
  const ymd = (key) => isoDate(new Date(Math.floor(key / 12), key % 12, 1));
  const base = { id: old ? old.id : uid(), type: 'expense', category: old ? old.category : 'Otros', method: c.id, currency: S.debtCur,
    rate: S.debtCur === USD ? S.cfg.usdRate || '' : '', openKey: old ? old.openKey : now };
  if (S.debtKind === 'plan') {
    const left = parseInt($('d-left').value, 10), totalIn = parseInt($('d-total').value, 10);
    if (!(left >= 1 && left <= 120)) return toast('¿Cuántas cuotas te faltan? (incluida la de este mes)');
    const n = totalIn >= left ? totalIn : left;
    const first = now - (n - left);
    upsertExpense({ ...base, opening: 'plan', openKey: Math.min(base.openKey, now), amount: r2(amt * n), installments: n, totalGiven: totalIn >= left,
      date: ymd(first), note: $('d-note').value.trim().slice(0, 40) || 'Compra en cuotas' });
  } else {
    upsertExpense({ ...base, opening: 'balance', amount: r2(amt), installments: 1, date: ymd(base.openKey), note: $('d-note').value.trim().slice(0, 40) || 'Saldo anterior' });
  }
  $('dsheet').close(); render(); toast('Deuda cargada en ' + c.name);
}

// ---------- Categorías propias ----------
const CAT_COLORS = ['#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#30B0C7', '#007AFF', '#5856D6', '#AF52DE', '#FF2D55', '#A2845E', '#8E8E93', '#1C1C1E'];
const CAT_EMOJIS = ['🐶', '🎓', '👶', '🏋️', '✈️', '🚗', '⛽', '☕', '🍺', '🎬', '📚', '💇', '🧾', '📱', '🎁', '🛒', '🏥', '🐱', '⚽', '🎵', '🧹', '💸', '🏖️', '❤️'];
function openCat(id = null, type = null) {
  const c = id ? S.cats.find((x) => x.id === id) : null;
  S.editingCat = c ? c.id : null;
  S.catDraft = c ? { ...c } : { name: '', emoji: CAT_EMOJIS[0], color: CAT_COLORS[5], type: type || 'expense' };
  S.catFromForm = !id && !!type;
  $('k-title').textContent = c ? 'Editar categoría' : 'Nueva categoría';
  $('k-name').value = S.catDraft.name;
  $('k-emoji').value = S.catDraft.emoji;
  $('k-custom-color').value = S.catDraft.color;
  $('k-delete-group').hidden = !c;
  $('k-emojis').innerHTML = CAT_EMOJIS.map((e) => `<button type="button" data-action="k-emoji" data-e="${e}">${e}</button>`).join('');
  $('k-colors').innerHTML = CAT_COLORS.map((col) => `<button type="button" data-action="k-color" data-c="${col}" style="background:${col}" aria-label="Color"></button>`).join('');
  renderCatPreview();
  $('ksheet').showModal();
  if (!c) setTimeout(() => $('k-name').focus(), 120);
}
function renderCatPreview() {
  const d = S.catDraft;
  $('k-preview').innerHTML = `${icon(d)}<b>${esc(d.name || 'Nombre')}</b>`;
  document.querySelectorAll('#k-type button').forEach((b) => b.classList.toggle('on', b.dataset.type === d.type));
  document.querySelectorAll('#k-colors button').forEach((b) => b.classList.toggle('on', b.dataset.c.toLowerCase() === d.color.toLowerCase()));
  document.querySelectorAll('#k-emojis button').forEach((b) => b.classList.toggle('on', b.dataset.e === d.emoji));
}
const firstGrapheme = (str) => {
  const t = String(str || '').trim(); if (!t) return '';
  if (window.Intl && Intl.Segmenter) { const seg = new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(t)[Symbol.iterator]().next().value; return seg ? seg.segment : t.slice(0, 2); }
  return Array.from(t)[0];
};
function saveCat() {
  const d = S.catDraft, name = $('k-name').value.trim().slice(0, 24);
  if (!name) return toast('Ponele un nombre');
  const emoji = firstGrapheme($('k-emoji').value) || '🏷️';
  const old = S.editingCat ? S.cats.find((x) => x.id === S.editingCat) : null;
  if (allCats().some((c) => c.name.toLowerCase() === name.toLowerCase() && c !== old)) return toast('Ya hay una categoría con ese nombre');
  const next = { id: old ? old.id : uid(), name, emoji, color: d.color, type: d.type };
  if (old) {
    if (old.type !== next.type && [...S.expenses, ...S.recurring].some((e) => e.category === old.name)) return toast('Ya tiene movimientos: no se puede pasar de gasto a ingreso');
    if (old.name !== name) {   // renombrar en movimientos, fijos y presupuestos
      [...S.expenses, ...S.recurring].forEach((e) => { if (e.category === old.name) { e.category = name; e.updated = new Date().toISOString(); } });
      if (S.budgets[old.name] !== undefined) { S.budgets[name] = S.budgets[old.name]; delete S.budgets[old.name]; }
    }
    S.cats = S.cats.map((x) => (x.id === old.id ? next : x));
  } else S.cats.push(next);
  persist(); $('ksheet').close();
  if (S.catFromForm && $('sheet').open) { S.selType = next.type; S.selCat = next.name; applyType(); }
  render(); toast(old ? 'Categoría actualizada' : 'Categoría creada');
}
function deleteCat() {
  const c = S.cats.find((x) => x.id === S.editingCat); if (!c) return;
  const fb = c.type === 'income' ? 'Otros ingresos' : 'Otros';
  const n = S.expenses.filter((e) => e.category === c.name).length + S.recurring.filter((e) => e.category === c.name).length;
  if (n && !confirm(`${plural(n, 'movimiento')} de «${c.name}» pasan a «${fb}». ¿Eliminar la categoría?`)) return;
  $('ksheet').close();
  undoable('Categoría eliminada', () => {
    [...S.expenses, ...S.recurring].forEach((e) => { if (e.category === c.name) { e.category = fb; e.updated = new Date().toISOString(); } });
    delete S.budgets[c.name];
    S.cats = S.cats.filter((x) => x.id !== c.id);
    persist(); render();
  });
}

// ---------- Saludo ----------
function greeting() {
  const n = (S.cfg.nickname || '').trim();
  if (!n) return '';
  const h = new Date().getHours();
  const g = h >= 5 && h < 12 ? 'Buen día' : h >= 12 && h < 20 ? 'Buenas tardes' : 'Buenas noches';
  return `<span class="greet">${g}, <b>${esc(n)}</b> 👋</span>`;
}
function askName() {
  $('n-name').value = S.cfg.nickname || '';
  $('nsheet').showModal();
}
function saveName(name) {
  S.cfg.nickname = String(name || '').trim().slice(0, 24); S.cfg.askedName = true;
  persist(); $('nsheet').close(); render();
  if (S.cfg.nickname) toast(`¡Hola, ${S.cfg.nickname}!`);
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
  const alerts = budgetAlerts(key), chart = barsSVG(key);
  let delta = '';
  if (prevSpent > 0) {
    const d = (spent - prevSpent) / prevSpent;
    delta = `<span class="delta ${d > 0 ? 'up' : 'down'}">Gastos ${d > 0 ? '▲' : '▼'} ${Math.abs(d * 100).toFixed(0)}% vs. ${prevName}</span>`;
  }
  $('view-home').innerHTML = `
    ${header('Resumen').replace('<div class="nav">', `<div class="nav">${greeting()}`)}
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
    ${alerts.map((a) => `<button class="card alert ${a.p > 1 ? 'over' : ''}" data-action="edit-budget" data-cat="${esc(a.c)}" style="display:block;width:100%;text-align:left">
      <b>${cat(a.c).emoji} ${esc(a.c)}: ${Math.round(a.p * 100)}% del presupuesto</b>
      <p>${a.p > 1 ? `Te pasaste por ${fmt(a.spent - a.b)}.` : `Te quedan ${fmt(a.b - a.spent)} de ${fmt(a.b)}.`}</p>
    </button>`).join('')}
    ${rows.length ? `
      <div class="section-h"><span>Gastos por categoría</span></div>
      <div class="card donut-wrap">
        ${donutSVG(rows, spent)}
        <div class="legend">${rows.slice(0, 6).map(([n, v]) => `
          <div><i style="background:${cat(n).color}"></i><span>${n}</span><em>${v / spent < .01 ? '<1' : Math.round((v / spent) * 100)}%</em></div>`).join('')}
        </div>
      </div>` : ''}
    ${S.expenses.length || S.recurring.length ? `
      <div class="section-h"><span>Últimos 6 meses</span></div>
      <div class="card">${chart.svg}
        <div class="meta" style="margin-top:6px"><span><i class="dot" style="background:var(--green)"></i>Ingresos <i class="dot" style="background:var(--red);margin-left:8px"></i>Gastos</span>
        ${chart.avg ? `<span>Promedio ${fmt(chart.avg)}</span>` : ''}</div>
      </div>` : ''}
    ${entries.length ? `
      <div class="section-h"><span>Recientes</span><button data-tab="list">Ver todos</button></div>
      <div class="group">${entries.slice(0, 5).map(entryRow).join('')}</div>`
    : `<div class="empty"><b>Sin movimientos en ${name}</b>Tocá + para registrar un gasto o ingreso.</div>`}
  `;
}

function renderList() {
  const q = S.query.trim().toLowerCase();
  const filters = ['Todas', 'Ingresos', 'Fijos', 'Tarjeta', 'Transferencias', ...expCats().map((c) => c.name)];
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
      return `<button class="chip ${S.catFilter === n ? 'on' : ''}" data-action="filter" data-cat="${esc(n)}">${lbl}</button>`;
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
  const y = Number(a.tna) > 0 ? yieldEstimate(a) : null;
  if (y) sub = y.est >= 0.01 ? `Rinde ≈ +${fmtCur(y.est, cur)} (estimado)` : `Rinde ${String(a.tna).replace('.', ',')}% anual`;
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
  const avail = S.accounts.filter((a) => !a.bank && (a.type === 'cash' || a.type === 'bank'));
  const saved = S.accounts.filter((a) => !a.bank && (a.type === 'savings' || a.type === 'invest'));
  const banks = bankNames().map((b) => ({ b, list: S.accounts.filter((a) => a.bank === b) }));
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
    ${backupDue() ? `<div class="card setup">
      <b>Guardá una copia</b>
      <p>${S.cfg.lastBackup ? `Tu última copia es de ${ago(S.cfg.lastBackup).toLowerCase()}.` : 'Todavía no guardaste ninguna copia.'} Tus datos están solo en este celular: si lo perdés, se pierden.</p>
      <div class="actions"><button class="btn small" data-action="backup">Guardar copia</button><button class="link" data-action="backup-later">Más tarde</button></div>
    </div>` : ''}
    <div class="quick">
      <button data-action="new-account"><span>＋</span>Cuenta</button>
      <button data-action="new-transfer"><span>⇄</span>Transferir</button>
      <button data-action="new-card"><span>💳</span>Tarjeta</button>
    </div>
    <div class="section-h"><span>Disponible</span></div>
    <div class="group">${avail.map(accountRow).join('') || '<div class="row"><span class="val">Sin cuentas</span></div>'}</div>
    ${banks.map(({ b, list }) => `<div class="section-h"><span>🏦 ${esc(b)}</span><span>${fmt(list.reduce((s, a) => s + accountBase(a), 0))}</span></div>
      <div class="group">${list.map(accountRow).join('')}</div>`).join('')}
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
      <button class="btn pay" data-action="pay-card" data-id="${esc(c.id)}">Pagar resumen${account(c.payFrom) ? ' desde ' + esc(account(c.payFrom).bank || account(c.payFrom).name) : ''}</button>
      <button class="link center debt-link" data-action="open-debt" data-id="${esc(c.id)}">＋ Cargar cuotas o saldo que ya tenías</button>
      ${s.plans.length ? `
        <div class="section-h"><span>Cuotas · ${esc(c.name)}</span></div>
        <div class="group">${s.plans.map((p) => `
          <button class="row with-icon" data-action="${p.e.opening ? 'edit-debt' : 'edit-expense'}" data-id="${esc(p.e.id)}">
            ${icon(cat(p.e.category))}
            <span class="ri"><b>${esc(p.e.note || p.e.category)}</b>
              <small>${p.fixed ? `Fijo · ${fmtCur(p.cuota, p.cur)}/mes · ${p.e.end ? 'hasta ' + ymLabel(p.e.end) : 'sin fin'}` : p.e.opening === 'balance' ? 'Saldo anterior' : p.n > 1 ? (p.startsLater ? `Empieza el mes que viene · ${p.n} cuotas` : `Cuota ${p.current} de ${p.n}`) + ` · ${fmtCur(p.cuota, p.cur)}/mes` : 'Un pago'}</small></span>
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
    <div class="group">${expCats().map((c) => {
      const b = Number(S.budgets[c.name] || 0), s = spent[c.name] || 0, p = b ? s / b : 0;
      return `<button class="row brow" data-action="edit-budget" data-cat="${esc(c.name)}">
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
  $('view-settings').innerHTML = `
    ${header('Ajustes', null)}
    <div class="section-h"><span>Copia de seguridad</span></div>
    <div class="group">
      <div class="row"><span>Última copia</span><span class="val">${S.cfg.lastBackup ? ago(S.cfg.lastBackup) : 'Nunca'}</span></div>
    </div>
    <button class="btn" data-action="backup">Guardar copia cifrada</button>
    <div class="group"><button class="row blue center" data-action="restore">Restaurar una copia</button></div>
    <p class="footer-note">Tus datos viven solo en este celular. La copia se cifra con tu contraseña antes de salir del teléfono y la guardás donde quieras: Drive, Dropbox, tu correo. Nadie más puede abrirla, ni nosotros. Si olvidás la contraseña, no hay forma de recuperarla.</p>
    <div class="section-h"><span>Seguridad</span></div>
    <div class="group">
      ${LOCK ? `<div class="row"><span>Bloqueo con PIN</span><span class="val">Activado</span></div>
        <button class="row blue" data-action="lock-change">Cambiar PIN<span></span></button>
        ${bioSupported() ? (LOCK.bio ? '<button class="row danger" data-action="bio-off">Dejar de usar la huella</button>' : '<button class="row blue" data-action="bio-on">Desbloquear con huella<span></span></button>') : ''}
        <button class="row danger" data-action="lock-off">Desactivar bloqueo</button>`
      : '<button class="row blue" data-action="lock-on">Activar bloqueo con PIN<span></span></button>'}
    </div>
    <p class="footer-note">${LOCK ? 'Tus datos y fotos están cifrados en este celular. Te pide PIN o huella al abrir la app, salvo que la hayas usado en los últimos 10 minutos.' : 'Pide un PIN al abrir la app y guarda tus datos cifrados en el celular, para que nadie los vea aunque tenga tu teléfono.'}</p>
    <div class="section-h"><span>General</span></div>
    <div class="group">
      <label class="row"><span>Tu nombre</span><input id="cfg-nickname" type="text" maxlength="24" placeholder="Opcional" value="${esc(S.cfg.nickname || '')}"></label>
      <label class="row"><span>Moneda</span>
        <select id="cfg-currency">${CURRENCIES.map((c) => `<option ${c === S.cfg.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
      ${usdMode() ? `<label class="row"><span>Dólar (1 US$)</span><input id="cfg-rate" inputmode="decimal" placeholder="Cotización" value="${S.cfg.usdRate ? String(S.cfg.usdRate).replace('.', ',') : ''}"></label>
      <button class="row blue" data-action="refresh-rate">Actualizar cotización<span class="val">${S.cfg.rateDate ? (S.cfg.rateManual ? 'manual' : new Date(S.cfg.rateDate).toLocaleString('es-UY', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })) : ''}</span></button>` : ''}
    </div>
    ${usdMode() ? `<p class="footer-note">Podés cargar movimientos en dólares. Se convierten a ${esc(S.cfg.currency)} con la cotización del día en que los cargás; los fijos en dólares usan la cotización actual.</p>` : ''}
    <div class="section-h"><span>Mis categorías</span></div>
    <div class="group">
      ${S.cats.map((c) => `<button class="row" data-action="edit-cat" data-id="${esc(c.id)}"><span class="ri-inline">${icon(c)}${esc(c.name)}</span><span class="val">${c.type === 'income' ? 'Ingreso' : 'Gasto'}</span></button>`).join('')}
      <button class="row blue" data-action="new-cat">Agregar categoría<span></span></button>
    </div>
    <div class="section-h"><span>Datos</span></div>
    <div class="group">
      <button class="row blue" data-action="import">Importar estado de cuenta (CSV)<span></span></button>
      <button class="row blue" data-action="export">Exportar CSV<span></span></button>
      ${S.hasPreRestore ? '<button class="row blue" data-action="undo-restore">Volver a los datos de antes de restaurar<span></span></button>' : ''}
      <button class="row danger" data-action="wipe">Borrar datos de este dispositivo</button>
    </div>
    <p class="footer-note">${plural(S.expenses.length, 'movimiento')}, ${plural(S.recurring.length, 'fijo')}, ${plural(S.accounts.length, 'cuenta')} y ${plural(S.cards.length, 'tarjeta')} guardados. Si borrás los datos del celular, solo los recuperás con una copia.</p>
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
// Antes encolaba cambios para Google Sheets; ahora todo queda en el celular.
function enqueue() {
  S.cfg.lastChange = new Date().toISOString();
  persist(); render();
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

// ---------- Fotos de recibos ----------
async function putReceipt(id, blob) {
  const rec = DEK ? { type: blob.type, enc: await aesSeal(DEK, new Uint8Array(await blob.arrayBuffer())) } : { type: blob.type, blob };
  await idb.set('receipts', id, rec); S.receipts.add(id);
}
async function getReceipt(id) {
  const rec = await idb.get('receipts', id);
  if (!rec) return null;
  return rec.blob || new Blob([await aesOpen(DEK, rec.enc)], { type: rec.type });
}
async function delReceipt(id) { await idb.del('receipts', id); S.receipts.delete(id); }
// Achica la foto (máx. 1280 px, JPEG) para que no ocupe tanto ni agrande las copias.
async function shrinkImage(file) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72));
}
const blobToB64 = async (blob) => b64(await blob.arrayBuffer());
let receiptURL = null;
function showReceiptPreview(blob) {
  if (receiptURL) URL.revokeObjectURL(receiptURL);
  receiptURL = blob ? URL.createObjectURL(blob) : null;
  $('f-receipt-img').src = receiptURL || '';
  $('f-receipt-prev').hidden = !blob; $('f-receipt-add').hidden = !!blob;
}
function pickReceipt() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; S.extAt = Date.now();
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try { S.pendingReceipt = await shrinkImage(f); showReceiptPreview(S.pendingReceipt); }
    catch { toast('No se pudo abrir esa imagen'); }
  };
  inp.click();
}
function viewReceipt() {
  if (!receiptURL) return;
  $('r-img').src = receiptURL; $('rsheet').showModal();
}
// Borra fotos de movimientos que ya no existen (se hace al abrir, así «Deshacer» puede recuperarlas en la sesión).
async function cleanReceipts() {
  const ids = new Set(S.expenses.map((e) => e.id));
  for (const id of [...S.receipts]) if (!ids.has(id)) await delReceipt(id).catch(() => {});
}

// ---------- Deshacer ----------
const stateJSON = () => JSON.stringify(Object.fromEntries(DATA_KEYS.map((k) => [k, S[k]])));
function loadState(json) { const d = JSON.parse(json); DATA_KEYS.forEach((k) => (S[k] = d[k])); }
function undoable(msg, fn) {
  const before = stateJSON();
  fn();
  toast(msg, { label: 'Deshacer', fn: () => { loadState(before); persist(); render(); toast('Listo, se recuperó'); } });
}

// ---------- Copia de seguridad cifrada ----------
// AES-GCM 256 con clave derivada de la contraseña (PBKDF2-SHA256). Todo pasa en el celular.
const KDF_ITER = 310000;
const b64 = (buf) => {
  const u = new Uint8Array(buf); let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(bin);
};
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptJSON(obj, pass) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, KDF_ITER);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { app: 'mis-gastos', enc: 'AES-GCM-256/PBKDF2-SHA256', v: 1, iter: KDF_ITER, salt: b64(salt), iv: b64(iv), data: b64(data) };
}
async function decryptJSON(box, pass) {
  const key = await deriveKey(pass, unb64(box.salt), box.iter || KDF_ITER);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
// Pide una contraseña en una hoja propia (no en prompt, para que no se vea).
function askPassword({ title, hint, confirm2 = false, pin = false, check = null }) {
  return new Promise((resolve) => {
    const d = $('pwsheet');
    $('pw-title').textContent = title; $('pw-hint').textContent = hint;
    $('pw-1').value = ''; $('pw-2').value = ''; $('pw-err').textContent = '';
    $('pw-2row').hidden = !confirm2;
    ['pw-1', 'pw-2'].forEach((id) => { $(id).inputMode = pin ? 'numeric' : 'text'; $(id).classList.toggle('pin', pin); });
    $('pw-1').placeholder = pin ? 'PIN' : 'Contraseña';
    const done = (v) => { d.close(); $('pw-ok').onclick = $('pw-cancel').onclick = d.onclose = null; resolve(v); };
    $('pw-ok').onclick = async () => {
      const p1 = $('pw-1').value;
      if (pin && confirm2 && !/^\d{6,12}$/.test(p1)) return ($('pw-err').textContent = 'El PIN debe tener entre 6 y 12 números');
      if (!pin && confirm2 && p1.length < 8) return ($('pw-err').textContent = 'Usá al menos 8 caracteres');
      if (confirm2 && p1 !== $('pw-2').value) return ($('pw-err').textContent = pin ? 'Los PIN no coinciden' : 'Las contraseñas no coinciden');
      if (!p1) return ($('pw-err').textContent = pin ? 'Escribí el PIN' : 'Escribí la contraseña');
      if (check) { $('pw-err').textContent = 'Verificando…'; if (!(await check(p1))) return ($('pw-err').textContent = pin ? 'PIN incorrecto' : 'Contraseña incorrecta'); }
      done(p1);
    };
    $('pw-cancel').onclick = () => done(null);
    d.onclose = () => resolve(null);
    d.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); $('pw-ok').click(); } };
    d.showModal(); setTimeout(() => $('pw-1').focus(), 50);
  });
}
async function snapshot(withReceipts = true) {
  const receipts = {};
  if (withReceipts) for (const id of S.receipts) { const b = await getReceipt(id).catch(() => null); if (b) receipts[id] = await blobToB64(b); }
  return { app: 'mis-gastos', version: APP_VERSION, date: new Date().toISOString(),
    expenses: S.expenses, budgets: S.budgets, cats: S.cats, cards: S.cards, recurring: S.recurring, accounts: S.accounts, transfers: S.transfers,
    cfg: { currency: S.cfg.currency, usdRate: S.cfg.usdRate, merchants: S.cfg.merchants || {} }, receipts };
}
// Devuelve true si la copia se guardó.
async function backup() {
  const pass = await askPassword({ title: 'Contraseña de la copia', hint: 'La vas a necesitar para restaurar. No la guardamos en ningún lado.', confirm2: true });
  if (!pass) return false;
  toast('Cifrando…');
  const box = await encryptJSON(await snapshot(), pass);
  const name = `mis-gastos-${isoDate(new Date())}.json`;
  const file = new File([JSON.stringify(box)], name, { type: 'application/json' });
  let saved = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    S.extAt = Date.now();
    try { await navigator.share({ files: [file], title: 'Copia de Mis Gastos' }); saved = true; }
    catch (e) { if (e.name === 'AbortError') { toast('Copia cancelada'); return false; } }
  }
  if (!saved) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  S.cfg.lastBackup = new Date().toISOString(); persist(); render();
  toast('Copia cifrada guardada');
  return true;
}
const unsavedChanges = () => S.expenses.length + S.recurring.length + S.transfers.length > 0
  && (!S.cfg.lastBackup || (S.cfg.lastChange && S.cfg.lastChange > S.cfg.lastBackup));
// Antes de algo que reemplaza o borra todo, ofrece guardar una copia. Devuelve false si el usuario se arrepiente.
async function offerBackupFirst(what) {
  if (!unsavedChanges()) return true;
  if (!confirm(`Tus últimos cambios no están en ninguna copia. ¿Guardar una copia cifrada antes de ${what}?\n\nAceptar: guardar copia · Cancelar: seguir sin copia`)) return true;
  return backup();
}
async function wipe() {
  if (!(await offerBackupFirst('borrar'))) return;
  if (!confirm('¿Borrar todos los datos de este celular? Solo vas a poder recuperarlos con una copia.')) return;
  undoable('Datos borrados', () => {
    S.expenses = []; S.budgets = {}; S.cards = []; S.recurring = []; S.transfers = []; S.accounts = null; S.cats = [];
    ensureCash(); persist(); render();
  });
  idb.del('kv', 'preRestore'); S.hasPreRestore = false;
}
async function applyBackup(d) {
  S.expenses = d.expenses; S.budgets = d.budgets || {}; S.cards = d.cards || []; S.recurring = d.recurring || [];
  S.accounts = d.accounts || null; S.transfers = d.transfers || []; S.cats = d.cats || [];
  if (d.cfg?.currency) { S.cfg.currency = d.cfg.currency; S.cfg.usdRate = d.cfg.usdRate || S.cfg.usdRate; if (d.cfg.merchants) S.cfg.merchants = d.cfg.merchants; }
  if (d.receipts) {
    for (const id of [...S.receipts]) await delReceipt(id);
    for (const [id, data] of Object.entries(d.receipts)) await putReceipt(id, new Blob([unb64(data)], { type: 'image/jpeg' }));
  }
  ensureCash(); S.cfg.setupPending = false; await persist(); setMoney(); render();
}
function restore() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json'; S.extAt = Date.now();
  inp.onchange = async () => {
    let d;
    try { d = JSON.parse(await inp.files[0].text()); } catch (e) { return toast('Ese archivo no es una copia de Mis Gastos'); }
    if (d.app !== 'mis-gastos') return toast('Ese archivo no es una copia de Mis Gastos');
    if (d.enc) {
      const pass = await askPassword({ title: 'Abrir copia', hint: 'Escribí la contraseña con la que guardaste esta copia.' });
      if (!pass) return;
      try { d = await decryptJSON(d, pass); } catch (e) { return toast('Contraseña incorrecta'); }
    }
    if (!Array.isArray(d.expenses)) return toast('Ese archivo no es una copia de Mis Gastos');
    if (!(await offerBackupFirst('restaurar'))) return;
    if (!confirm(`¿Reemplazar los datos de este celular por la copia del ${new Date(d.date).toLocaleDateString('es-UY')}? Si te equivocás, podés volver atrás desde Ajustes.`)) return;
    // Guarda lo que había (con recibos) para poder volver atrás.
    await idb.set('kv', 'preRestore', await seal(await snapshot()));
    S.hasPreRestore = true;
    await applyBackup(d);
    toast('Copia restaurada', { label: 'Deshacer', fn: undoRestore });
  };
  inp.click();
}
async function undoRestore() {
  const pre = await unseal(await idb.get('kv', 'preRestore')).catch(() => null);
  if (!pre) return toast('No hay datos anteriores para recuperar');
  await applyBackup(pre);
  await idb.del('kv', 'preRestore'); S.hasPreRestore = false; render();
  toast('Volviste a los datos de antes de restaurar');
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function ago(iso) {
  const days = Math.floor((Date.now() - new Date(iso)) / 864e5);
  return days <= 0 ? 'Hoy' : days === 1 ? 'Ayer' : `Hace ${days} días`;
}
const backupDue = () => S.expenses.length > 0 && !S.cfg.setupPending && (!S.cfg.lastBackup || Date.now() - new Date(S.cfg.lastBackup) > 7 * 864e5)
  && (!S.cfg.backupSnooze || Date.now() > new Date(S.cfg.backupSnooze));
// ---------- Hoja de movimiento ----------
// ---------- Escanear ticket (QR del CFE de DGI) ----------
// El QR del e-ticket trae: RUT emisor, tipo de CFE, serie, número, monto total, fecha y código. Todo se lee en el celular.
const CFE_TYPES = { 101: 'e-Ticket', 111: 'e-Factura', 102: 'Nota de crédito', 112: 'Nota de crédito', 103: 'Nota de débito', 113: 'Nota de débito', 131: 'e-Ticket', 141: 'e-Factura' };
function parseCfe(text) {
  const m = String(text || '').match(/consultaQR\/cfe\?([^#\s]+)/i);
  if (!m) return null;
  const f = decodeURIComponent(m[1]).split(',');
  if (f.length < 6) return null;
  const [rut, tipo, serie, nro, monto, fecha] = f.map((x) => x.trim());
  const amount = Number(monto.replace(/[^\d.-]/g, ''));
  const dm = fecha.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!(amount > 0) || !dm) return null;
  const t = Number(tipo);
  return { rut, tipo: t, serie, nro, amount, date: `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`,
    key: `${rut}-${serie}-${nro}`, type: [102, 112].includes(t) ? 'income' : 'expense', label: CFE_TYPES[t] || 'CFE' };
}
let jsqrLoad = null;
const loadJsQR = () => jsqrLoad || (jsqrLoad = new Promise((res, rej) => {
  if (window.jsQR) return res(window.jsQR);
  const sc = document.createElement('script'); sc.src = 'jsqr.js';
  sc.onload = () => res(window.jsQR); sc.onerror = () => { jsqrLoad = null; rej(new Error('jsqr')); };
  document.head.appendChild(sc);
}));
async function readQR(file) {
  const img = await createImageBitmap(file);
  if ('BarcodeDetector' in window) {
    try {
      const codes = await new BarcodeDetector({ formats: ['qr_code'] }).detect(img);
      const hit = codes.find((c) => parseCfe(c.rawValue)) || codes[0];
      if (hit) return hit.rawValue;
    } catch {}
  }
  const jsQR = await loadJsQR();
  for (const max of [1600, 1100, 2400, 800]) {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, c.width, c.height);
    const r = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'attemptBoth' });
    if (r?.data) return r.data;
  }
  return null;
}
function scanTicket() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment'; S.extAt = Date.now();
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    toast('Leyendo el ticket…');
    let cfe = null, photo = null;
    try { [cfe, photo] = await Promise.all([readQR(f).then(parseCfe).catch(() => null), shrinkImage(f).catch(() => null)]); }
    catch {}
    applyScan(cfe, photo);
  };
  inp.click();
}
function applyScan(cfe, photo) {
  if (!$('sheet').open || S.editingId) openExpense();
  if (photo) { S.pendingReceipt = photo; showReceiptPreview(photo); }
  if (!cfe) { S.pendingCfe = null; return toast('No pude leer el QR (¿ticket arrugado?). Probá otra foto más de cerca o «Pegar link del QR». La foto queda adjunta.'); }
  const dup = S.expenses.find((x) => x.cfe === cfe.key);
  S.pendingCfe = cfe;
  S.selType = cfe.type;
  const m = (S.cfg.merchants || {})[cfe.rut];
  if (m?.cat && catsFor(cfe.type).some((c) => c.name === m.cat)) S.selCat = m.cat;
  if (m?.method && (account(m.method) || (card(m.method) && cfe.type === 'expense'))) S.selMethod = m.method;
  S.selCur = '';
  $('f-amount').value = String(cfe.amount).replace('.', ',');
  $('f-date').value = cfe.date;
  if (m?.name && !$('f-note').value) $('f-note').value = m.name;
  $('f-note').placeholder = m?.name ? 'Opcional' : 'Nombre del comercio (lo recuerdo)';
  applyType();
  toast(dup ? '⚠️ Este ticket ya está cargado. Revisá antes de guardar.'
    : `${cfe.label} leído: ${fmt(cfe.amount)}${m?.name ? ' en ' + m.name : ''}. Revisá y guardá.`);
}
// Plan B: escaneás el QR con la cámara del celular (o Google Lens), copiás el link y lo pegás acá.
async function pasteCfe() {
  let t = '';
  try { t = await navigator.clipboard.readText(); } catch {}
  if (!parseCfe(t)) t = prompt('Pegá el link del QR del ticket (efactura.dgi.gub.uy/consultaQR/…)') || '';
  if (!t) return;
  const cfe = parseCfe(t);
  if (!cfe) return toast('Ese link no es de un ticket de DGI');
  applyScan(cfe, $('sheet').open && S.pendingReceipt instanceof Blob ? S.pendingReceipt : null);
}
function rememberMerchant(cfe, note) {
  if (!cfe) return;
  const prev = (S.cfg.merchants ||= {})[cfe.rut] || {};
  S.cfg.merchants[cfe.rut] = { name: note || prev.name || '', cat: S.selCat, method: S.selMethod };
}
function openExpense(id = null, fixed = false) {
  const rule = id ? S.recurring.find((x) => x.id === id) : null;
  const e = rule || (id ? S.expenses.find((x) => x.id === id) : null);
  S.editingId = e ? e.id : null;
  S.editingRule = !!rule;
  S.selType = e ? (e.type || 'expense') : (S.catFilter === 'Ingresos' ? 'income' : 'expense');
  const cats = catsFor(S.selType);
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
  $('f-paid').checked = rule ? !!rule.paidKey : !!(e && e.noBalance);
  S.paidTouched = !!e;
  const valid = (m) => account(m) || card(m);
  S.selMethod = e && valid(e.method) ? e.method : valid(S.cfg.lastMethod) ? S.cfg.lastMethod : CASH;
  if (!e && account(S.selMethod)) S.selCur = accCur(account(S.selMethod));
  $('f-inst').innerHTML = Array.from({ length: 36 }, (_, i) => `<option value="${i + 1}">${i + 1 === 1 ? '1 pago' : i + 1 + ' cuotas'}</option>`).join('');
  $('f-inst').value = e ? String(nInst(e)) : '1';
  $('f-delete-group').hidden = !e;
  S.pendingReceipt = null; showReceiptPreview(null);
  S.pendingCfe = null; $('f-note').placeholder = 'Opcional';
  $('f-scan-group').hidden = !!e;
  if (e && !rule && S.receipts.has(e.id)) getReceipt(e.id).then((b) => { if (S.editingId === e.id && !S.pendingReceipt) showReceiptPreview(b); }).catch(() => {});
  applyType();
  $('sheet').showModal();
  if (!e) setTimeout(() => $('f-amount').focus(), 120);
}
function applyType() {
  const inc = S.selType === 'income';
  document.querySelectorAll('#f-type button').forEach((b) => b.classList.toggle('on', b.dataset.type === S.selType));
  $('sheet-title').textContent = (S.editingId ? 'Editar ' : 'Nuevo ') + (inc ? 'ingreso' : 'gasto');
  const cats = catsFor(S.selType);
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
  // Lista desplegable agrupada por banco, con el saldo de cada cuenta, para distinguir «Cuenta pesos» de Itaú y de Santander.
  const accOpt = (a) => `<option value="${esc(a.id)}">${esc(a.bank ? accLabel(a) : `${(ACC_TYPES[a.type] || ACC_TYPES.bank).emoji} ${a.name}`)} · ${esc(fmtCur(accountBalance(a), accCur(a)))}</option>`;
  const loose = S.accounts.filter((a) => !a.bank);
  let html = loose.map(accOpt).join('');
  for (const b of bankNames()) html += `<optgroup label="🏦 ${esc(b)}">${S.accounts.filter((a) => a.bank === b).map(accOpt).join('')}</optgroup>`;
  if (!inc && S.cards.length) html += `<optgroup label="💳 Tarjetas de crédito">${S.cards.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} · disponible ${esc(fmt(cardStats(c).available))}</option>`).join('')}</optgroup>`;
  $('f-from').innerHTML = html;
  $('f-from').value = S.selMethod;
  const sa = account(S.selMethod), sc = card(S.selMethod);
  $('f-from-bal').textContent = sa ? `Saldo ${fmtCur(accountBalance(sa), accCur(sa))}` : sc ? `Disponible ${fmt(cardStats(sc).available)}` : '';
}
function pickFrom(id) {
  S.selMethod = id;
  const a = account(id);
  if (a && !S.editingId) S.selCur = accCur(a);
  renderFrom(); updateCur(); updateRec();
}
function renderCatGrid() {
  const cats = catsFor(S.selType);
  $('f-cats').innerHTML = cats.map((c) =>
    `<button type="button" class="${c.name === S.selCat ? 'on' : ''}" data-action="pick-cat" data-cat="${esc(c.name)}">${icon(c)}${esc(c.name)}</button>`).join('')
    + `<button type="button" class="newcat" data-action="new-cat">${icon({ emoji: '＋', color: 'var(--fill)' })}Nueva</button>`;
}
function updatePaid() {
  const rec = $('f-rec').checked, date = $('f-date').value || isoDate(new Date()), today = isoDate(new Date());
  const acc = account(S.selMethod);
  const show = !!acc && (rec ? monthKey(parseLocal(date)) <= nowKey() && date <= today : date <= today);
  $('f-paid-row').hidden = !show;
  $('f-paid-label').textContent = rec ? 'Este mes ya está descontado' : 'Ya descontado del saldo';
  // Sugerencia: lo anterior al día en que cargaste el saldo de la cuenta ya está reflejado.
  if (show && !S.paidTouched) $('f-paid').checked = date < dateOnly(acc.since);
  $('f-paid-hint').hidden = !show || !$('f-paid').checked;
}
function updateRec() {
  updatePaid();
  $('f-receipt-group').hidden = $('f-rec').checked;
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
      note: $('f-note').value.trim(), method, day: d.getDate(), start, end, ...cur, rate: '',
      paidKey: !$('f-paid-row').hidden && $('f-paid').checked ? monthKey(d) : '' });
    $('sheet').close(); render();
    return toast(wasEditing ? 'Fijo actualizado' : 'Fijo mensual guardado');
  }
  if (S.editingRule) deleteRecurring(S.editingId);   // un fijo pasó a gasto común
  const id = S.editingRule ? uid() : S.editingId || uid();
  const beforeB = inc ? null : budgetUse(S.selCat, monthKey(parseLocal(date)));
  if (S.pendingReceipt instanceof Blob) putReceipt(id, S.pendingReceipt).then(render).catch(() => toast('No se pudo guardar la foto'));
  else if (S.pendingReceipt === 'delete') delReceipt(id).then(render);
  S.pendingReceipt = null;
  upsertExpense({ id, type: S.selType, amount: r2(amount), category: S.selCat, date,
    note: $('f-note').value.trim(), method, installments, ...cur, rate: usd ? r2(rate) : '',
    noBalance: !$('f-paid-row').hidden && $('f-paid').checked,
    ...(S.pendingCfe ? { cfe: S.pendingCfe.key } : S.editingId ? { cfe: S.expenses.find((x) => x.id === S.editingId)?.cfe || '' } : {}) });
  rememberMerchant(S.pendingCfe, $('f-note').value.trim()); S.pendingCfe = null;
  $('sheet').close();
  const d = parseLocal(date);
  S.offset = Math.min(0, monthKey(d) - nowKey());
  render();
  const msg = wasEditing ? 'Movimiento actualizado' : installments > 1 ? `Compra en ${installments} cuotas guardada` : inc ? 'Ingreso guardado' : 'Gasto guardado';
  toast(beforeB ? budgetAlertMsg(S.selCat, beforeB, budgetUse(S.selCat, beforeB.key)) || msg : msg);
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
  const local = S.accounts.filter((a) => !accUSD(a)), usd = S.accounts.filter(accUSD);
  const opt = (a) => `<option value="${esc(a.id)}">${esc(accLabel(a))}</option>`;
  $('c-pay').innerHTML = `<option value="">Sin cuenta (efectivo, Abitab…)</option>` + (usdMode() ? local : S.accounts).map(opt).join('');
  $('c-pay').value = c && account(c.payFrom) ? c.payFrom : (local.find((a) => a.type === 'bank')?.id || '');
  $('c-pay-label').textContent = usdMode() ? `${curName(S.cfg.currency)} desde` : 'Se paga desde';
  $('c-pay-usd-row').hidden = !usdMode() || !usd.length;
  $('c-pay-usd').innerHTML = `<option value="">La misma cuenta</option>` + usd.map(opt).join('');
  const sib = () => { const p = account($('c-pay').value); return p && p.bank ? usd.find((a) => a.bank === p.bank) : null; };
  $('c-pay-usd').value = c && account(c.payFromUSD) ? c.payFromUSD : c ? '' : (sib()?.id || '');
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
    payFrom: $('c-pay').value, payFromUSD: usdMode() ? $('c-pay-usd').value : (prev?.payFromUSD || ''), since: prev?.since || new Date().toISOString() });
  $('csheet').close();
  const nc = S.editingCardId ? null : S.cards[S.cards.length - 1];
  toast('Tarjeta guardada', nc ? { label: '¿Ya la usabas?', fn: () => openDebt(nc.id) } : null);
}

// ---------- Hoja de cuenta ----------
const numStr = (n) => (n || n === 0 ? String(n).replace('.', ',') : '');
function openAccount(id = null) {
  const a = id ? account(id) : null;
  S.editingAccountId = a ? a.id : null;
  $('a-title').textContent = a ? a.name : 'Nueva cuenta';
  $('a-name').value = a ? a.name : '';
  $('a-type').value = a ? a.type : 'bank';
  $('a-bank').value = a && a.bank ? a.bank : '';
  $('a-bank-list').innerHTML = bankNames().map((b) => `<option value="${esc(b)}">`).join('');
  $('a-cur-row').hidden = !usdMode();
  $('a-cur').value = a ? (accUSD(a) ? USD : '') : '';
  $('a-cur').disabled = !!a;
  $('a-cur').options[0].textContent = S.cfg.currency;
  $('a-balance').value = a ? numStr(accountBalance(a)) : '';
  $('a-goal').value = a && a.goal ? numStr(a.goal) : '';
  $('a-goal-date').value = a && a.goalDate ? a.goalDate : '';
  $('a-tna').value = a && a.tna ? numStr(a.tna) : '';
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
  $('a-yield-group').hidden = t === 'cash';
  $('a-bank-row').hidden = t === 'cash';
  $('a-yield-btn').hidden = !a || t === 'cash';
  $('a-balance-label').textContent = t === 'invest' ? 'Valor actual' : 'Saldo actual';
  $('a-hint').textContent = a ? (t === 'invest' ? 'Si cambiás el valor, se registra la ganancia o pérdida sin tocar tu balance del mes.'
    : 'Si cambiás el saldo, se registra un ajuste por la diferencia.') : 'Desde ahora, el saldo se mueve solo con cada gasto, ingreso o transferencia.';
}
function saveAccount() {
  const name = $('a-name').value.trim(), type = $('a-type').value;
  const bal = parseAmount($('a-balance').value);
  if (!name) return toast('Poné un nombre, por ejemplo "Caja de ahorro pesos"');
  const goal = parseAmount($('a-goal').value);
  const tna = parseAmount($('a-tna').value);
  const bank = type === 'cash' ? '' : sameBank($('a-bank').value);
  const extra = { bank, tna: type !== 'cash' && tna > 0 ? tna : '', goal: (type === 'savings' || type === 'invest') && goal > 0 ? r2(goal) : '', goalDate: (type === 'savings' || type === 'invest') ? $('a-goal-date').value : '' };
  const a = account(S.editingAccountId);
  if (a) {
    const cur = accountBalance(a);
    upsertAccount({ ...a, name, type, ...extra, yieldFrom: extra.tna && !a.tna ? isoDate(new Date()) : a.yieldFrom });
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


// ---------- Hoja de rendimiento ----------
function openYield(id) {
  const a = account(id); if (!a) return;
  S.yieldAcc = id;
  const { est, days, bal } = yieldEstimate(a);
  $('y-title').textContent = a.name;
  $('y-period').textContent = days ? `Desde el ${new Date(parseLocal(yieldFrom(a))).toLocaleDateString('es-UY', { day: 'numeric', month: 'long' })} (${plural(days, 'día')}) · saldo registrado ${fmtCur(bal, accCur(a))}`
    : `Saldo registrado ${fmtCur(bal, accCur(a))}`;
  $('y-tna').value = a.tna ? numStr(a.tna) : '';
  $('y-balance').value = numStr(r2(bal + est));
  $('y-est-btn').hidden = !est;
  updateYield();
  $('ysheet').showModal();
}
function updateYield() {
  const a = account(S.yieldAcc); if (!a) return;
  const v = parseAmount($('y-balance').value), d = isNaN(v) ? 0 : r2(v - accountBalance(a));
  $('y-diff').textContent = `${d < 0 ? '-' : '+'}${fmtCur(Math.abs(d), accCur(a))}`;
  $('y-diff').className = 'val ' + (d < 0 ? 'danger' : d > 0 ? 'income' : '');
}
function saveYield() {
  const a = account(S.yieldAcc); if (!a) return;
  const v = parseAmount($('y-balance').value);
  if (isNaN(v)) return toast('Escribí el saldo que ves en la cuenta');
  const tna = parseAmount($('y-tna').value);
  const d = r2(v - accountBalance(a)), today = isoDate(new Date()), cur = accCur(a);
  if (d) {
    upsertExpense({ id: uid(), type: d > 0 ? 'income' : 'expense', amount: Math.abs(d), category: d > 0 ? 'Rendimientos' : 'Otros', date: today,
      note: `${d > 0 ? 'Rendimiento' : 'Pérdida'} ${a.name}`.slice(0, 80), method: a.id, installments: 1,
      currency: cur, rate: cur === USD ? S.cfg.usdRate || '' : '', source: 'yield' });
  }
  upsertAccount({ ...a, tna: tna > 0 ? tna : '', yieldFrom: today });
  $('ysheet').close(); $('asheet').close(); render();
  toast(d > 0 ? `Rendimiento de ${fmtCur(d, cur)} registrado` : d < 0 ? 'Saldo actualizado' : 'Sin cambios en el saldo');
}

// ---------- Hoja de transferencia ----------
function accOptions(sel) {
  return S.accounts.map((a) => `<option value="${esc(a.id)}" ${a.id === sel ? 'selected' : ''}>${esc(accLabel(a))}${accUSD(a) ? ' (US$)' : ''}</option>`).join('');
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
function payDefault(c, cur) {
  if (cur === USD && account(c.payFromUSD)) return c.payFromUSD;
  return account(c.payFrom) ? c.payFrom : (account(CASH) || S.accounts[0]).id;   // sin cuenta asociada: se paga en efectivo (Abitab, Redpagos, cajero…)
}
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
  $('p-from').innerHTML = accOptions(t ? t.from : payDefault(c, S.payCur));
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

// ---------- Sesión de 10 minutos ----------
// Después de desbloquear, si cerrás y volvés a abrir dentro de 10 minutos no pide PIN ni huella.
// La DEK se guarda envuelta con una clave del navegador no exportable, y la sesión vence sola.
const GRACE_MS = 10 * 60 * 1000;
async function startSession() {
  try {
    const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await idb.set('kv', 'session', { k, ...(await aesSeal(k, DEK_RAW)), until: Date.now() + GRACE_MS });
  } catch (e) { console.warn('sin sesión', e); }
}
async function touchSession() {
  if (!LOCK || !DEK) return;
  const ses = await idb.get('kv', 'session').catch(() => null);
  if (ses) await idb.set('kv', 'session', { ...ses, until: Date.now() + GRACE_MS });
}
async function resumeSession() {
  const ses = await idb.get('kv', 'session').catch(() => null);
  if (!ses) return false;
  if (!(ses.until > Date.now())) { await idb.del('kv', 'session'); return false; }
  try { DEK_RAW = await aesOpen(ses.k, ses); DEK = await importAes(DEK_RAW); return true; }
  catch { await idb.del('kv', 'session'); return false; }
}
const endSession = () => idb.del('kv', 'session').catch(() => {});

// ---------- Bloqueo con PIN y huella ----------
let LOCK = null;   // { pin: {salt, iter, iv, data}, bio?: {credId, prfSalt, iv, data} } — la DEK envuelta, nunca el PIN
async function checkPin(pin) {
  try { await aesOpen(await pinKey(pin, unb64(LOCK.pin.salt), LOCK.pin.iter), LOCK.pin); return true; } catch { return false; }
}
async function enableLock() {
  const pin = await askPassword({ title: 'Elegí un PIN', hint: 'De 6 a 12 números. Te lo va a pedir cada vez que abras la app. Si lo olvidás, solo recuperás tus datos con una copia.', confirm2: true, pin: true });
  if (!pin) return;
  toast('Cifrando tus datos…');
  DEK_RAW = crypto.getRandomValues(new Uint8Array(32)); DEK = await importAes(DEK_RAW);
  LOCK = { v: 1, pin: await wrapWithPin(pin) };
  await idb.set('kv', 'lock', LOCK);
  await resealAll(null);
  await startSession();
  render(); toast('Bloqueo activado: tus datos quedan cifrados');
}
async function disableLock() {
  if (!(await askPassword({ title: 'Desactivar bloqueo', hint: 'Ingresá tu PIN actual.', pin: true, check: checkPin }))) return;
  const prev = DEK; DEK = null; DEK_RAW = null;
  await resealAll(prev);
  await idb.del('kv', 'lock'); LOCK = null; await endSession();
  render(); toast('Bloqueo desactivado');
}
async function changePin() {
  if (!(await askPassword({ title: 'PIN actual', hint: 'Ingresá tu PIN actual.', pin: true, check: checkPin }))) return;
  const pin = await askPassword({ title: 'PIN nuevo', hint: 'De 6 a 12 números.', confirm2: true, pin: true });
  if (!pin) return;
  LOCK.pin = await wrapWithPin(pin); await idb.set('kv', 'lock', LOCK);
  toast('PIN cambiado');
}
async function enableBio() {
  try {
    const prfSalt = crypto.getRandomValues(new Uint8Array(32));
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'Mis Gastos', id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Mis Gastos', displayName: 'Mis Gastos' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000, extensions: { prf: {} },
    } });
    if (cred.getClientExtensionResults()?.prf?.enabled === false) throw new Error('prf');
    const credId = new Uint8Array(cred.rawId);
    S.extAt = Date.now();
    const secret = await bioSecret(credId, prfSalt);
    LOCK.bio = { credId: b64(credId), prfSalt: b64(prfSalt), ...(await aesSeal(await prfKey(secret), DEK_RAW)) };
    await idb.set('kv', 'lock', LOCK); render();
    toast('Listo, ya podés desbloquear con tu huella');
  } catch (e) {
    toast(e.name === 'NotAllowedError' ? 'Cancelado' : 'Tu celular no permite usar la huella en esta app. Seguí con el PIN.');
  }
}
async function disableBio() { delete LOCK.bio; await idb.set('kv', 'lock', LOCK); render(); toast('Huella desactivada'); }
function showLock() {
  return new Promise((resolve) => {
    $('lock').hidden = false; $('lock-bio').hidden = !LOCK.bio; $('lock-err').textContent = '';
    let fails = 0, until = 0;
    const finish = () => { $('lock').hidden = true; $('lock-pin').value = ''; resolve(); };
    const tryPin = async () => {
      if (Date.now() < until) return ($('lock-err').textContent = `Esperá ${Math.ceil((until - Date.now()) / 1000)} segundos`);
      const pin = $('lock-pin').value; if (!pin) return;
      $('lock-err').textContent = 'Verificando…'; $('lock-go').disabled = true;
      try { await unlockWithPin(LOCK, pin); await startSession(); finish(); }
      catch {
        fails++; $('lock-pin').value = '';
        $('lock-err').textContent = 'PIN incorrecto';
        if (fails >= 5) { until = Date.now() + 30000 * (fails - 4); $('lock-err').textContent = `Demasiados intentos. Esperá ${30 * (fails - 4)} segundos`; }
      } finally { $('lock-go').disabled = false; }
    };
    const tryBio = async () => {
      try { await unlockWithBio(LOCK); await startSession(); finish(); }
      catch (e) { $('lock-err').textContent = e.name === 'NotAllowedError' ? '' : 'No se pudo usar la huella. Usá el PIN.'; }
    };
    $('lock-go').onclick = tryPin;
    $('lock-pin').onkeydown = (e) => { if (e.key === 'Enter') tryPin(); };
    $('lock-bio').onclick = tryBio;
    $('lock-forgot').onclick = async () => {
      if (!confirm('Sin el PIN no hay forma de abrir los datos de este celular, ni siquiera para nosotros. ¿Borrarlos y empezar de nuevo? Después podés restaurar una copia cifrada desde Ajustes.')) return;
      await idb.clear('kv'); await idb.clear('receipts'); location.reload();
    };
    // Con huella activada, abre el lector solo al entrar; si se cancela, queda el PIN y el botón «Usar huella».
    if (LOCK.bio) setTimeout(tryBio, 250); else setTimeout(() => $('lock-pin').focus(), 100);
  });
}
// Se vuelve a bloquear después de 10 minutos sin usar la app (en segundo plano o cerrada).
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); touchSession(); return; }
  if (LOCK && hiddenAt && Date.now() - hiddenAt > GRACE_MS) location.reload();
  else touchSession();
});
window.addEventListener('pagehide', () => touchSession());

// ---------- Importar estado de cuenta (CSV) ----------
function parseCSV(text) {
  text = text.replace(/^\ufeff/, '');
  const first = text.split(/\r?\n/).slice(0, 12).join('\n');
  const delim = [';', ',', '\t', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}
function parseDateAny(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    if (Number(m[2]) > 12 || Number(m[1]) > 31) return '';
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return '';
}
function parseMoney(s) {
  s = String(s || '').replace(/[^\d,.\-()]/g, '');
  if (!s) return NaN;
  const neg = /^\(.*\)$/.test(s) || s.includes('-');
  s = s.replace(/[()\-]/g, '');
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > ld) s = s.replace(/\./g, '').replace(',', '.');           // 1.234,56
  else if (ld > lc && lc >= 0) s = s.replace(/,/g, '');               // 1,234.56
  else if (lc < 0 && /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // 100.000
  const n = parseFloat(s);
  return neg ? -n : n;
}
const CAT_RULES = [
  ['Sueldo', /sueldo|salario|haberes|n[oó]mina/],
  ['Comida', /super|tienda inglesa|disco|devoto|ta-?ta|el dorado|macro ?mercado|frigo|restaur|pedidos ?ya|rappi|mc ?donald|burger|pizz|caf[eé]|panader|almac[eé]n|carnicer|verduler|chivit/],
  ['Transporte', /ancap|petrobras|axion|disa|uber|cabify|stm|cutcsa|copsa|peaje|telepeaje|nafta|combustible|estaciona|taxi|buquebus|cot /],
  ['Servicios', /\bute\b|\bose\b|antel|movistar|claro|internet|tel[eé]fono|seguro|gastos comunes|contribuci|tributo|imm|intendencia/],
  ['Ocio', /netflix|spotify|disney|hbo|max |prime video|youtube|cine|movie|steam|playstation|xbox|teatro|tickantel|bar /],
  ['Salud', /farmacia|farmashop|san roque|mutualista|m[eé]dic|hospital|sanatorio|cl[ií]nica|odont|[oó]ptica|casmu|smi|cosem|medica uruguaya/],
  ['Casa', /alquiler|sodimac|ferreter|ikea|barraca|mueble|hogar|limpieza/],
  ['Compras', /amazon|mercado ?libre|mercadopago|zara|shein|temu|aliexpress|tienda|shopping|ropa|calzado|electro/],
];
function guessCategory(desc, income) {
  const d = desc.toLowerCase();
  const same = S.expenses.find((e) => (e.note || '').toLowerCase() === d && isIncome(e) === income);
  if (same) return same.category;
  if (income) return /sueldo|salario|haberes|n[oó]mina/.test(d) ? 'Sueldo' : 'Otros ingresos';
  const hit = CAT_RULES.find(([c, re]) => c !== 'Sueldo' && re.test(d));
  return hit ? hit[0] : 'Otros';
}
const IMP = { rows: [], header: [], own: false };
function pickImport() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.csv,.txt,text/csv,text/plain'; S.extAt = Date.now();
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    let text = await f.text();
    if (text.includes('\ufffd')) text = new TextDecoder('windows-1252').decode(await f.arrayBuffer());   // bancos que exportan en Latin-1
    const rows = parseCSV(text);
    // La fila de encabezado es la última antes de la primera fila que tiene una fecha.
    let h = rows.findIndex((r, i) => i > 0 && r.some((c) => parseDateAny(c)) && !rows[i - 1].some((c) => parseDateAny(c)));
    if (h < 0) h = rows.findIndex((r) => r.some((c) => parseDateAny(c)));
    if (h < 0) return toast('No encontré fechas en ese archivo. ¿Es un CSV del banco?');
    const hasHeader = h > 0;
    IMP.header = hasHeader ? rows[h - 1].map((c, i) => c || `Columna ${i + 1}`) : rows[h].map((_, i) => `Columna ${i + 1}`);
    IMP.rows = rows.slice(h).filter((r) => r.some((c) => parseDateAny(c)));
    const norm = IMP.header.map((c) => c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
    const find = (re, not) => norm.findIndex((c) => re.test(c) && !(not && not.test(c)));
    IMP.own = norm.includes('tipo') && norm.includes('categoria');
    const opts = IMP.header.map((c, i) => `<option value="${i}">${esc(c)}</option>`).join('');
    ['i-date', 'i-desc', 'i-amount', 'i-credit'].forEach((id) => ($(id).innerHTML = opts));
    const sample = IMP.rows[0] || [];
    const dateCol = Math.max(0, find(/fecha|date/, /valor/) >= 0 ? find(/fecha|date/, /valor/) : sample.findIndex((c) => parseDateAny(c)));
    const descCol = IMP.own ? norm.indexOf('nota') : find(/desc|concepto|detalle|referencia|movimiento|comercio|nota/);
    const debit = find(/debito|cargo|egreso|retiro/), credit = find(/credito|abono|ingreso|deposito/);
    const amountCol = IMP.own ? norm.findIndex((c) => c.startsWith('monto ')) : find(/importe|monto|amount|valor/, /saldo/);
    $('i-date').value = dateCol;
    $('i-desc').value = descCol >= 0 ? descCol : sample.findIndex((c, i) => i !== dateCol && isNaN(parseMoney(c)));
    if (debit >= 0 && credit >= 0) { $('i-mode').value = 'split'; $('i-amount').value = debit; $('i-credit').value = credit; }
    else { $('i-mode').value = 'signed'; $('i-amount').value = amountCol >= 0 ? amountCol : sample.findIndex((c, i) => i !== dateCol && !isNaN(parseMoney(c))); }
    $('i-acc').innerHTML = S.accounts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('') + S.cards.map((c) => `<option value="${c.id}">💳 ${esc(c.name)}</option>`).join('');
    $('i-file').textContent = `${f.name} · ${plural(IMP.rows.length, 'fila')}`;
    $('i-mode').closest('label').hidden = IMP.own;
    updateImport();
    $('isheet').showModal();
  };
  inp.click();
}
function importItems() {
  const di = Number($('i-date').value), ni = Number($('i-desc').value), ai = Number($('i-amount').value), ci = Number($('i-credit').value);
  const mode = $('i-mode').value, method = $('i-acc').value, acc = account(method);
  const norm = IMP.header.map((c) => c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  const ti = norm.indexOf('tipo'), ki = norm.indexOf('categoria');
  const seen = new Set(S.expenses.map((e) => `${e.date}|${r2(Number(e.amount))}|${(e.note || '').toLowerCase()}`));
  return IMP.rows.map((r) => {
    const date = parseDateAny(r[di]);
    let amt;
    if (mode === 'split') { const d = parseMoney(r[ai]), c = parseMoney(r[ci]); amt = (c > 0 ? c : 0) - (Math.abs(d) > 0 ? Math.abs(d) : 0); }
    else amt = parseMoney(r[ai]);
    if (mode === 'expense') amt = -Math.abs(amt);
    let income = amt > 0;
    if (IMP.own && ti >= 0) { income = /ingreso/i.test(r[ti]); amt = Math.abs(amt); }
    const note = String(r[ni] || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const amount = r2(Math.abs(amt));
    const valid = date && amount > 0;
    let category = IMP.own && ki >= 0 && allCats().some((c) => c.name === r[ki]) ? r[ki] : guessCategory(note, income);
    if (!income && incCats().some((c) => c.name === category)) category = 'Otros';
    const k = `${date}|${amount}|${note.toLowerCase()}`;
    const dup = seen.has(k); seen.add(k);
    return { valid, dup, e: { id: uid(), type: income ? 'income' : 'expense', amount, category, date, note, method: income && !acc ? CASH : method,
      installments: 1, currency: acc && accUSD(acc) ? USD : '', rate: acc && accUSD(acc) ? S.cfg.usdRate || '' : '', source: 'import' } };
  });
}
function updateImport() {
  const split = $('i-mode').value === 'split';
  $('i-credit-row').hidden = !split || IMP.own; $('i-amount-label').textContent = split ? 'Débito' : 'Monto';
  const items = importItems(), ok = items.filter((x) => x.valid && !x.dup);
  $('i-count').textContent = `${plural(ok.length, 'movimiento')} para importar${items.some((x) => x.dup) ? ` · ${plural(items.filter((x) => x.dup).length, 'repetido')}` : ''}`;
  $('i-go').disabled = !ok.length;
  $('i-preview').innerHTML = items.slice(0, 8).map(({ valid, dup, e }) => `<div class="row with-icon ${valid && !dup ? '' : 'skip'}">
    ${icon(cat(e.category))}<span class="ri"><b>${esc(e.note || e.category)}</b><small>${valid ? `${esc(e.category)} · ${esc(e.date)}${dup ? ' · repetido' : ''}` : 'Fila sin fecha o monto'}</small></span>
    <span class="amt ${e.type === 'income' ? 'income' : ''}">${e.type === 'income' ? '+' : '-'}${fmtCur(e.amount, e.currency)}</span></div>`).join('')
    + (items.length > 8 ? `<div class="row"><small>y ${items.length - 8} más…</small></div>` : '');
}
function doImport() {
  const ok = importItems().filter((x) => x.valid && !x.dup).map((x) => x.e);
  if (!ok.length) return;
  $('isheet').close();
  undoable(`${plural(ok.length, 'movimiento')} importado${ok.length === 1 ? '' : 's'}`, () => {
    const now = new Date().toISOString();
    ok.forEach((e) => { e.updated = now; S.expenses.push(e); });
    enqueue();
  });
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
    'scan-ticket': scanTicket,
    'paste-cfe': pasteCfe,
    'new-fixed': () => openExpense(null, true),
    'edit-expense': () => openExpense(el.dataset.id),
    'close-sheet': () => $('sheet').close(),
    'set-type': () => { S.selType = el.dataset.type; applyType(); },
    'set-cur': () => { S.selCur = el.dataset.cur; if (S.selCur === USD && !$('f-rate').value && S.cfg.usdRate) $('f-rate').value = String(S.cfg.usdRate).replace('.', ','); updateRec(); },
    'refresh-rate': () => fetchRate(true),
    'pick-cat': () => { S.selCat = el.dataset.cat; renderCatGrid(); },

    'new-account': () => openAccount(),
    'edit-account': () => openAccount(el.dataset.id),
    'close-asheet': () => $('asheet').close(),
    'open-yield': () => openYield(S.editingAccountId),
    'close-ysheet': () => $('ysheet').close(),
    'save-yield': saveYield,
    'save-name': () => saveName($('n-name').value),
    'open-debt': () => openDebt(el.dataset.id),
    'edit-debt': () => openDebt(null, el.dataset.id),
    'close-dsheet': () => $('dsheet').close(),
    'save-debt': saveDebt,
    'delete-debt': () => { const id = S.editingDebt; $('dsheet').close(); undoable('Deuda eliminada', () => { S.expenses = S.expenses.filter((x) => x.id !== id); persist(); render(); }); },
    'd-kind': () => { S.debtKind = el.dataset.kind; updateDebt(); },
    'd-cur': () => { S.debtCur = el.dataset.cur; updateDebt(); },
    'new-cat': () => openCat(null, $('sheet').open ? S.selType : null),
    'edit-cat': () => openCat(el.dataset.id),
    'close-ksheet': () => $('ksheet').close(),
    'save-cat': saveCat,
    'delete-cat': deleteCat,
    'k-type': () => { S.catDraft.type = el.dataset.type; renderCatPreview(); },
    'k-emoji': () => { S.catDraft.emoji = el.dataset.e; $('k-emoji').value = el.dataset.e; renderCatPreview(); },
    'k-color': () => { S.catDraft.color = el.dataset.c; $('k-custom-color').value = el.dataset.c; renderCatPreview(); },
    'skip-name': () => saveName(''),
    'yield-estimate': () => { const a = account(S.yieldAcc); const tna = parseAmount($('y-tna').value); const { est, bal } = yieldEstimate(a, tna); $('y-balance').value = numStr(r2(bal + est)); updateYield(); },
    'save-account': saveAccount,
    'delete-account': () => {
      const id = S.editingAccountId;
      const used = [...S.expenses, ...S.recurring].some((e) => e.method === id) || S.transfers.some((t) => t.from === id || t.to === id);
      if (!confirm(used ? '¿Eliminar esta cuenta? Sus gastos e ingresos pasan a Efectivo y se borran sus transferencias.' : '¿Eliminar esta cuenta?')) return;
      undoable('Cuenta eliminada', () => {
      S.expenses.filter((e) => e.method === id).forEach((e) => upsertExpense({ ...e, method: CASH }));
      S.recurring.filter((r) => r.method === id).forEach((r) => upsertRecurring({ ...r, method: CASH }));
      S.transfers.filter((t) => t.from === id || t.to === id).forEach((t) => deleteTransfer(t.id));
      S.cards.filter((c) => c.payFrom === id || c.payFromUSD === id).forEach((c) => upsertCard({ ...c, payFrom: c.payFrom === id ? '' : c.payFrom, payFromUSD: c.payFromUSD === id ? '' : c.payFromUSD }));
      deleteAccount(id);
      });
      $('asheet').close();
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
    'delete-transfer': () => { const id = S.editingTransferId; $('tsheet').close(); $('psheet').close(); undoable('Eliminado', () => deleteTransfer(id)); },
    'pay-card': () => openPay(el.dataset.id),
    'close-psheet': () => $('psheet').close(),
    'pay-cur': () => { S.payCur = el.dataset.cur; if (!S.editingTransferId) $('p-from').value = payDefault(card(S.payCard), S.payCur); updatePay(true); },
    'pay-mode': () => { S.payMode = el.dataset.mode; updatePay(true); },
    'save-pay': savePay,
    'setup-done': () => { S.cfg.setupPending = false; persist(); render(); },
    'save-expense': () => { try { saveExpense(); } catch (err) { console.error(err); toast('No se pudo guardar: ' + (err?.message || err)); } },
    'delete-expense': () => {
      if (S.editingRule) {
        if (confirm('¿Eliminar este fijo? Desaparece de todos los meses. Para que deje de correr desde ahora, mejor poné un último mes.')) { const id = S.editingId; $('sheet').close(); undoable('Fijo eliminado', () => deleteRecurring(id)); }
      } else { const id = S.editingId, e = S.expenses.find((x) => x.id === id); $('sheet').close(); undoable(nInst(e || {}) > 1 ? 'Compra en cuotas eliminada' : 'Movimiento eliminado', () => deleteExpense(id)); }
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
      if (confirm(used ? 'Esta tarjeta tiene compras registradas. ¿Eliminarla igual? Las compras quedan como efectivo.' : '¿Eliminar esta tarjeta?')) undoable('Tarjeta eliminada', () => {
        S.expenses.filter((e) => e.method === S.editingCardId).forEach((e) => upsertExpense({ ...e, method: CASH, installments: 1 }));
        S.recurring.filter((r) => r.method === S.editingCardId).forEach((r) => upsertRecurring({ ...r, method: CASH }));
        deleteCard(S.editingCardId); $('csheet').close();
      });
    },
    'export': exportCSV,
    'backup': backup,
    'backup-later': () => { S.cfg.backupSnooze = new Date(Date.now() + 3 * 864e5).toISOString(); persist(); render(); },
    'restore': restore,
    'wipe': wipe,
    'undo-restore': () => { if (confirm('¿Volver a los datos que tenías antes de restaurar la copia?')) undoRestore(); },
    'add-receipt': pickReceipt,
    'view-receipt': viewReceipt,
    'del-receipt': () => { S.pendingReceipt = 'delete'; showReceiptPreview(null); },
    'close-rsheet': () => $('rsheet').close(),
    'import': pickImport,
    'close-isheet': () => $('isheet').close(),
    'do-import': doImport,
    'goto-month': () => { S.offset = Number(el.dataset.off); render(); },
    'lock-on': enableLock,
    'lock-off': disableLock,
    'lock-change': changePin,
    'bio-on': enableBio,
    'bio-off': disableBio,
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
  if (ev.target.id === 'y-balance') updateYield();
  if (['d-amount', 'd-left'].includes(ev.target.id)) updateDebt();
  if (ev.target.id === 'k-name') { S.catDraft.name = ev.target.value; renderCatPreview(); }
  if (ev.target.id === 'k-emoji') { S.catDraft.emoji = firstGrapheme(ev.target.value) || S.catDraft.emoji; renderCatPreview(); }
  if (ev.target.id === 'k-custom-color') { S.catDraft.color = ev.target.value; renderCatPreview(); }
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'cfg-currency') { S.cfg.currency = ev.target.value; S.cfg.usdRate = 0; S.cfg.rateDate = ''; persist(); setMoney(); render(); fetchRate(); }
  if (ev.target.id === 'cfg-nickname') { S.cfg.nickname = ev.target.value.trim().slice(0, 24); S.cfg.askedName = true; persist(); toast(S.cfg.nickname ? 'Nombre guardado' : 'Nombre borrado'); }
  if (ev.target.id === 'cfg-rate') {
    const r = parseAmount(ev.target.value);
    if (r > 0) { S.cfg.usdRate = r2(r); S.cfg.rateManual = true; S.cfg.rateDate = new Date().toISOString(); persist(); render(); toast('Cotización guardada'); }
  }
  if (ev.target.id === 'f-inst') updateInstHint();
  if (['t-from', 't-to'].includes(ev.target.id)) updateTransfer(true);
  if (ev.target.id === 'p-from') updatePay();
  if (['i-date', 'i-desc', 'i-mode', 'i-amount', 'i-credit', 'i-acc'].includes(ev.target.id)) updateImport();
  if (ev.target.id === 'a-type') updateAccountForm();
  if (ev.target.id === 'c-pay' && !S.editingCardId && !$('c-pay-usd-row').hidden) {
    const p = account(ev.target.value), sib = p && p.bank ? S.accounts.find((x) => accUSD(x) && x.bank === p.bank) : null;
    if (sib) $('c-pay-usd').value = sib.id;
  }
  if (ev.target.id === 'f-from') pickFrom(ev.target.value);
  if (ev.target.id === 'f-paid') { S.paidTouched = true; updatePaid(); }
  if (['f-rec', 'f-end-mode', 'f-end', 'f-date'].includes(ev.target.id)) updateRec();
});
['sheet', 'bsheet', 'csheet', 'asheet', 'tsheet', 'psheet', 'rsheet', 'isheet', 'ysheet', 'nsheet', 'ksheet', 'dsheet'].forEach((id) => $(id).addEventListener('click', (ev) => { if (ev.target.id === id) ev.target.close(); }));
$('f-amount').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') saveExpense(); });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()));
  // Cuando se instala una versión nueva, recarga una vez para mostrarla.
  let reloaded = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
}

// ---------- Migración a cuentas (v6) ----------
function ensureCash() {
  if (!Array.isArray(S.accounts)) S.accounts = [];
  if (!account(CASH)) S.accounts.unshift({ id: CASH, name: 'Efectivo', type: 'cash', currency: '', initial: 0, since: new Date().toISOString() });
}

// ---------- Arranque ----------
const LEGACY_KEYS = ['mg.expenses', 'mg.budgets', 'mg.cards', 'mg.recurring', 'mg.accounts', 'mg.transfers', 'mg.cfg', 'mg.queue', 'mg.lastSync'];
async function boot() {
  let rec;
  try {
    LOCK = (await idb.get('kv', 'lock')) || null;
    rec = await idb.get('kv', 'data');
    // v8: los datos pasan de localStorage a IndexedDB. Se borran de localStorage solo después de verificar la copia.
    if (!rec && ['mg.expenses', 'mg.cfg', 'mg.accounts'].some((k) => localStorage.getItem(k) !== null)) {
      const d = { expenses: legacy.get('mg.expenses', []), budgets: legacy.get('mg.budgets', {}), cards: legacy.get('mg.cards', []),
        recurring: legacy.get('mg.recurring', []), accounts: legacy.get('mg.accounts', null), transfers: legacy.get('mg.transfers', []),
        cfg: legacy.get('mg.cfg', {}) };
      await idb.set('kv', 'data', { v: 1, plain: d });
      rec = await idb.get('kv', 'data');
      if (JSON.stringify(rec?.plain) === JSON.stringify(d)) LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
    }
  } catch (e) {
    console.error(e);
    document.body.insertAdjacentHTML('afterbegin', '<p class="footer-note center" style="padding:40px 20px">Este navegador no permite guardar datos. Abrí Mis Gastos en Chrome, sin modo incógnito.</p>');
    return;
  }
  if (LOCK && !(await resumeSession())) await showLock();
  else if (LOCK) touchSession();
  const d = (await unseal(rec)) || {};
  DATA_KEYS.forEach((k) => { if (d[k] !== undefined) S[k] = d[k]; });
  if (!Array.isArray(S.cats)) S.cats = [];
  S.cfg = { usdRate: 0, rateDate: '', currency: 'UYU', ...(d.cfg || {}) };
  S.receipts = new Set(await idb.keys('receipts'));
  S.hasPreRestore = !!(await idb.get('kv', 'preRestore'));

  if (!Array.isArray(S.accounts)) {
    ensureCash();
    const now = new Date().toISOString();
    S.cards.forEach((c) => { if (!c.since) c.since = now; });
    S.cfg.setupPending = true;
    persist();
  }
  ensureCash();
  // La sincronización con Google Sheets se retiró en v7.1: se limpia lo que haya quedado guardado.
  if (S.cfg.url || S.cfg.token) {
    ['url', 'token', 'sheetUrl', 'email'].forEach((k) => delete S.cfg[k]); persist();
    setTimeout(() => toast('Ahora tus datos quedan solo en tu celular. Guardá copias cifradas desde Ajustes.'), 800);
  }
  // Pide al navegador que no borre los datos por falta de espacio.
  if (navigator.storage?.persist) navigator.storage.persisted().then((p) => p || navigator.storage.persist());

  setMoney();
  show('home');
  if (rateStale()) fetchRate();
  cleanReceipts();
  if (!S.cfg.askedName) setTimeout(askName, 400);
}
$('nsheet').addEventListener('close', () => { if (!S.cfg.askedName) { S.cfg.askedName = true; persist(); } });
$('n-name').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); saveName($('n-name').value); } });
boot();
