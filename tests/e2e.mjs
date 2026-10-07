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
await page.waitForSelector('#nsheet[open]', { timeout: 3000 }).catch(() => {});
ok(await page.locator('#nsheet[open]').count() === 1, 'la primera vez pregunta el nombre (opcional)');
await page.fill('#n-name', 'Kle'); await page.click('[data-action="save-name"]');
ok((await page.locator('#view-home .greet').textContent()).includes('Kle'), 'saluda con el apodo arriba a la izquierda');
ok(await page.locator('text=Farmacia vieja').count() > 0, 'migra los datos de localStorage a IndexedDB');
ok(await page.evaluate(() => localStorage.getItem('mg.expenses')) === null, 'borra la copia vieja de localStorage después de verificar');
ok((await idbRaw()).includes('Farmacia vieja'), 'los datos quedan en IndexedDB');

// 2. Agregar, eliminar y deshacer
await addExpense('150', 'Almuerzo');
ok(await page.locator('#view-home >> text=Almuerzo').count() > 0, 'agrega un gasto');
await page.click('#view-home >> text=Almuerzo'); await page.click('[data-action="delete-expense"]');
ok((await toastText()).includes('eliminado'), 'eliminar muestra aviso con Deshacer');
ok(await page.locator('#view-home >> text=Almuerzo').count() === 0, 'el gasto desaparece');
await page.click('#toast button'); await page.waitForTimeout(200); await page.waitForTimeout(300);
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

// 3b. Rendimiento estimado y real
await page.evaluate(() => { const a = { id: 'prex', name: 'Prex', type: 'savings', currency: '', initial: 100000, since: '2026-01-01T00:00:00Z', tna: 3.65, yieldFrom: isoDate(new Date(Date.now() - 10 * 864e5)) }; S.accounts.push(a); persist(); render(); });
const est = await page.evaluate(() => yieldEstimate(account('prex')).est);
ok(est > 99 && est < 101, 'estima el rendimiento con la tasa (~100 en 10 días): ' + est);
await page.click('[data-tab="cards"]');
ok((await page.locator('[data-id="prex"]').textContent()).includes('(estimado)'), 'Cuentas muestra el rendimiento estimado');
await page.click('[data-id="prex"]'); await page.click('#a-yield-btn');
await page.fill('#y-balance', '100120'); await page.dispatchEvent('#y-balance', 'input');
ok((await page.locator('#y-diff').textContent()).includes('120'), 'permite escribir el saldo real y calcula la diferencia');
await page.click('[data-action="save-yield"]');
const yr = await page.evaluate(() => ({ bal: accountBalance(account('prex')), inc: S.expenses.filter((e) => e.category === 'Rendimientos').map((e) => e.amount), est: yieldEstimate(account('prex')).est }));
ok(yr.bal === 100120 && yr.inc[0] === 120 && yr.est === 0, 'registra el rendimiento como ingreso y reinicia la estimación');
await page.evaluate(() => { S.accounts = S.accounts.filter((a) => a.id !== 'prex'); S.expenses = S.expenses.filter((e) => e.method !== 'prex'); persist(); render(); });

// 3c. Categorías propias
await page.click('[data-tab="settings"]');
await page.click('#view-settings [data-action="new-cat"]');
await page.fill('#k-name', 'Mascotas'); await page.dispatchEvent('#k-name', 'input');
await page.click('#k-emojis [data-e="🐶"]'); await page.click('#k-colors [data-c="#AF52DE"]');
ok((await page.locator('#k-preview').textContent()).includes('Mascotas'), 'vista previa de la categoría');
await page.click('[data-action="save-cat"]');
ok(await page.evaluate(() => S.cats.length === 1 && S.cats[0].emoji === '🐶' && S.cats[0].color === '#AF52DE'), 'crea categoría con nombre, emoji y color');
await page.evaluate(() => { openExpense(); });
ok(await page.locator('#f-cats [data-cat="Mascotas"]').count() === 1, 'la categoría aparece al cargar un gasto');
await page.fill('#f-amount', '700'); await page.click('#f-cats [data-cat="Mascotas"]'); await page.click('[data-action="save-expense"]'); await page.waitForTimeout(150);
ok(await page.evaluate(() => S.expenses.some((e) => e.category === 'Mascotas' && e.amount === 700)), 'guarda un gasto en la categoría nueva');
await page.click('[data-tab="budgets"]');
ok(await page.locator('#view-budgets [data-cat="Mascotas"]').count() === 1, 'la categoría aparece en Presupuestos');
await page.evaluate(() => { openCat(S.cats[0].id); }); await page.fill('#k-name', 'Perro'); await page.click('[data-action="save-cat"]');
ok(await page.evaluate(() => S.expenses.some((e) => e.category === 'Perro') && !S.expenses.some((e) => e.category === 'Mascotas')), 'renombrar actualiza los movimientos');
await page.evaluate(() => { openCat(S.cats[0].id); }); await page.click('[data-action="delete-cat"]');
ok(await page.evaluate(() => S.cats.length === 0 && S.expenses.some((e) => e.amount === 700 && e.category === 'Otros')), 'eliminar pasa los movimientos a Otros');
await page.click('#toast button'); await page.waitForTimeout(200);
ok(await page.evaluate(() => S.cats.length === 1 && S.expenses.some((e) => e.category === 'Perro')), 'deshacer recupera la categoría');
await page.evaluate(() => { S.expenses = S.expenses.filter((e) => e.category !== 'Perro'); S.cats = []; persist(); render(); });

// 3d. Bancos con varias cajas y tarjeta con cuenta por moneda
await page.evaluate(() => { S.cfg.usdRate = 40; persist(); });
await page.click('[data-tab="cards"]');
for (const [nm, cur] of [['Caja pesos', ''], ['Caja dólares', 'USD']]) {
  await page.click('.quick [data-action="new-account"]');
  await page.fill('#a-bank', 'BROU'); await page.fill('#a-name', nm);
  if (cur) await page.selectOption('#a-cur', 'USD');
  await page.fill('#a-balance', cur ? '500' : '20000'); await page.click('[data-action="save-account"]'); await page.waitForTimeout(150);
}
ok((await page.locator('#view-cards .section-h', { hasText: 'BROU' }).count()) === 1, 'agrupa las cajas del mismo banco');
await page.evaluate(() => openExpense());
ok(await page.locator('#f-from optgroup[label*="BROU"] option', { hasText: 'Caja pesos' }).count() === 1, 'al cargar un gasto, la cuenta aparece bajo su banco');
ok((await page.locator('#f-from option', { hasText: 'Caja pesos' }).textContent()).includes('20.000'), 'la lista muestra el saldo de cada cuenta');
await page.evaluate(() => $('sheet').close());
const ids = await page.evaluate(() => ({ p: S.accounts.find((a) => a.name === 'Caja pesos').id, u: S.accounts.find((a) => a.name === 'Caja dólares').id }));
await page.click('.quick [data-action="new-card"]');
await page.fill('#c-name', 'Visa BROU'); await page.fill('#c-limit', '50000');
await page.selectOption('#c-pay', ids.p); await page.dispatchEvent('#c-pay', 'change');
ok(await page.inputValue('#c-pay-usd') === ids.u, 'sugiere la caja en dólares del mismo banco');
await page.click('[data-action="save-card"]');
const vid = await page.evaluate(() => S.cards.find((c) => c.name === 'Visa BROU').id);
ok(await page.evaluate((id) => card(id).payFrom && card(id).payFromUSD, vid), 'la tarjeta guarda una cuenta por moneda');
await page.evaluate((id) => openPay(id), vid);
ok(await page.inputValue('#p-from') === ids.p, 'pagar en pesos propone la caja en pesos');
await page.evaluate(() => document.querySelector('#p-cur [data-cur="USD"]').click());
ok(await page.inputValue('#p-from') === ids.u, 'pagar en dólares propone la caja en dólares');
await page.evaluate(() => $('psheet').close());
// Deuda que ya tenía la tarjeta
const spentBefore = await page.evaluate(() => sumV(expensesOf(monthEntries(0)))), prevBefore = await page.evaluate(() => sumV(expensesOf(monthEntries(-1))));
await page.evaluate((id) => openDebt(id), vid);
await page.fill('#d-note', 'Heladera'); await page.fill('#d-amount', '2000'); await page.fill('#d-left', '4'); await page.fill('#d-total', '12');
await page.click('[data-action="save-debt"]');
await page.evaluate((id) => openDebt(id), vid);
await page.click('#d-kind [data-kind="balance"]'); await page.fill('#d-amount', '5000'); await page.click('[data-action="save-debt"]');
const st = await page.evaluate((id) => { const s = cardStats(card(id)); const p = s.plans.find((x) => x.e.note === 'Heladera'); return { debt: s.debt[''], fut: s.fut[''], cur: p.current, n: p.n, out: s.outstanding }; }, vid);
ok(st.cur === 9 && st.n === 12, 'cuota en curso: 9 de 12 (faltan 4)');
ok(st.debt === 7000 && st.fut === 6000 && st.out === 13000, 'deuda anterior: saldo + cuota del mes, y 3 cuotas futuras: ' + JSON.stringify(st));
const spentAfter = await page.evaluate(() => sumV(expensesOf(monthEntries(0))));
ok(Math.round(spentAfter - spentBefore) === 2000, 'solo la cuota del mes cuenta como gasto; el saldo anterior no');
ok(await page.evaluate(() => sumV(expensesOf(monthEntries(-1)))) === prevBefore, 'las cuotas ya pagadas no aparecen en meses anteriores');
await page.evaluate(() => { const ids2 = S.accounts.filter((a) => a.bank === 'BROU').map((a) => a.id); S.accounts = S.accounts.filter((a) => !ids2.includes(a.id)); S.transfers = S.transfers.filter((t) => !ids2.includes(t.to) && !ids2.includes(t.from)); S.expenses = S.expenses.filter((e) => !e.opening); S.cards = S.cards.filter((c) => c.name !== 'Visa BROU'); persist(); render(); });

// 3e. Gastos ya descontados del saldo (antes de empezar a usar la app)
const cashBefore = await page.evaluate(() => accountBalance(account(CASH)));
await page.evaluate(() => openExpense());
await page.fill('#f-amount', '25000'); await page.click('#f-cats [data-cat="Casa"]');
await page.selectOption('#f-from', 'cash');
ok(await page.locator('#f-paid-row').isVisible(), 'ofrece marcar como ya descontado');
await page.check('#f-paid'); await page.dispatchEvent('#f-paid', 'change');
await page.click('[data-action="save-expense"]'); await page.waitForTimeout(150);
const pd = await page.evaluate(() => ({ bal: accountBalance(account(CASH)), inMonth: monthEntries(0).some((e) => e.amount === 25000) }));
ok(pd.bal === cashBefore && pd.inMonth, 'queda en los gastos del mes sin tocar el saldo');
await page.evaluate(() => { openExpense(); });
await page.fill('#f-amount', '30000'); await page.check('#f-rec'); await page.dispatchEvent('#f-rec', 'change');
await page.selectOption('#f-from', 'cash');
await page.check('#f-paid'); await page.dispatchEvent('#f-paid', 'change');
await page.click('[data-action="save-expense"]'); await page.waitForTimeout(150);
const pr = await page.evaluate(() => ({ bal: accountBalance(account(CASH)), rule: S.recurring.find((r) => r.amount === 30000) }));
ok(pr.bal === cashBefore && pr.rule && pr.rule.paidKey, 'fijo: el pago de este mes no descuenta, los próximos sí');
await page.evaluate(() => { S.expenses = S.expenses.filter((e) => e.amount !== 25000); S.recurring = S.recurring.filter((r) => r.amount !== 30000); persist(); render(); });

// 4. Foto del recibo
await page.click('[data-tab="home"]');
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
await page.reload(); await ready();
ok(await page.locator('#lock:not([hidden])').count() === 0, 'dentro de los 10 minutos no vuelve a pedir el PIN');
await page.evaluate(async () => { const s = await idb.get('kv', 'session'); await idb.set('kv', 'session', { ...s, until: Date.now() - 1 }); });
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
await page.evaluate(async () => { const s = await idb.get('kv', 'session'); await idb.set('kv', 'session', { ...s, until: Date.now() - 1 }); });
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
