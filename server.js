require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const db = require('./lib/db');
const mp = require('./lib/mercadopago');
const paypal = require('./lib/paypal');
const { notifyPaid } = require('./lib/notify');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// ---------- Panel admin protegido con usuario/contraseña ----------
function adminAuth(req, res, next) {
  const user = process.env.ADMIN_USER || 'admin';
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return res.status(503).send('Configura ADMIN_PASSWORD en .env');

  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    const p = rest.join(':');
    const ok = (a, b) => {
      const x = Buffer.from(a), y = Buffer.from(b);
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    if (ok(u, user) && ok(p, pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Admin tienda"').status(401).send('Acceso restringido');
}

app.use(['/admin.html', '/admin.js', '/api/admin'], adminAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Utilidades ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateCheckout(body) {
  const product = db.getProduct(String(body.productId || ''));
  if (!product || !product.active) return { error: 'Producto no disponible' };
  if (product.stock <= 0) return { error: 'Sin stock' };
  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 120) return { error: 'Email no válido' };
  const contact = String(body.contact || '').trim().slice(0, 100);
  return { product, email, contact };
}

async function confirmPayment(order, paymentId) {
  const { changed, outOfStock, order: updated } = db.markPaid(order.id, paymentId);
  if (changed) await notifyPaid(updated, { outOfStock });
  return updated;
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: e.message || 'Error interno' });
  });

// ---------- API pública ----------
app.get('/api/config', (req, res) => {
  res.json({
    storeName: process.env.STORE_NAME || 'Tienda MC',
    paypalClientId: process.env.PAYPAL_CLIENT_ID || null,
    mercadoPagoEnabled: Boolean(process.env.MP_ACCESS_TOKEN),
  });
});

app.get('/api/products', (req, res) => {
  res.json(
    db.listProducts()
      .filter((p) => p.active)
      .map(({ id, name, description, priceArs, priceUsd, stock }) => ({ id, name, description, priceArs, priceUsd, stock }))
  );
});

app.get('/api/orders/:id', (req, res) => {
  const o = db.getOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Pedido no encontrado' });
  res.json({ id: o.id, status: o.status, productName: o.productName, method: o.method, amount: o.amount, currency: o.currency });
});

// --- Mercado Pago ---
app.post('/api/orders/mercadopago', wrap(async (req, res) => {
  const v = validateCheckout(req.body);
  if (v.error) return res.status(400).json({ error: v.error });

  const order = db.createOrder({ product: v.product, method: 'mercadopago', buyerEmail: v.email, buyerContact: v.contact });
  const pref = await mp.createPreference({ order, product: v.product, baseUrl: BASE_URL });
  db.updateOrder(order.id, { providerId: pref.id });
  res.json({ orderId: order.id, initPoint: pref.init_point });
}));

// Al volver de MP, la página de gracias llama aquí con el payment_id para confirmar
// (útil en local, donde los webhooks no llegan).
app.post('/api/orders/:id/verify-mp', wrap(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order || order.method !== 'mercadopago') return res.status(404).json({ error: 'Pedido no encontrado' });
  const paymentId = String(req.body.paymentId || '');
  if (!/^\d+$/.test(paymentId)) return res.status(400).json({ error: 'payment_id no válido' });

  const payment = await mp.getPayment(paymentId);
  if (payment.external_reference === order.id && payment.status === 'approved'
      && Number(payment.transaction_amount) >= Number(order.amount) && payment.currency_id === 'ARS') {
    await confirmPayment(order, payment.id);
  }
  res.json({ status: db.getOrder(order.id).status });
}));

app.post('/webhooks/mercadopago', async (req, res) => {
  res.sendStatus(200); // responder rápido; MP reintenta si tardamos
  try {
    if (!mp.verifyWebhookSignature(req)) return console.warn('Webhook MP con firma inválida, ignorado');
    const type = req.query.type || req.query.topic || req.body?.type;
    const paymentId = req.query['data.id'] || req.body?.data?.id || req.query.id;
    if (type !== 'payment' || !paymentId) return;

    // Nunca confiamos en el cuerpo del webhook: consultamos el pago a la API
    const payment = await mp.getPayment(paymentId);
    const order = db.getOrder(payment.external_reference);
    if (!order) return;
    if (payment.status === 'approved' && Number(payment.transaction_amount) >= Number(order.amount)
        && payment.currency_id === 'ARS') {
      await confirmPayment(order, payment.id);
    }
  } catch (e) {
    console.error('Error procesando webhook MP:', e.message);
  }
});

// --- PayPal ---
app.post('/api/orders/paypal', wrap(async (req, res) => {
  const v = validateCheckout(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (!(v.product.priceUsd > 0)) return res.status(400).json({ error: 'Este producto no tiene precio en USD' });

  const order = db.createOrder({ product: v.product, method: 'paypal', buyerEmail: v.email, buyerContact: v.contact });
  const ppOrder = await paypal.createOrder({ order, product: v.product });
  db.updateOrder(order.id, { providerId: ppOrder.id });
  res.json({ id: ppOrder.id, orderId: order.id });
}));

app.post('/api/orders/paypal/:paypalId/capture', wrap(async (req, res) => {
  const order = db.findOrderByProviderId(req.params.paypalId);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  if (order.status !== 'pending') return res.json({ orderId: order.id, status: order.status });

  let result;
  try {
    result = await paypal.captureOrder(req.params.paypalId);
  } catch (e) {
    // El comprador puede reintentar con otra tarjeta/fondo
    if (e.issue === 'INSTRUMENT_DECLINED') return res.status(402).json({ error: 'Pago rechazado', retry: true });
    throw e;
  }

  const capture = result.purchase_units?.[0]?.payments?.captures?.[0];
  const ok = result.status === 'COMPLETED' && capture?.status === 'COMPLETED'
    && capture.custom_id === order.id
    && capture.amount?.currency_code === 'USD'
    && Number(capture.amount.value) >= Number(order.amount);

  if (ok) await confirmPayment(order, capture.id);
  else if (capture?.status === 'PENDING') console.warn(`Pago PayPal pendiente de revisión: ${order.id}`);
  res.json({ orderId: order.id, status: db.getOrder(order.id).status });
}));

// ---------- API admin ----------
app.get('/api/admin/products', (req, res) => res.json(db.listProducts()));

app.post('/api/admin/products', (req, res) => {
  if (!String(req.body.name || '').trim()) return res.status(400).json({ error: 'Falta el nombre' });
  res.json(db.createProduct(req.body));
});

app.put('/api/admin/products/:id', (req, res) => {
  const p = db.updateProduct(req.params.id, req.body);
  p ? res.json(p) : res.status(404).json({ error: 'No existe' });
});

app.delete('/api/admin/products/:id', (req, res) => {
  db.deleteProduct(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'No existe' });
});

app.get('/api/admin/orders', (req, res) => res.json(db.listOrders()));

app.post('/api/admin/orders/:id/status', (req, res) => {
  const allowed = ['pending', 'paid', 'delivered', 'cancelled'];
  const status = String(req.body.status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Estado no válido' });
  const patch = { status };
  if (status === 'delivered') patch.deliveredAt = new Date().toISOString();
  const o = db.updateOrder(req.params.id, patch);
  o ? res.json(o) : res.status(404).json({ error: 'No existe' });
});

app.listen(PORT, () => {
  console.log(`Tienda en ${BASE_URL}  ·  Panel: ${BASE_URL}/admin.html`);
  if (!process.env.MP_ACCESS_TOKEN) console.log('  (Mercado Pago desactivado: falta MP_ACCESS_TOKEN)');
  if (!process.env.PAYPAL_CLIENT_ID) console.log('  (PayPal desactivado: falta PAYPAL_CLIENT_ID)');
});
