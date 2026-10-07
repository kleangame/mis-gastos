# Mis Gastos — web app móvil (estilo iOS) + Google Sheets

HTML, CSS y JavaScript puro. Sin dependencias ni build. Instalable en el celular y funciona sin conexión;
cada gasto se guarda como una fila en tu propia Google Sheet.

## Funciones
- Resumen del mes: balance (ingresos menos gastos), comparación con el mes anterior, gasto con tarjeta, avance del presupuesto, gráfico de torta, recientes.
- Ingresos: sueldo, freelance, ventas, regalos y otros.
- Tarjetas de crédito: nombre, límite y día de cierre. Compras en 1 a 36 cuotas, que se reparten mes a mes.
  Muestra utilización (deuda pendiente / límite; hasta 30% verde, 30-80% naranja, más de 80% rojo), disponible,
  lo que pagás este mes, cada compra en cuotas con lo que resta, y la proyección de los próximos 6 meses.
- Fijos mensuales (gastos o ingresos): alquiler, sueldo, suscripciones. Se registran solos cada mes desde el primer pago,
  para siempre o hasta un último mes (por ejemplo, alquiler de abril 2026 a abril 2027). Se ven y editan en Presupuestos.
- Movimientos: agrupados por día, búsqueda y filtros (ingresos, tarjeta, categoría). Tocá uno para editarlo o eliminarlo.
- Presupuestos: límite mensual por categoría con barra de progreso (verde, naranja, rojo).
- Cuentas (v6): banco, efectivo, ahorro e inversión, en pesos o dólares, con saldo que se mueve con cada gasto, ingreso o transferencia.
  Patrimonio neto (lo que tenés menos lo que debés), metas de ahorro con aporte mensual sugerido, ajuste de saldo y valor de inversiones.
- Transferencias entre cuentas (incluye compra de dólares con cotización), que no cuentan como gasto ni ingreso.
- Pago de resumen de tarjeta: total, mínimo u otro monto, desde una cuenta. Deuda separada en pesos y en dólares.
- Gastos e ingresos en dólares con la cotización del día (automática o manual).
- Ajustes: conexión a Google Sheets, moneda, cotización del dólar, exportar CSV y número de versión.
- Offline: los cambios quedan en cola y se suben solos al volver la conexión.

## Conexión simple (recomendada)
1. En la app: Ajustes → **Crear mi hoja** → «Hacer una copia». La copia ya trae el script y las hojas.
2. En la copia: Extensiones → Apps Script → **Implementar → Nueva implementación → Implementar** y aceptá los permisos
   (si Google dice «no verificada», Configuración avanzada → Ir a Mis Gastos: es tu propio script).
3. En la hoja: menú **Mis Gastos → Conectar celular**. Escaneá el QR o abrí el link; en iPhone con la app instalada, copiá el código y pegalo en Ajustes.
La clave se genera sola. `appsscript.json` deja la implementación preconfigurada (ejecutar como yo, acceso cualquier persona).

## Conexión avanzada: 1. Crear la hoja y el backend (5 minutos)
1. Creá una Google Sheet nueva (por ejemplo "Mis Gastos").
2. Menú **Extensiones > Apps Script**. Borrá lo que haya y pegá `Code.gs`.
3. Cambiá `TOKEN = 'CAMBIA-ESTA-CLAVE'` por una clave tuya. Guardá.
4. **Implementar > Nueva implementación** > tipo **App web**.
   - Ejecutar como: **Yo**
   - Quién tiene acceso: **Cualquier usuario**
5. Autorizá los permisos y copiá la **URL de la app web** (termina en `/exec`).
   Las pestañas "Gastos" (todos los movimientos), "Presupuestos", "Tarjetas" y "Fijos" se crean solas en la primera sincronización.

> Si cambiás el código del script después, usá **Implementar > Administrar implementaciones > Editar > Nueva versión** para que la URL siga siendo la misma.

## 2. Publicar la app
Necesita HTTPS. Opciones gratis:
- **Netlify Drop**: arrastrá esta carpeta a https://app.netlify.com/drop
- **GitHub Pages**: subí la carpeta a un repo y activá Pages.

## 3. Conectar desde el celular
1. Abrí el link en Chrome > menú ⋮ > **Instalar app**.
2. Ajustes > pegá la URL del script y tu clave > **Conectar hoja**.

## Seguridad
La URL + clave dan acceso a esa hoja. No compartas ninguna de las dos. La hoja sigue siendo privada en tu Drive.

## Archivos
- `index.html`, `styles.css`, `app.js` — la app
- `manifest.webmanifest`, `sw.js`, `icons/` — instalación y modo offline
- `Code.gs` — backend que lee y escribe la hoja

## Actualizar desde la versión anterior
Reemplazá el código del script por el nuevo `Code.gs` y publicá una **nueva versión** de la misma implementación.
La hoja "Gastos" suma las columnas tipo, medio, cuotas y tarjeta sin perder datos.
Desde la v6 se crean solas las hojas "Cuentas" y "Transferencias", y "Tarjetas" suma pagar_desde y desde.
Al abrir la v6, lo que cargaste como "Efectivo / débito" pasa a la cuenta Efectivo, y las cuotas de meses anteriores se toman como pagadas.
