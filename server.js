'use strict';
/**
 * Le-Gacy's Importation – store server.
 * Zero third-party dependencies: only Node built-ins, so there is nothing to
 * install and no package supply chain to keep patched.
 *
 * Security model (summary – see README):
 *  - Prices, totals and availability are computed ONLY on the server.
 *  - Every input is validated, length-limited and normalised.
 *  - Strict security headers incl. a CSP that blocks inline scripts.
 *  - Per-IP rate limiting on every sensitive route.
 *  - Order lookup needs reference + phone number; errors are generic.
 *  - Admin API requires an authenticated, same-origin, HTTP-only session.
 *  - Orders are written atomically with owner-only file permissions.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');

if (fs.existsSync(ENV_FILE)) {
  const contents = fs.readFileSync(ENV_FILE, 'utf8');
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error('Invalid .env entry on line ' + (index + 1) + '.');
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // set when behind Nginx/Vercel/Render etc.
const IS_PROD = process.env.NODE_ENV === 'production';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_CONFIGURED = /^pk_(test|live)_[A-Za-z0-9]+$/.test(PAYSTACK_PUBLIC_KEY)
  && /^sk_(test|live)_[A-Za-z0-9]+$/.test(PAYSTACK_SECRET_KEY)
  && PAYSTACK_PUBLIC_KEY.slice(3, 7) === PAYSTACK_SECRET_KEY.slice(3, 7);
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ADMIN_EMAIL) || ADMIN_PASSWORD.length < 20 || ADMIN_PASSWORD.length > 256) {
  throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of 20–256 characters in .env before starting the server.');
}

const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const ORDERS_FILE = path.join(DATA, 'orders.json');
const PRODUCTS_FILE = path.join(DATA, 'products.json');

const store = JSON.parse(fs.readFileSync(path.join(DATA, 'store.json'), 'utf8'));
let products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
let productById = new Map(products.map((p) => [p.id, p]));

const ADMIN_PASSWORD_SALT = crypto.randomBytes(16);
const ADMIN_PASSWORD_HASH = crypto.scryptSync(ADMIN_PASSWORD, ADMIN_PASSWORD_SALT, 64);
const ADMIN_SESSION_TTL = 8 * 60 * 60 * 1000;
const adminSessions = new Map();

/* ------------------------------------------------------------------ */
/* Orders storage (atomic writes, private file permissions)           */
/* ------------------------------------------------------------------ */
let orders = [];
try { orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { orders = []; }

let writing = false;
let dirty = false;
function persist() {
  dirty = true;
  if (writing) return;
  writing = true;
  (async () => {
    while (dirty) {
      dirty = false;
      const tmp = ORDERS_FILE + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(orders, null, 2), { mode: 0o600 });
      await fs.promises.rename(tmp, ORDERS_FILE);
    }
    writing = false;
  })().catch(() => { writing = false; console.error('Could not save orders'); });
}

let productsWriting = false;
let productsDirty = false;
function persistProducts() {
  productsDirty = true;
  if (productsWriting) return;
  productsWriting = true;
  (async () => {
    while (productsDirty) {
      productsDirty = false;
      const tmp = PRODUCTS_FILE + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(products, null, 2), { mode: 0o600 });
      await fs.promises.rename(tmp, PRODUCTS_FILE);
    }
    productsWriting = false;
  })().catch(() => { productsWriting = false; console.error('Could not save products'); });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const STATUSES = ['awaiting_payment', 'payment_submitted', 'confirmed', 'processing', 'dispatched', 'delivered', 'cancelled'];

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F<>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizePhone(value) {
  const v = String(value == null ? '' : value).replace(/[\s\-().]/g, '');
  if (/^\+233\d{9}$/.test(v)) return '0' + v.slice(4);
  if (/^233\d{9}$/.test(v)) return '0' + v.slice(3);
  if (/^0\d{9}$/.test(v)) return v;
  return null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function adminSessionId(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator < 0 || cookie.slice(0, separator).trim() !== 'admin_session') continue;
    const value = cookie.slice(separator + 1).trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : '';
  }
  return '';
}

function adminAuthorised(req) {
  const id = adminSessionId(req);
  const session = id && adminSessions.get(id);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(id);
    return false;
  }
  return true;
}

function sameOrigin(req) {
  const origin = String(req.headers.origin || '');
  const host = String(req.headers.host || '').toLowerCase();
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const forwarded = TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    const expectedProtocol = forwarded ? forwarded + ':' : req.socket.encrypted ? 'https:' : 'http:';
    return parsed.host.toLowerCase() === host && parsed.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

function adminCookie(id, maxAge) {
  return 'admin_session=' + id + '; Path=/api/admin/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge
    + (IS_PROD ? '; Secure' : '');
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of adminSessions) if (session.expiresAt <= now) adminSessions.delete(id);
}, 60 * 1000).unref();

function newRef() {
  let ref;
  do { ref = 'LG-' + crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8); }
  while (orders.some((o) => o.ref === ref));
  return ref;
}

function publicOrder(o) {
  return {
    ref: o.ref,
    status: o.status,
    createdAt: o.createdAt,
    customerName: o.customer.name,
    customerEmail: o.customer.email || '',
    items: o.items,
    subtotal: o.subtotal,
    paymentSubmitted: !!o.payment
  };
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ------------------------------------------------------------------ */
/* Rate limiting (fixed window, in memory)                            */
/* ------------------------------------------------------------------ */
const buckets = new Map();
function limited(req, name, max, windowMs) {
  const key = name + '|' + clientIp(req);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return b.count > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
}, 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Responses                                                          */
/* ------------------------------------------------------------------ */
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://js.paystack.co",
    "style-src 'self' 'unsafe-inline' https://paystack.com/public/css/",
    "img-src 'self' data: https://res.cloudinary.com https://images.unsplash.com",
    "font-src 'self'",
    "connect-src 'self' https://api.paystack.co https://*.paystack.com",
    "frame-src https://checkout.paystack.com https://*.paystack.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].concat(IS_PROD ? ['upgrade-insecure-requests'] : []).join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin'
};
if (IS_PROD) SECURITY_HEADERS['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, headers));
  res.end(body);
}
function json(res, status, data, extra) {
  send(res, status, JSON.stringify(data), Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extra));
}
const fail = (res, status, error, fields) => json(res, status, fields ? { error, fields } : { error });

function readJson(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().startsWith('application/json')) return reject(Object.assign(new Error('bad type'), { status: 415 }));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('bad body');
        resolve(v);
      } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', () => reject(Object.assign(new Error('read'), { status: 400 })));
  });
}

/* ------------------------------------------------------------------ */
/* Static files                                                       */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8'
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return fail(res, 400, 'Bad request.'); }
  if (rel.includes('\0')) return fail(res, 400, 'Bad request.');
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) return fail(res, 403, 'Forbidden.');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // Unknown path with an extension => 404; clean paths fall back to the app shell.
      if (path.extname(rel)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return serveStatic(req, res, '/index.html');
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    };
    if (path.basename(file) === 'admin.html') {
      headers['X-Robots-Tag'] = 'noindex, nofollow';
      headers['Cache-Control'] = 'no-store';
    }
    res.writeHead(200, Object.assign({}, SECURITY_HEADERS, headers));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, pathname) {
  const method = req.method;

  if (method === 'GET' && pathname === '/api/paystack/config') {
    return json(res, 200, {
      enabled: PAYSTACK_CONFIGURED,
      publicKey: PAYSTACK_CONFIGURED ? PAYSTACK_PUBLIC_KEY : ''
    }, { 'Cache-Control': 'no-store' });
  }

  if (method === 'GET' && pathname === '/api/catalog') {
    return json(res, 200, {
      store: {
        name: store.name, whatsapp: store.whatsapp, whatsappDisplay: store.whatsappDisplay,
        instagram: store.instagram, tiktokName: store.tiktokName, momoNumber: store.momoNumber
      },
      categories: store.categories,
      products: products.map(({ id, name, category, price, inStock, preOrder, image, description, sizes, colors }) =>
        ({ id, name, category, price, inStock, preOrder: preOrder === true, image, description,
          sizes: Array.isArray(sizes) ? sizes : [], colors: Array.isArray(colors) ? colors : [] }))
    }, { 'Cache-Control': 'no-cache' });
  }

  /* ---- create order ---- */
  if (method === 'POST' && pathname === '/api/orders') {
    if (limited(req, 'order', 10, 60 * 60 * 1000)) return fail(res, 429, 'Too many orders from this device. Please try again later or contact us on WhatsApp.');
    const b = await readJson(req);
    if (b.website) return fail(res, 400, 'Request rejected.'); // honeypot field, humans never fill it

    const fields = {};
    const name = clean(b.name, 80);
    if (name.length < 2) fields.name = 'Enter your full name.';
    const email = clean(b.email, 120).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Enter a valid email address for your Paystack receipt.';
    const phone = normalizePhone(b.phone);
    if (!phone) fields.phone = 'Enter a valid Ghana phone number, e.g. 0244123456.';
    const town = clean(b.town, 60);
    if (town.length < 2) fields.town = 'Enter your town or city.';
    const address = clean(b.address, 160);
    if (address.length < 5) fields.address = 'Enter your delivery address or a nearby landmark.';
    const notes = clean(b.notes, 200);

    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 30) fields.items = 'Your cart is empty.';
    if (Object.keys(fields).length) return fail(res, 400, 'Please check the highlighted details.', fields);

    const merged = new Map();
    for (const it of b.items) {
      const id = clean(it && it.id, 80);
      const qty = Number(it && it.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 20) return fail(res, 400, 'One of the quantities is not valid.');
      const size = clean(it && it.size, 30);
      const color = clean(it && it.color, 40);
      const p = productById.get(id);
      if (p && Array.isArray(p.sizes) && p.sizes.length && !p.sizes.includes(size)) {
        return fail(res, 400, 'Please select a valid size for each item.');
      }
      if (p && (!Array.isArray(p.sizes) || !p.sizes.length) && size) {
        return fail(res, 400, 'A size was provided for an item that has no size options.');
      }
      if (p && Array.isArray(p.colors) && p.colors.length && !p.colors.includes(color)) {
        return fail(res, 400, 'Please select a valid color for each item.');
      }
      if (p && (!Array.isArray(p.colors) || !p.colors.length) && color) {
        return fail(res, 400, 'A color was provided for an item that has no color options.');
      }
      const key = JSON.stringify([id, size, color]);
      const existing = merged.get(key);
      merged.set(key, { id, size, color, qty: Math.min(20, (existing ? existing.qty : 0) + qty) });
    }
    const lines = [];
    let pesewas = 0;
    for (const { id, size, color, qty } of merged.values()) {
      const p = productById.get(id);
      if (!p || (!p.inStock && p.preOrder !== true)) return fail(res, 409, 'An item in your cart is no longer available. Please review your cart.');
      lines.push(Object.assign({ id: p.id, name: p.name, qty, price: p.price, preOrder: !p.inStock && p.preOrder === true },
        size ? { size } : {}, color ? { color } : {}));
      pesewas += Math.round(p.price * 100) * qty;
    }

    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const pending = orders.filter((o) => o.customer.phone === phone && o.status === 'awaiting_payment' && Date.parse(o.createdAt) > dayAgo).length;
    if (pending >= 5) return fail(res, 429, 'You have several unpaid orders. Please pay or contact us on WhatsApp before placing another.');

    if (!PAYSTACK_CONFIGURED) return fail(res, 503, 'Online payment is not available right now. Please contact us on WhatsApp.');
    const order = {
      ref: newRef(),
      status: 'awaiting_payment',
      createdAt: new Date().toISOString(),
      customer: { name, email, phone, town, address, notes },
      items: lines,
      subtotal: pesewas / 100,
      payment: null
    };
    orders.push(order);
    persist();
    return json(res, 201, { order: publicOrder(order) });
  }

  /* ---- create Paystack payment reference ---- */
  if (method === 'POST' && pathname === '/api/orders/paystack/reference') {
    if (limited(req, 'paystack-reference', 20, 15 * 60 * 1000)) return fail(res, 429, 'Too many payment attempts. Please wait and try again.');
    if (!PAYSTACK_CONFIGURED) return fail(res, 503, 'Online payment is not available right now. Please contact us on WhatsApp.');
    const b = await readJson(req);
    const ref = clean(b.ref, 20).toUpperCase();
    const phone = normalizePhone(b.phone);
    const order = phone && orders.find((o) => o.ref === ref && o.customer.phone === phone);
    if (!order) return fail(res, 404, 'We could not find an order with those details.');
    if (order.status !== 'awaiting_payment') return fail(res, 409, 'This order is no longer awaiting payment.');

    const reference = 'LG' + crypto.randomBytes(16).toString('hex');
    if (!Array.isArray(order.paystackReferences)) order.paystackReferences = [];
    order.paystackReferences.push(reference);
    persist();
    return json(res, 200, { reference });
  }

  /* ---- verify Paystack payment server-side ---- */
  if (method === 'POST' && pathname === '/api/orders/paystack/verify') {
    if (limited(req, 'paystack-verify', 20, 15 * 60 * 1000)) return fail(res, 429, 'Too many payment checks. Please wait and try again.');
    if (!PAYSTACK_CONFIGURED) return fail(res, 503, 'Online payment is not available right now. Please contact us on WhatsApp.');
    const b = await readJson(req);
    const ref = clean(b.ref, 20).toUpperCase();
    const phone = normalizePhone(b.phone);
    const reference = clean(b.reference, 64);
    const order = phone && orders.find((o) => o.ref === ref && o.customer.phone === phone);
    if (!order || !Array.isArray(order.paystackReferences) || !order.paystackReferences.includes(reference)) {
      return fail(res, 404, 'We could not verify this payment for your order.');
    }
    if (order.payment && order.payment.provider === 'paystack' && order.payment.reference === reference) {
      return json(res, 200, { order: publicOrder(order) });
    }
    if (order.status !== 'awaiting_payment') return fail(res, 409, 'This order is no longer awaiting payment.');

    let response;
    let transaction;
    try {
      response = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
        headers: { Authorization: 'Bearer ' + PAYSTACK_SECRET_KEY },
        signal: AbortSignal.timeout(12000)
      });
      transaction = await response.json();
    } catch (err) {
      console.error('Paystack verification request failed:', err.message);
      return fail(res, 502, 'We could not confirm your payment yet. Please try again.');
    }
    const payment = transaction && transaction.data;
    if (!response.ok || !transaction || transaction.status !== true || !payment) {
      console.error('Paystack verification returned an unsuccessful response.');
      return fail(res, 502, 'We could not confirm your payment yet. Please try again.');
    }
    const expectedAmount = Math.round(order.subtotal * 100);
    if (payment.status !== 'success'
      || payment.reference !== reference
      || payment.amount !== expectedAmount
      || payment.currency !== 'GHS'
      || !payment.customer
      || String(payment.customer.email).toLowerCase() !== order.customer.email) {
      return fail(res, 409, 'Paystack has not confirmed the exact amount for this order yet.');
    }

    order.payment = {
      provider: 'paystack',
      reference,
      transactionId: payment.id,
      channel: clean(payment.channel, 40),
      amount: payment.amount / 100,
      paidAt: payment.paid_at || new Date().toISOString()
    };
    order.status = 'confirmed';
    persist();
    return json(res, 200, { order: publicOrder(order) });
  }

  /* ---- track / fetch own order ---- */
  if (method === 'POST' && pathname === '/api/orders/track') {
    if (limited(req, 'track', 20, 15 * 60 * 1000)) return fail(res, 429, 'Too many attempts. Please wait a few minutes and try again.');
    const b = await readJson(req);
    const ref = clean(b.ref, 20).toUpperCase();
    const phone = normalizePhone(b.phone);
    const order = phone && orders.find((o) => o.ref === ref && o.customer.phone === phone);
    if (!order) return fail(res, 404, 'We could not find an order with those details.');
    return json(res, 200, { order: publicOrder(order) });
  }

  /* ---- submit Mobile Money payment details ---- */
  if (method === 'POST' && pathname === '/api/orders/pay') {
    if (limited(req, 'pay', 15, 15 * 60 * 1000)) return fail(res, 429, 'Too many attempts. Please wait a few minutes and try again.');
    const b = await readJson(req);
    const ref = clean(b.ref, 20).toUpperCase();
    const phone = normalizePhone(b.phone);
    const order = phone && orders.find((o) => o.ref === ref && o.customer.phone === phone);
    if (!order) return fail(res, 404, 'We could not find an order with those details.');
    if (order.status !== 'awaiting_payment') return json(res, 200, { order: publicOrder(order) });

    const fields = {};
    const txnId = clean(b.txnId, 24).toUpperCase();
    if (!/^[A-Z0-9]{6,24}$/.test(txnId)) fields.txnId = 'Enter the transaction ID from your Mobile Money SMS (letters and numbers only).';
    const payerName = clean(b.payerName, 80);
    if (payerName.length < 2) fields.payerName = 'Enter the name on the Mobile Money wallet you paid from.';
    if (Object.keys(fields).length) return fail(res, 400, 'Please check the highlighted details.', fields);

    if (orders.some((o) => o.payment && o.payment.txnId === txnId)) {
      return fail(res, 409, 'That transaction ID has already been used. If this is a mistake, contact us on WhatsApp.', { txnId: 'This ID was already submitted.' });
    }
    order.payment = { txnId, payerName, submittedAt: new Date().toISOString(), amount: order.subtotal };
    order.status = 'payment_submitted';
    persist();
    return json(res, 200, { order: publicOrder(order) });
  }

  /* ---- admin ---- */
  if (pathname.startsWith('/api/admin/')) {
    if (limited(req, 'admin', 60, 15 * 60 * 1000)) return fail(res, 429, 'Too many requests.');
    if (method === 'POST' && !sameOrigin(req)) return fail(res, 403, 'Request rejected.');
    if (method === 'POST' && pathname === '/api/admin/login') {
      if (limited(req, 'admin-login-ip', 20, 15 * 60 * 1000)) return fail(res, 429, 'Too many sign-in attempts. Try again later.');
      const b = await readJson(req);
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase().slice(0, 254) : '';
      const password = typeof b.password === 'string' && b.password.length <= 256 ? b.password : '';
      const emailKey = crypto.createHash('sha256').update(email).digest('hex').slice(0, 24);
      if (limited(req, 'admin-login-email-' + emailKey, 8, 15 * 60 * 1000)) {
        return fail(res, 429, 'Too many sign-in attempts. Try again later.');
      }
      const passwordHash = await new Promise((resolve, reject) => {
        crypto.scrypt(password, ADMIN_PASSWORD_SALT, 64, (error, derived) => error ? reject(error) : resolve(derived));
      });
      const credentialsMatch = Number(safeEqual(email, ADMIN_EMAIL)) & Number(crypto.timingSafeEqual(passwordHash, ADMIN_PASSWORD_HASH));
      if (!credentialsMatch) return fail(res, 401, 'Email or password is incorrect.');

      const id = crypto.randomBytes(32).toString('hex');
      adminSessions.set(id, { expiresAt: Date.now() + ADMIN_SESSION_TTL });
      buckets.delete('admin-login-ip|' + clientIp(req));
      buckets.delete('admin-login-email-' + emailKey + '|' + clientIp(req));
      return json(res, 200, { email: ADMIN_EMAIL }, { 'Set-Cookie': adminCookie(id, ADMIN_SESSION_TTL / 1000) });
    }
    if (method === 'GET' && pathname === '/api/admin/session') {
      if (!adminAuthorised(req)) return json(res, 200, { authenticated: false });
      return json(res, 200, { authenticated: true, email: ADMIN_EMAIL });
    }
    if (method === 'POST' && pathname === '/api/admin/logout') {
      const id = adminSessionId(req);
      if (id) adminSessions.delete(id);
      return json(res, 200, { success: true }, { 'Set-Cookie': adminCookie('', 0) });
    }
    if (!adminAuthorised(req)) {
      return fail(res, 401, 'Not authorised.');
    }
    if (method === 'GET' && pathname === '/api/admin/dashboard') {
      return json(res, 200, { orders: orders.slice().reverse(), products, categories: store.categories, store: { name: store.name } });
    }
    if (method === 'GET' && pathname === '/api/admin/orders') {
      return json(res, 200, { orders: orders.slice().reverse() });
    }
    if (method === 'POST' && pathname === '/api/admin/status') {
      const b = await readJson(req);
      const ref = clean(b.ref, 20).toUpperCase();
      const status = String(b.status || '');
      const order = orders.find((o) => o.ref === ref);
      if (!order || !STATUSES.includes(status)) return fail(res, 400, 'Invalid order or status.');
      order.status = status;
      persist();
      return json(res, 200, { order });
    }
    if (method === 'POST' && pathname === '/api/admin/products') {
      const b = await readJson(req, 32 * 1024);
      const name = clean(b.name, 100);
      const category = clean(b.category, 80);
      const description = clean(b.description, 500);
      const price = Number(b.price);
      const stock = b.stock === null || b.stock === '' || b.stock === undefined ? null : Number(b.stock);
      const image = String(b.image || '').trim();
      const sizes = Array.isArray(b.sizes) ? b.sizes.map((value) => clean(value, 30)).filter(Boolean).slice(0, 30) : [];
      const colors = Array.isArray(b.colors) ? b.colors.map((value) => clean(value, 40)).filter(Boolean).slice(0, 30) : [];
      if (name.length < 2 || !store.categories.some((item) => item.id === category)
        || !Number.isFinite(price) || price < 0.01 || price > 1000000
        || (stock !== null && (!Number.isInteger(stock) || stock < 0 || stock > 1000000))
        || (image && !/^\/(?:uploads|images)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(image)
          && !/^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9._/-]+(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/.test(image))) {
        return fail(res, 400, 'Check the product name, category, price, stock quantity, and image URL.');
      }
      const existingId = clean(b.id, 80);
      let id = existingId;
      if (!id) {
        id = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
        if (!id) id = 'product-' + crypto.randomBytes(4).toString('hex');
        const base = id;
        let suffix = 2;
        while (productById.has(id)) id = base.slice(0, 70 - String(suffix).length) + '-' + suffix++;
      }
      const current = productById.get(id);
      if (existingId && !current) return fail(res, 404, 'Product not found.');
      const saved = {
        id, name, category, price: Math.round(price * 100) / 100,
        inStock: b.inStock === true, preOrder: b.preOrder === true,
        image, description, sizes, colors
      };
      if (stock !== null) saved.stock = stock;
      else if (current && Number.isInteger(current.stock)) saved.stock = current.stock;
      if (current) products = products.map((product) => product.id === id ? saved : product);
      else products.unshift(saved);
      productById = new Map(products.map((product) => [product.id, product]));
      persistProducts();
      return json(res, current ? 200 : 201, { product: saved });
    }
    if (method === 'POST' && pathname === '/api/admin/products/delete') {
      const b = await readJson(req);
      const id = clean(b.id, 80);
      if (!productById.has(id)) return fail(res, 404, 'Product not found.');
      products = products.filter((product) => product.id !== id);
      productById = new Map(products.map((product) => [product.id, product]));
      persistProducts();
      return json(res, 200, { success: true });
    }
    if (method === 'POST' && pathname === '/api/admin/upload') {
      const b = await readJson(req, 6 * 1024 * 1024);
      const mime = String(b.mime || '');
      const data = String(b.data || '');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)
        || !data || data.length > 4 * 1024 * 1024 * 4 / 3 + 8
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        return fail(res, 400, 'Choose a valid JPG, PNG, or WebP image smaller than 4 MB.');
      }
      const bytes = Buffer.from(data, 'base64');
      const validImage = mime === 'image/png'
        ? bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === 'image/jpeg'
          ? bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!validImage || bytes.length > 4 * 1024 * 1024) return fail(res, 400, 'The uploaded file is not a valid supported image.');
      const extension = mime === 'image/jpeg' ? '.jpg' : mime === 'image/png' ? '.png' : '.webp';
      const filename = crypto.randomBytes(18).toString('hex') + extension;
      const uploadDir = path.join(PUBLIC, 'uploads');
      await fs.promises.mkdir(uploadDir, { recursive: true });
      await fs.promises.writeFile(path.join(uploadDir, filename), bytes, { flag: 'wx', mode: 0o644 });
      return json(res, 201, { image: '/uploads/' + filename });
    }
  }

  return fail(res, 404, 'Not found.');
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  try {
    if (limited(req, 'global', 600, 15 * 60 * 1000)) return fail(res, 429, 'Too many requests. Please slow down.');
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { return fail(res, 400, 'Bad request.'); }

    if (pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return send(res, 204, '', { 'Allow': 'GET, POST' }); // no CORS: same-origin only
      return await handleApi(req, res, pathname);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.');
    if (pathname === '/dashboard' || pathname === '/dashboard/') return serveStatic(req, res, '/admin.html');
    return serveStatic(req, res, pathname);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status === 500) console.error('Unhandled error:', err && err.message);
    const msg = status === 413 ? 'Request too large.' : status === 415 ? 'Unsupported content type.' : status === 400 ? 'Invalid request.' : 'Something went wrong. Please try again.';
    if (!res.headersSent) return fail(res, status, msg);
    res.end();
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 20000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;

server.listen(PORT, HOST, () => console.log(`Le-Gacy's Importation running on http://localhost:${PORT}`));
