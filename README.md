# Mis Gastos — web app móvil (estilo iOS)

App web instalable (PWA) para registrar gastos, ingresos, cuentas, tarjetas y presupuestos.

## Privacidad

- Todos los datos viven **solo en el celular** (almacenamiento local del navegador).
- No hay servidor, cuentas ni credenciales: la app no envía tus datos a ningún lado.
- La única llamada externa es la cotización del dólar (open.er-api.com), sin datos personales.

## Funciones

- Gastos, ingresos, cuentas, tarjetas con cuotas, fijos mensuales, transferencias y presupuestos.
- Gráfico de ingresos y gastos de los últimos 6 meses.
- Alertas al llegar al 80 % y al pasarse del presupuesto de una categoría.
- Foto del recibo en cada movimiento (se achica a 1280 px).
- Importar el estado de cuenta del banco en CSV: detecta columnas, débito/crédito, categorías y repetidos.
- «Deshacer» después de eliminar, importar o borrar.

## Seguridad en el celular

- Los datos se guardan en IndexedDB (migran solos desde localStorage en la v8).
- **Bloqueo con PIN** (6 a 12 números): los datos y las fotos se cifran con una clave aleatoria AES-256,
  que se guarda envuelta con el PIN (PBKDF2-SHA256, 600.000 iteraciones). Después de desbloquear, no vuelve a pedir PIN ni huella durante 10 minutos (aunque cierres la app); pasado ese tiempo sin usarla, se bloquea.
- **Huella** opcional (WebAuthn con la extensión PRF), si el celular y el navegador la permiten.
- Sin el PIN no hay forma de abrir los datos: solo se recuperan con una copia cifrada.

## Copias de seguridad

En **Ajustes → Copia de seguridad**:

- **Guardar copia cifrada**: la app cifra todo con tu contraseña (AES-GCM 256, clave derivada con PBKDF2-SHA256) y te deja guardarla donde quieras (Drive, Dropbox, correo) con el menú Compartir del celular.
- **Restaurar una copia**: elegís el archivo y ponés la contraseña. Antes de reemplazar, la app guarda lo que había para poder volver atrás.
- Antes de borrar o restaurar, si hay cambios sin copia, ofrece guardar una.
- Si olvidás la contraseña, la copia no se puede abrir.

Publicada en https://kleangame.github.io/mis-gastos/

## Pruebas

```
npm i playwright && npx playwright install chromium
python3 -m http.server 8123 &
node tests/e2e.mjs            # o URL=https://kleangame.github.io/mis-gastos/ node tests/e2e.mjs
```
