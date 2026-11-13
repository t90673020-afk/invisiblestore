# Tienda MC — Mercado Pago + PayPal

Tienda pequeña en Node.js para vender cuentas con entrega manual.
Cobra en **ARS con Mercado Pago** y en **USD con PayPal** (PayPal no acepta pesos argentinos).

## Arrancar en tu PC

1. Instala Node.js 18 o superior.
2. En esta carpeta:
   ```
   npm install
   copy .env.example .env      (en Linux/Mac: cp .env.example .env)
   ```
3. Rellena `.env` (mira abajo de dónde sacar cada clave).
4. `npm start` y abre http://localhost:3000
5. Panel: http://localhost:3000/admin.html (usuario y contraseña de `.env`). Crea tus productos ahí.

## Claves

**Mercado Pago** → https://www.mercadopago.com.ar/developers/panel/app → Crear aplicación (Checkout Pro) → *Credenciales*.
- Para probar: Access Token de prueba y paga con una **cuenta de comprador de prueba** (Cuentas de prueba en el mismo panel).
- Para cobrar de verdad: Access Token de producción (`APP_USR-...`).
- Webhooks: en tu app → *Webhooks* → URL `https://TU-DOMINIO/webhooks/mercadopago`, evento **Pagos**. Copia la *clave secreta* a `MP_WEBHOOK_SECRET`.

**PayPal** → https://developer.paypal.com/dashboard/applications → crea una app.
- `PAYPAL_ENV=sandbox` con las claves Sandbox para probar (usa las cuentas personales sandbox para pagar).
- Al lanzar: claves *Live* y `PAYPAL_ENV=live`. Necesitas una cuenta PayPal Business.

**Discord (opcional)** → en un canal privado: Editar canal → Integraciones → Webhooks → Nuevo → copiar URL a `DISCORD_WEBHOOK_URL`. Te avisará de cada pago con el email del comprador.

## Cómo funciona un pedido

1. El cliente elige producto, pone su email (y Discord si quiere) y paga.
2. El servidor confirma el pago **consultando la API** de MP/PayPal (nunca se fía del navegador) y comprueba importe y moneda.
3. El pedido pasa a *Pagado · por entregar*, se descuenta 1 de stock y te llega el aviso.
4. Mandas los datos de la cuenta al comprador y en el panel pulsas **Marcar entregada**.

En local (`http://localhost`) los webhooks de MP no llegan, pero la página de gracias confirma el pago igualmente al volver de Mercado Pago. En producción con `https` funcionan ambos caminos.

## Ponerla online

Cualquier hosting con Node sirve (Railway, Render, un VPS…). Requisitos:
- `BASE_URL` con tu dominio en **https**.
- Que la carpeta `data/` persista entre reinicios (ahí está `db.json` con productos y pedidos). En Railway/Render añade un *volumen/disk* montado en `data/`.
- Haz copias de `data/db.json` de vez en cuando.

## Archivos

- `server.js` — rutas, validación de pagos, panel admin
- `lib/mercadopago.js`, `lib/paypal.js` — integración de pagos
- `lib/db.js` — almacenamiento en JSON
- `lib/notify.js` — aviso por Discord
- `public/` — tienda, página de gracias y panel
