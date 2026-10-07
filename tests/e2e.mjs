// Pruebas de punta a punta de Mis Gastos (Playwright + Chromium).
// Uso: python3 -m http.server 8123 & ; node tests/e2e.mjs
import { chromium } from 'playwright';
import fs from 'fs';
const URL = process.env.URL || 'http://localhost:8123/';
const DIR = new globalThis.URL('.', import.meta.url).pathname;
let failures = 0;
const ok = (c, msg) => { console.log(`${c ? '✓' : '✗'} ${msg}`); if (!c) failures++; };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
await ctx.addInitScript(() => { delete Navigator.prototype.canShare; delete Navigator.prototype.share; });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let dialogAnswers = [];
page.on('dialog', (d) => d.type() === 'confirm' ? (dialogAnswers.length ? (dialogAnswers.shift() ? d.accept() : d.dismiss()) : d.accept()) : d.accept());
const ready = () => page.waitForFunction(() => typeof S !== 'undefined' && document.querySelector('#view-home h1'));
const toastText = () => page.locator('#toast span').textContent();
const idbRaw = () => page.evaluate(() => new Promise((res) => { const r = indexedDB.open('mis-gastos'); r.onsuccess = () => { const t = r.result.transaction(['kv', 'receipts']); const out = {}; t.objectStore('kv').get('data').onsuccess = (e) => (out.data = e.target.result); t.objectStore('receipts').getAll().onsuccess = (e) => (out.receipts = e.target.result); t.oncomplete = () => res(JSON.stringify(out, (k, v) => (v instanceof Blob ? '[blob]' : v))); }; }));
const addExpense = async (amount, note, cat = 'Comida') => {
  await page.click('[data-tab="home"]');
  await page.click('#view-home [data-action="new-expense"]');
  await page.fill('#f-amount', amount); await page.click(`#f-cats [data-cat="${cat}"]`); await page.fill('#f-note', note);
  await page.click('[data-action="save-expense"]'); await page.waitForTimeout(150);
};

// 1. Migración desde localStorage
await page.goto(URL);
await ready();
await page.evaluate(async () => {
  await new Promise((r) => { const q = indexedDB.deleteDatabase('mis-gastos'); q.onsuccess = q.onerror = q.onblocked = r; });
  localStorage.setItem('mg.expenses', JSON.stringify([{ id: 'old1', type: 'expense', amount: 321, category: 'Salud', date: new Date().toISOString().slice(0, 10), note: 'Farmacia vieja', method: 'cash', installments: 1, currency: '', rate: '' }]));
  localStorage.setItem('mg.accounts', JSON.stringify([{ id: 'cash', name: 'Efectivo', type: 'cash', currency: '', initial: 0 }]));
  localStorage.setItem('mg.cfg', JSON.stringify({ currency: 'UYU', usdRate: 40 }));
});
await page.reload(); await ready();
ok(await page.locator('text=Farmacia vieja').count() > 0, 'migra los datos de localStorage a IndexedDB');
ok(await page.evaluate(() => localStorage.getItem('mg.expenses')) === null, 'borra la copia vieja de localStorage después de verificar');
ok((await idbRaw()).includes('Farmacia vieja'), 'los datos quedan en IndexedDB');

// 2. Agregar, eliminar y deshacer
await addExpense('150', 'Almuerzo');
ok(await page.locator('#view-home >> text=Almuerzo').count() > 0, 'agrega un gasto');
await page.click('#view-home >> text=Almuerzo'); await page.click('[data-action="delete-expense"]');
ok((await toastText()).includes('eliminado'), 'eliminar muestra aviso con Deshacer');
ok(await page.locator('#view-home >> text=Almuerzo').count() === 0, 'el gasto desaparece');
await page.click('#toast button'); await page.waitForTimeout(300);
ok(await page.locator('#view-home >> text=Almuerzo').count() > 0, 'Deshacer lo recupera');
await page.reload(); await ready();
ok(await page.locator('#view-home >> text=Almuerzo').count() > 0, 'lo recuperado queda guardado tras recargar');

// 3. Alertas de presupuesto y gráfico
await page.evaluate(() => { S.budgets = { Comida: 1000 }; persist(); render(); });
await addExpense('700', 'Super');
ok((await toastText()).includes('85%'), 'avisa al pasar el 80% del presupuesto');
await addExpense('300', 'Cena');
ok((await toastText()).includes('Te pasaste'), 'avisa al pasarse del presupuesto');
ok(await page.locator('#view-home .alert.over').count() === 1, 'Resumen muestra la alerta de presupuesto');
ok(await page.locator('#view-home svg.bars g').count() === 6, 'Resumen muestra el gráfico de 6 meses');

// 4. Foto del recibo
await page.click('#view-home >> text=Cena');
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#f-receipt-add')]);
await fc.setFiles(DIR + 'recibo.png');
await page.waitForSelector('#f-receipt-prev:not([hidden])');
await page.click('[data-action="save-expense"]'); await page.waitForTimeout(300);
await page.reload(); await ready();
ok(await page.locator('#view-home >> text=📎').count() > 0, 'el movimiento muestra 📎');
await page.click('#view-home >> text=Cena');
await page.waitForSelector('#f-receipt-prev:not([hidden])', { timeout: 3000 }).catch(() => {});
ok(await page.locator('#f-receipt-prev').isVisible(), 'la foto del recibo se guarda y se ve al reabrir');
await page.click('[data-action="close-sheet"]');

// 5. Importar CSV del banco
await page.click('[data-tab="settings"]');
const [fc2] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="import"]')]);
await fc2.setFiles(DIR + 'banco.csv');
await page.waitForSelector('#isheet[open]');
ok((await page.locator('#i-count').textContent()).startsWith('4 movimientos'), 'detecta encabezado, débito/crédito y repetidos (4 de 5)');
await page.click('#i-go');
const imp = await page.evaluate(() => S.expenses.filter((e) => e.source === 'import').map((e) => `${e.category}:${e.type}:${e.amount}`).sort());
ok(JSON.stringify(imp) === JSON.stringify(['Comida:expense:1250.5', 'Ocio:expense:450', 'Sueldo:income:45000', 'Transporte:expense:2000']), 'importa montos y adivina categorías: ' + imp.join(', '));

// 6. Copia cifrada, borrar con aviso, restaurar
await page.click('[data-tab="settings"]');
const dl = page.waitForEvent('download');
await page.click('[data-action="backup"]');
await page.fill('#pw-1', 'clave-segura-1'); await page.fill('#pw-2', 'clave-segura-1'); await page.click('#pw-ok');
const file = DIR + 'tmp-backup.json'; await (await dl).saveAs(file);
const box = JSON.parse(fs.readFileSync(file, 'utf8'));
ok(box.enc && !fs.readFileSync(file, 'utf8').includes('Almuerzo'), 'la copia está cifrada');
const nBefore = await page.evaluate(() => S.expenses.length);
dialogAnswers = [true]; // confirma borrar (no hay cambios sin copia)
await page.click('[data-action="wipe"]'); await page.waitForTimeout(200);
ok(await page.evaluate(() => S.expenses.length) === 0, 'borrar deja la app vacía');
await addExpense('99', 'Nuevo tras borrar');
await page.click('[data-tab="settings"]');
const [fc3] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="restore"]')]);
await fc3.setFiles(file);
await page.fill('#pw-1', 'mala'); await page.click('#pw-ok'); await page.waitForTimeout(800);
ok((await toastText()) === 'Contraseña incorrecta', 'rechaza contraseña incorrecta');
const [fc4] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="restore"]')]);
await fc4.setFiles(file);
dialogAnswers = [false, true]; // "¿guardar copia antes?" → no; "¿reemplazar?" → sí
await page.fill('#pw-1', 'clave-segura-1'); await page.click('#pw-ok'); await page.waitForTimeout(1500);
ok(await page.evaluate(() => S.expenses.length) === nBefore, 'restaura todos los movimientos');
ok(await page.evaluate(() => S.receipts.size) === 1, 'restaura la foto del recibo');
await page.click('[data-tab="settings"]');
ok(await page.locator('[data-action="undo-restore"]').count() === 1, 'ofrece volver a los datos de antes de restaurar');
dialogAnswers = [true];
await page.click('[data-action="undo-restore"]'); await page.waitForTimeout(800);
ok(await page.evaluate(() => S.expenses.map((e) => e.note).join()) === 'Nuevo tras borrar', 'vuelve a los datos previos a la restauración');
await page.click('[data-tab="settings"]');
const [fc5] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-action="restore"]')]);
await fc5.setFiles(file); dialogAnswers = [false, true];
await page.fill('#pw-1', 'clave-segura-1'); await page.click('#pw-ok'); await page.waitForTimeout(1500);

// 7. Bloqueo con PIN y cifrado local
await page.click('[data-tab="settings"]');
await page.click('[data-action="lock-on"]');
await page.fill('#pw-1', '1234'); await page.fill('#pw-2', '1234'); await page.click('#pw-ok');
ok((await page.locator('#pw-err').textContent()).includes('entre 6 y 12'), 'exige PIN de 6 a 12 números');
await page.fill('#pw-1', '246810'); await page.fill('#pw-2', '246810'); await page.click('#pw-ok');
await page.waitForFunction(() => LOCK && !document.querySelector('#pwsheet[open]'), null, { timeout: 15000 });
await page.waitForTimeout(800);
const raw = await idbRaw();
ok(!raw.includes('Almuerzo') && !raw.includes('[blob]') && raw.includes('"enc"'), 'datos y fotos quedan cifrados en el celular');
await page.reload();
await page.waitForSelector('#lock:not([hidden])');
ok(await page.locator('#view-home h1').count() === 0, 'al abrir pide el PIN sin mostrar datos');
await page.fill('#lock-pin', '000000'); await page.click('#lock-go');
await page.waitForFunction(() => document.querySelector('#lock-err').textContent === 'PIN incorrecto', null, { timeout: 15000 });
ok(true, 'rechaza PIN incorrecto');
await page.fill('#lock-pin', '246810'); await page.click('#lock-go');
await ready();
ok(await page.locator('#view-home >> text=Almuerzo').count() > 0, 'con el PIN correcto se ven los datos');
await page.click('#view-home >> text=Cena');
await page.waitForSelector('#f-receipt-prev:not([hidden])', { timeout: 3000 }).catch(() => {});
ok(await page.locator('#f-receipt-prev').isVisible(), 'la foto cifrada se abre con el PIN');
await page.click('[data-action="close-sheet"]');
await addExpense('55', 'Con bloqueo');
await page.reload(); await page.fill('#lock-pin', '246810'); await page.click('#lock-go'); await ready();
ok(await page.locator('#view-home >> text=Con bloqueo').count() > 0, 'lo cargado con bloqueo se guarda cifrado y se recupera');
await page.click('[data-tab="settings"]');
await page.click('[data-action="lock-off"]');
await page.fill('#pw-1', '246810'); await page.click('#pw-ok');
await page.waitForFunction(() => !LOCK, null, { timeout: 15000 }); await page.waitForTimeout(500);
await page.reload(); await ready();
ok(await page.locator('#lock:not([hidden])').count() === 0 && await page.locator('#view-home >> text=Con bloqueo').count() > 0, 'desactivar el bloqueo deja los datos sin cifrar y accesibles');

for (const t of ['list', 'cards', 'budgets', 'settings', 'home']) await page.click(`[data-tab="${t}"]`);
ok(errors.length === 0, 'sin errores de JavaScript' + (errors.length ? ': ' + errors.join(' | ') : ''));
fs.rmSync(file, { force: true });
await browser.close();
console.log(failures ? `\n${failures} prueba(s) fallaron` : '\nTodas las pruebas pasaron');
process.exit(failures ? 1 : 0);
