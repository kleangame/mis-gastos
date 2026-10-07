/**
 * Mis Gastos — backend en Google Sheets.
 * Pegá este código en Extensiones > Apps Script de tu hoja y publicalo como App web.
 */
const TOKEN = 'CAMBIA-ESTA-CLAVE';   // Elegí una clave secreta y usá la misma en la app.

const SHEET_GASTOS = 'Gastos';
const SHEET_PRESUPUESTOS = 'Presupuestos';
const SHEET_TARJETAS = 'Tarjetas';
const SHEET_FIJOS = 'Fijos';
const SHEET_CUENTAS = 'Cuentas';
const SHEET_TRANSF = 'Transferencias';
// 'Gastos' guarda todos los movimientos: gastos e ingresos. medio = 'cash' o el id de la tarjeta.
// moneda vacía = moneda principal de la app; 'USD' = cargado en dólares (monto en USD, cotizacion = moneda local por 1 US$).
const H_GASTOS = ['id', 'fecha', 'monto', 'categoria', 'nota', 'actualizado', 'tipo', 'medio', 'cuotas', 'tarjeta', 'moneda', 'cotizacion'];
// Fijos: inicio y fin en formato AAAA-MM; fin vacío = para siempre.
const H_FIJOS = ['id', 'tipo', 'monto', 'categoria', 'nota', 'medio', 'dia', 'inicio', 'fin', 'actualizado', 'moneda', 'creado'];
const H_TARJETAS = ['id', 'nombre', 'limite', 'dia_cierre', 'actualizado', 'pagar_desde', 'desde'];
// Cuentas: tipo = bank | cash | savings | invest; moneda vacía = moneda principal. desde = cuándo se creó (el saldo inicial es a esa fecha).
const H_CUENTAS = ['id', 'nombre', 'tipo', 'moneda', 'saldo_inicial', 'desde', 'meta', 'meta_fecha', 'actualizado'];
// Transferencias: tipo = transfer | payment (pago de tarjeta) | adjust (ajuste de saldo). monto sale de 'desde'; monto_destino entra en 'hacia'.
const H_TRANSF = ['id', 'tipo', 'desde', 'hacia', 'monto', 'monto_destino', 'moneda_deuda', 'cotizacion', 'fecha', 'nota', 'creado', 'actualizado'];
const H_PRESUPUESTOS = ['categoria', 'monto'];

function doGet() {
  return json({ ok: true, app: 'Mis Gastos', mensaje: 'API funcionando. Usá POST desde la app.' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'JSON inválido' }); }
  if (req.token !== TOKEN) return json({ ok: false, error: 'Clave incorrecta' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (req.action === 'sync') {
      (req.ops || []).forEach(applyOp);
      return json({ ok: true, version: 6, expenses: readExpenses(), budgets: readBudgets(), cards: readCards(), recurring: readRecurring(),
        accounts: readAccounts(), transfers: readTransfers() });
    }
    return json({ ok: false, error: 'Acción desconocida' });
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function applyOp(op) {
  if (op.type === 'upsert') upsertExpense(op.expense);
  else if (op.type === 'delete') deleteRowById(sheet(SHEET_GASTOS, H_GASTOS), op.id);
  else if (op.type === 'budget') setBudget(op.category, Number(op.amount) || 0);
  else if (op.type === 'card') upsertCard(op.card);
  else if (op.type === 'recurring') upsertRecurring(op.rule);
  else if (op.type === 'deleteRecurring') deleteRowById(sheet(SHEET_FIJOS, H_FIJOS), op.id);
  else if (op.type === 'account') upsertAccount(op.account);
  else if (op.type === 'deleteAccount') deleteRowById(sheet(SHEET_CUENTAS, H_CUENTAS), op.id);
  else if (op.type === 'transfer') upsertTransfer(op.transfer);
  else if (op.type === 'deleteTransfer') deleteRowById(sheet(SHEET_TRANSF, H_TRANSF), op.id);
  else if (op.type === 'deleteCard') deleteRowById(sheet(SHEET_TARJETAS, H_TARJETAS), op.id);
}

function upsertExpense(x) {
  const sh = sheet(SHEET_GASTOS, H_GASTOS);
  const cardName = x.method && x.method !== 'cash' ? (findCardName(x.method) || '') : '';
  const row = [String(x.id), x.date, Number(x.amount), x.category, x.note || '', x.updated || new Date().toISOString(),
    x.type === 'income' ? 'ingreso' : 'gasto', x.method || 'cash', Number(x.installments) || 1, cardName,
    x.currency || '', Number(x.rate) || ''];
  const r = findRow(sh, String(x.id));
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

function setBudget(category, amount) {
  const sh = sheet(SHEET_PRESUPUESTOS, H_PRESUPUESTOS);
  const r = findRow(sh, category);
  if (amount > 0) {
    if (r) sh.getRange(r, 2).setValue(amount); else sh.appendRow([category, amount]);
  } else if (r) {
    sh.deleteRow(r);
  }
}

function upsertRecurring(r) {
  const sh = sheet(SHEET_FIJOS, H_FIJOS);
  // Prefijo ' para que Sheets no convierta "2026-04" en fecha.
  const row = [String(r.id), r.type === 'income' ? 'ingreso' : 'gasto', Number(r.amount), r.category, r.note || '',
    r.method || 'cash', Number(r.day) || 1, "'" + r.start, r.end ? "'" + r.end : '', r.updated || new Date().toISOString(), r.currency || '', r.created || ''];
  const i = findRow(sh, String(r.id));
  if (i) sh.getRange(i, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

function readRecurring() {
  const sh = sheet(SHEET_FIJOS, H_FIJOS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const ym = v => v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM') : String(v || '').replace(/^'/, '');
  return sh.getRange(2, 1, last - 1, H_FIJOS.length).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ id: String(r[0]), type: r[1] === 'ingreso' ? 'income' : 'expense', amount: Number(r[2]), category: String(r[3]),
      note: String(r[4] || ''), method: String(r[5] || 'cash'), day: Number(r[6]) || 1, start: ym(r[7]), end: ym(r[8]),
      updated: r[9] instanceof Date ? r[9].toISOString() : String(r[9] || ''), currency: String(r[10] || ''), created: txt(r[11]) }));
}

function upsertCard(c) {
  const sh = sheet(SHEET_TARJETAS, H_TARJETAS);
  const row = [String(c.id), c.name, Number(c.limit), c.closingDay || '', c.updated || new Date().toISOString(), c.payFrom || '', c.since ? "'" + c.since : ''];
  const r = findRow(sh, String(c.id));
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]);
  else sh.appendRow(row);
}

function findCardName(id) {
  const sh = sheet(SHEET_TARJETAS, H_TARJETAS);
  const r = findRow(sh, String(id));
  return r ? String(sh.getRange(r, 2).getValue()) : '';
}

function readCards() {
  const sh = sheet(SHEET_TARJETAS, H_TARJETAS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, H_TARJETAS.length).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ id: String(r[0]), name: String(r[1]), limit: Number(r[2]), closingDay: r[3] === '' ? '' : Number(r[3]),
      updated: r[4] instanceof Date ? r[4].toISOString() : String(r[4] || ''), payFrom: String(r[5] || ''), since: txt(r[6]) }));
}

function readExpenses() {
  const sh = sheet(SHEET_GASTOS, H_GASTOS);
  const tz = Session.getScriptTimeZone();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, H_GASTOS.length).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({
      id: String(r[0]),
      date: r[1] instanceof Date ? Utilities.formatDate(r[1], tz, 'yyyy-MM-dd') : String(r[1]),
      amount: Number(r[2]),
      category: String(r[3]),
      note: String(r[4] || ''),
      updated: r[5] instanceof Date ? r[5].toISOString() : String(r[5] || ''),
      type: r[6] === 'ingreso' ? 'income' : 'expense',
      method: String(r[7] || 'cash'),
      installments: Number(r[8]) || 1,
      currency: String(r[10] || ''),
      rate: Number(r[11]) || '',
    }));
}

function upsertAccount(a) {
  const sh = sheet(SHEET_CUENTAS, H_CUENTAS);
  const row = [String(a.id), a.name, a.type || 'bank', a.currency || '', Number(a.initial) || 0, a.since ? "'" + a.since : '',
    a.goal === '' || a.goal == null ? '' : Number(a.goal), a.goalDate ? "'" + a.goalDate : '', a.updated || new Date().toISOString()];
  const r = findRow(sh, String(a.id));
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
}
function readAccounts() {
  const sh = sheet(SHEET_CUENTAS, H_CUENTAS);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, H_CUENTAS.length).getValues().filter(r => r[0] !== '')
    .map(r => ({ id: String(r[0]), name: String(r[1]), type: String(r[2] || 'bank'), currency: String(r[3] || ''), initial: Number(r[4]) || 0,
      since: txt(r[5]), goal: r[6] === '' ? '' : Number(r[6]), goalDate: ym(r[7]), updated: txt(r[8]) }));
}
function upsertTransfer(t) {
  const sh = sheet(SHEET_TRANSF, H_TRANSF);
  const row = [String(t.id), t.kind || 'transfer', t.from || '', t.to || '', Number(t.amount) || 0, Number(t.toAmount) || 0, t.cur || '',
    Number(t.rate) || '', t.date, t.note || '', t.created ? "'" + t.created : '', t.updated || new Date().toISOString()];
  const r = findRow(sh, String(t.id));
  if (r) sh.getRange(r, 1, 1, row.length).setValues([row]); else sh.appendRow(row);
}
function readTransfers() {
  const sh = sheet(SHEET_TRANSF, H_TRANSF);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const tz = Session.getScriptTimeZone();
  return sh.getRange(2, 1, last - 1, H_TRANSF.length).getValues().filter(r => r[0] !== '')
    .map(r => ({ id: String(r[0]), kind: String(r[1] || 'transfer'), from: String(r[2] || ''), to: String(r[3] || ''), amount: Number(r[4]) || 0,
      toAmount: Number(r[5]) || 0, cur: String(r[6] || ''), rate: Number(r[7]) || '',
      date: r[8] instanceof Date ? Utilities.formatDate(r[8], tz, 'yyyy-MM-dd') : String(r[8]),
      note: String(r[9] || ''), created: txt(r[10]), updated: txt(r[11]) }));
}

function readBudgets() {
  const sh = sheet(SHEET_PRESUPUESTOS, H_PRESUPUESTOS);
  const last = sh.getLastRow();
  const out = {};
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 2).getValues().forEach(r => { if (r[0]) out[String(r[0])] = Number(r[1]); });
  return out;
}

// ---- utilidades ----
function txt(v) { return v instanceof Date ? v.toISOString() : String(v || '').replace(/^'/, ''); }
function ym(v) { return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM') : String(v || '').replace(/^'/, ''); }
function sheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (name === SHEET_GASTOS) sh.getRange('B:B').setNumberFormat('yyyy-mm-dd');
    if (name === SHEET_TRANSF) sh.getRange('I:I').setNumberFormat('yyyy-mm-dd');
    if (name !== SHEET_PRESUPUESTOS && name !== SHEET_CUENTAS && name !== SHEET_TRANSF) sh.getRange('C:C').setNumberFormat('#,##0.00');
  } else if (sh.getLastColumn() < headers.length) {
    // Hoja de una versión anterior: agrega las columnas nuevas.
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
  return sh;
}

function findRow(sh, key) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(key)) return i + 2;
  return 0;
}

function deleteRowById(sh, id) {
  const r = findRow(sh, id);
  if (r) sh.deleteRow(r);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
