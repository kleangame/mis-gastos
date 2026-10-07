/**
 * Mis Gastos — backend en Google Sheets.
 * Pegá este código en Extensiones > Apps Script de tu hoja y publicalo como App web.
 */
const TOKEN = 'CAMBIA-ESTA-CLAVE';   // Elegí una clave secreta y usá la misma en la app.

const SHEET_GASTOS = 'Gastos';
const SHEET_PRESUPUESTOS = 'Presupuestos';
const SHEET_TARJETAS = 'Tarjetas';
const SHEET_FIJOS = 'Fijos';
// 'Gastos' guarda todos los movimientos: gastos e ingresos. medio = 'cash' o el id de la tarjeta.
const H_GASTOS = ['id', 'fecha', 'monto', 'categoria', 'nota', 'actualizado', 'tipo', 'medio', 'cuotas', 'tarjeta'];
// Fijos: inicio y fin en formato AAAA-MM; fin vacío = para siempre.
const H_FIJOS = ['id', 'tipo', 'monto', 'categoria', 'nota', 'medio', 'dia', 'inicio', 'fin', 'actualizado'];
const H_TARJETAS = ['id', 'nombre', 'limite', 'dia_cierre', 'actualizado'];
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
      return json({ ok: true, expenses: readExpenses(), budgets: readBudgets(), cards: readCards(), recurring: readRecurring() });
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
  else if (op.type === 'deleteCard') deleteRowById(sheet(SHEET_TARJETAS, H_TARJETAS), op.id);
}

function upsertExpense(x) {
  const sh = sheet(SHEET_GASTOS, H_GASTOS);
  const cardName = x.method && x.method !== 'cash' ? (findCardName(x.method) || '') : '';
  const row = [String(x.id), x.date, Number(x.amount), x.category, x.note || '', x.updated || new Date().toISOString(),
    x.type === 'income' ? 'ingreso' : 'gasto', x.method || 'cash', Number(x.installments) || 1, cardName];
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
    r.method || 'cash', Number(r.day) || 1, "'" + r.start, r.end ? "'" + r.end : '', r.updated || new Date().toISOString()];
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
      updated: r[9] instanceof Date ? r[9].toISOString() : String(r[9] || '') }));
}

function upsertCard(c) {
  const sh = sheet(SHEET_TARJETAS, H_TARJETAS);
  const row = [String(c.id), c.name, Number(c.limit), c.closingDay || '', c.updated || new Date().toISOString()];
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
      updated: r[4] instanceof Date ? r[4].toISOString() : String(r[4] || '') }));
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
    }));
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
function sheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (name === SHEET_GASTOS) sh.getRange('B:B').setNumberFormat('yyyy-mm-dd');
    if (name !== SHEET_PRESUPUESTOS) sh.getRange('C:C').setNumberFormat('#,##0.00');
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
