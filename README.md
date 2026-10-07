# Mis Gastos — web app móvil (estilo iOS)

App web instalable (PWA) para registrar gastos, ingresos, cuentas, tarjetas y presupuestos.

## Privacidad

- Todos los datos viven **solo en el celular** (almacenamiento local del navegador).
- No hay servidor, cuentas ni credenciales: la app no envía tus datos a ningún lado.
- La única llamada externa es la cotización del dólar (open.er-api.com), sin datos personales.

## Copias de seguridad

En **Ajustes → Copia de seguridad**:

- **Guardar copia cifrada**: la app cifra todo con tu contraseña (AES-GCM 256, clave derivada con PBKDF2-SHA256) y te deja guardarla donde quieras (Drive, Dropbox, correo) con el menú Compartir del celular.
- **Restaurar una copia**: elegís el archivo y ponés la contraseña.
- Si olvidás la contraseña, la copia no se puede abrir.

Publicada en https://kleangame.github.io/mis-gastos/
