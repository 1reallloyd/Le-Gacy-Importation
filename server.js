'use strict';
/**
 * Le-Gacy's Importation – store server.
 * PostgreSQL uses the pg driver when DATABASE_URL is configured; JSON files
 * remain available for local development without a database.
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
const { parse: parseCsv } = require('csv-parse/sync');
const { readSheet } = require('read-excel-file/node');

function findProjectRoot() {
  const candidates = [
    process.cwd(),
    __dirname,
    path.join(__dirname, ".."),
    path.resolve(".")
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "data", "store.json"))) {
      return dir;
    }
  }
  return __dirname;
}
const ROOT = findProjectRoot();
const ENV_FILE = path.join(ROOT, ".env");

if (fs.existsSync(ENV_FILE)) {
  const contents = fs.readFileSync(ENV_FILE, "utf8");
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error("Invalid .env entry on line " + (index + 1) + ".");
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function cleanEnv(val) {
  let v = String(val || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const TRUST_PROXY = cleanEnv(process.env.TRUST_PROXY) === "1"; // set when behind Nginx/Vercel/Render etc.
const IS_PROD = process.env.NODE_ENV === "production";
const IS_VERCEL = process.env.VERCEL === "1";
const IMPORT_LEGACY_DATA = cleanEnv(process.env.IMPORT_LEGACY_DATA) === "1" || (!IS_PROD && !IS_VERCEL);
const DATABASE_URL = cleanEnv(process.env.DATABASE_URL);
if (IS_PROD && !DATABASE_URL) {
  throw new Error("Set DATABASE_URL to a PostgreSQL connection string before starting in production.");
}
const PAYSTACK_PUBLIC_KEY = cleanEnv(process.env.PAYSTACK_PUBLIC_KEY);
const PAYSTACK_SECRET_KEY = cleanEnv(process.env.PAYSTACK_SECRET_KEY);
const PAYSTACK_TEST_MODE = cleanEnv(process.env.PAYSTACK_TEST_MODE) === "1";
const PAYSTACK_CONFIGURED = /^pk_(test|live)_[A-Za-z0-9]+$/.test(PAYSTACK_PUBLIC_KEY)
  && /^sk_(test|live)_[A-Za-z0-9]+$/.test(PAYSTACK_SECRET_KEY)
  && PAYSTACK_PUBLIC_KEY.slice(3, 7) === PAYSTACK_SECRET_KEY.slice(3, 7);
if (PAYSTACK_TEST_MODE && (!PAYSTACK_CONFIGURED || !PAYSTACK_PUBLIC_KEY.startsWith("pk_test_"))) {
  throw new Error("PAYSTACK_TEST_MODE=1 requires matching Paystack test keys.");
}
if (IS_PROD && (!PAYSTACK_CONFIGURED || (!PAYSTACK_PUBLIC_KEY.startsWith("pk_live_") && !PAYSTACK_TEST_MODE))) {
  throw new Error("Production requires matching Paystack live public and secret keys.");
}
const ADMIN_EMAIL = cleanEnv(process.env.ADMIN_EMAIL).toLowerCase();
const ADMIN_PASSWORD = cleanEnv(process.env.ADMIN_PASSWORD);
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ADMIN_EMAIL) || ADMIN_PASSWORD.length < 20 || ADMIN_PASSWORD.length > 256) {
  throw new Error("Set ADMIN_EMAIL and an ADMIN_PASSWORD of 20–256 characters in .env before starting the server.");
}

const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(PUBLIC, "uploads"));
const ORDERS_FILE = path.join(DATA, "orders.json");
const PRODUCTS_FILE = path.join(DATA, "products.json");
const ANALYTICS_FILE = path.join(DATA, "analytics.json");
const ANALYTICS_RETENTION_DAYS = 90;
const PRODUCT_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
const PRODUCT_IMPORT_MAX_ROWS = 500;
const PRODUCT_IMPORT_COLUMNS = new Set([
  "id", "name", "category", "price", "instock", "preorder", "stock", "qty",
  "description", "sizes", "colors", "image"
]);

let store = { name: "Le-Gacy's Importation", currency: "GHS" };
try {
  if (fs.existsSync(path.join(DATA, "store.json"))) {
    store = JSON.parse(fs.readFileSync(path.join(DATA, "store.json"), "utf8"));
  }
} catch (e) {
  console.warn("Could not load store.json:", e.message);
}

let products = [];
try {
  if (fs.existsSync(PRODUCTS_FILE)) {
    products = JSON.parse(fs.readFileSync(PRODUCTS_FILE, "utf8"));
  }
} catch (e) {
  console.warn("Could not load products.json:", e.message);
}
let productById = new Map(products.map((p) => [p.id, p]));
const database = DATABASE_URL ? require("./database") : null;
let databaseReady = false;

async function prepareUploadsDirectory() {
  await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
  const legacyUploads = path.join(PUBLIC, 'uploads');
  if (UPLOADS_DIR === path.resolve(legacyUploads)) return;

  let entries;
  try {
    entries = await fs.promises.readdir(legacyUploads, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9._-]+$/.test(entry.name)) continue;
    const source = path.join(legacyUploads, entry.name);
    const destination = path.join(UPLOADS_DIR, entry.name);
    try {
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

const ADMIN_PASSWORD_SALT = crypto.randomBytes(16);
const ADMIN_PASSWORD_HASH = crypto.scryptSync(ADMIN_PASSWORD, ADMIN_PASSWORD_SALT, 64);
const ADMIN_SESSION_TTL = 8 * 60 * 60 * 1000;
const adminSessions = new Map();
const ADMIN_LOGIN_FAILURE_LIMIT = 4;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const adminLoginFailures = new Map();

/* ------------------------------------------------------------------ */
/* Orders storage (PostgreSQL or atomic JSON-file writes)              */
/* ------------------------------------------------------------------ */
let orders = [];
try {
  orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Could not load orders: ' + error.message);
}

let storeAnalytics = { days: [] };
try {
  const savedAnalytics = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
  if (savedAnalytics && Array.isArray(savedAnalytics.days)) {
    storeAnalytics.days = savedAnalytics.days.filter((day) => day && /^\d{4}-\d{2}-\d{2}$/.test(day.date)
      && Number.isInteger(day.views) && day.views >= 0 && Array.isArray(day.visitors))
      .map((day) => ({
        date: day.date,
        views: day.views,
        visitors: [...new Set(day.visitors.filter((visitor) => typeof visitor === 'string' && /^[a-f0-9]{64}$/.test(visitor)))]
      }));
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw new Error('Could not load store analytics: ' + error.message);
}

let analyticsWriting = false;
let analyticsDirty = false;
function persistStoreAnalytics() {
  analyticsDirty = true;
  if (analyticsWriting) return;
  analyticsWriting = true;
  (async () => {
    while (analyticsDirty) {
      analyticsDirty = false;
      const tmp = ANALYTICS_FILE + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(storeAnalytics), { mode: 0o600 });
      await fs.promises.rename(tmp, ANALYTICS_FILE);
    }
    analyticsWriting = false;
  })().catch((error) => {
    analyticsWriting = false;
    console.error('Could not save store analytics:', error.message);
  });
}

async function recordStoreVisit(visitorId) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ANALYTICS_RETENTION_DAYS + 1))
    .toISOString().slice(0, 10);
  const visitorHash = crypto.createHash('sha256').update(visitorId).digest('hex');
  const addVisit = (currentDays) => {
    const days = currentDays.filter((day) => day.date >= cutoff)
      .map((day) => ({ ...day, visitors: day.visitors.slice() }));
    let day = days.find((entry) => entry.date === today);
    if (!day) {
      day = { date: today, views: 0, visitors: [] };
      days.push(day);
    }
    day.views += 1;
    if (!day.visitors.includes(visitorHash)) day.visitors.push(visitorHash);
    return days;
  };
  storeAnalytics.days = database
    ? await database.updateAnalytics(addVisit)
    : addVisit(storeAnalytics.days);
  if (!database) persistStoreAnalytics();
}

function storeAnalyticsSummary(days) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1));
  const startDate = start.toISOString().slice(0, 10);
  const records = storeAnalytics.days.filter((day) => day.date >= startDate);
  const visitors = new Set(records.flatMap((day) => day.visitors));
  const dailyByDate = new Map(records.map((day) => [day.date, day]));
  const paidOrders = orders.filter((order) => ['confirmed', 'processing', 'dispatched', 'delivered'].includes(order.status)
    && Date.parse(order.createdAt) >= start.getTime());
  const productsSold = new Map();
  paidOrders.forEach((order) => {
    (Array.isArray(order.items) ? order.items : []).forEach((item) => {
      const id = typeof item.id === 'string' ? item.id : item.name;
      const existing = productsSold.get(id) || {
        id,
        name: item.name || id,
        category: (productById.get(id) || {}).category || '',
        quantity: 0,
        revenue: 0
      };
      const quantity = Number.isInteger(item.qty) && item.qty > 0 ? item.qty : 0;
      existing.quantity += quantity;
      existing.revenue += Number(item.price || 0) * quantity;
      productsSold.set(id, existing);
    });
  });
  const salesByDate = new Map();
  paidOrders.forEach((order) => {
    const date = new Date(order.createdAt).toISOString().slice(0, 10);
    salesByDate.set(date, (salesByDate.get(date) || 0) + 1);
  });
  const daily = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + offset);
    const key = date.toISOString().slice(0, 10);
    const record = dailyByDate.get(key);
    daily.push({
      date: key,
      pageViews: record ? record.views : 0,
      visitors: record ? new Set(record.visitors).size : 0,
      paidOrders: salesByDate.get(key) || 0
    });
  }
  return {
    days,
    pageViews: records.reduce((sum, day) => sum + day.views, 0),
    uniqueVisitors: visitors.size,
    paidOrders: paidOrders.length,
    itemsSold: [...productsSold.values()].reduce((sum, item) => sum + item.quantity, 0),
    revenue: paidOrders.reduce((sum, order) => sum + Number(order.subtotal || 0), 0),
    daily,
    topProducts: [...productsSold.values()]
      .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
      .slice(0, 10)
  };
}

let orderWriteQueue = Promise.resolve();
async function writeJsonAtomically(file, value) {
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(tmp, file);
  } catch (error) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function persist(order, updatedOrder) {
  const savedOrder = updatedOrder || order;
  const write = orderWriteQueue.then(async () => {
    const storedIndex = orders.findIndex((entry) => entry.ref === order.ref);
    if (database) {
      const expectedUpdatedAt = updatedOrder
        ? order.updatedAt || order.createdAt
        : undefined;
      await database.saveOrder(savedOrder, expectedUpdatedAt);
    } else {
      const nextOrders = orders.slice();
      if (storedIndex < 0) nextOrders.push(savedOrder);
      else nextOrders[storedIndex] = savedOrder;
      await writeJsonAtomically(ORDERS_FILE, nextOrders);
      orders = nextOrders;
    }
    if (savedOrder !== order) Object.assign(order, savedOrder);
    if (storedIndex < 0) orders.push(order);
    else orders[storedIndex] = order;
  });
  orderWriteQueue = write.catch(() => {});
  await write;
}

let productWriteQueue = Promise.resolve();
async function persistProducts(updateProducts) {
  const write = productWriteQueue.then(async () => {
    const nextProducts = database
      ? await database.updateProducts(updateProducts)
      : updateProducts(products);
    if (!Array.isArray(nextProducts)) throw new TypeError('Product updates must return a product list.');
    if (!database) await writeJsonAtomically(PRODUCTS_FILE, nextProducts);
    products = nextProducts;
    productById = new Map(products.map((product) => [product.id, product]));
  });
  productWriteQueue = write.catch(() => {});
  await write;
}

function validProductImage(image) {
  if (!image || /^\/(?:uploads|images)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(image)) return true;
  try {
    const url = new URL(image);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function importCellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function parseImportBoolean(value, fallback, label, rowNumber, errors) {
  const text = importCellText(value).toLowerCase();
  if (!text) return fallback;
  if (['true', 'yes', '1'].includes(text)) return true;
  if (['false', 'no', '0'].includes(text)) return false;
  errors.push({ row: rowNumber, message: label + ' must be true or false.' });
  return fallback;
}

function importProductId(value, name, usedIds) {
  const supplied = importCellText(value).toLowerCase();
  if (supplied && !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(supplied)) return null;
  const baseId = supplied || name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
  if (!baseId) return null;
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id) || (!supplied && productById.has(id))) {
    if (supplied) return null;
    id = baseId.slice(0, 70 - String(suffix).length) + '-' + suffix++;
  }
  return id;
}

async function parseProductImport(body) {
  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : '';
  const extension = path.extname(fileName).toLowerCase();
  const encoded = typeof body.data === 'string' ? body.data : '';
  const maxEncodedLength = Math.ceil(PRODUCT_IMPORT_MAX_BYTES / 3) * 4;
  if (!fileName || fileName.length > 200 || /[\u0000-\u001f]/.test(fileName)
    || !['.xlsx', '.csv'].includes(extension)
    || !encoded || encoded.length > maxEncodedLength
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw Object.assign(new Error('Choose a valid .xlsx or .csv product file smaller than 5 MB.'), { status: 400 });
  }

  const workbook = Buffer.from(encoded, 'base64');
  if (!workbook.length || workbook.length > PRODUCT_IMPORT_MAX_BYTES) {
    throw Object.assign(new Error('The product file must be smaller than 5 MB.'), { status: 400 });
  }

  let rowEntries;
  try {
    if (extension === '.xlsx') {
      if (workbook[0] !== 0x50 || workbook[1] !== 0x4b) throw new Error('not an XLSX archive');
      const rows = await readSheet(workbook);
      rowEntries = rows.map((row, index) => ({ row, rowNumber: index + 1 }));
    } else {
      const records = parseCsv(workbook.toString('utf8'), {
        bom: true,
        skip_empty_lines: true,
        relax_column_count: false,
        max_record_size: 100000,
        info: true
      });
      let previousLine = 0;
      let previousEmptyLines = 0;
      rowEntries = records.map(({ record, info }) => {
        const rowNumber = previousLine + info.empty_lines - previousEmptyLines + 1;
        previousLine = info.lines;
        previousEmptyLines = info.empty_lines;
        return { row: record, rowNumber };
      });
    }
  } catch {
    throw Object.assign(new Error('The spreadsheet could not be read. Use a valid .xlsx or .csv file.'), { status: 400 });
  }

  if (!Array.isArray(rowEntries) || rowEntries.length < 2) {
    return { valid: false, errors: [{ row: 1, message: 'Add a header row and at least one product.' }] };
  }
  const headers = rowEntries[0].row.map((value) => importCellText(value).toLowerCase());
  const headerRowNumber = rowEntries[0].rowNumber;
  const columnIndexes = new Map();
  const errors = [];
  headers.forEach((header, index) => {
    if (!header) return;
    if (!PRODUCT_IMPORT_COLUMNS.has(header)) {
      errors.push({ row: headerRowNumber, message: 'Unknown column "' + header + '". Use the downloadable template headers.' });
    } else {
      const normalizedHeader = header === 'qty' ? 'stock' : header;
      if (columnIndexes.has(normalizedHeader)) {
        errors.push({ row: headerRowNumber, message: 'Use either "qty" or "stock" for inventory quantity, not both.' });
      } else {
        columnIndexes.set(normalizedHeader, index);
      }
    }
  });
  for (const required of ['name', 'category', 'price']) {
    if (!columnIndexes.has(required)) errors.push({ row: headerRowNumber, message: 'Required column "' + required + '" is missing.' });
  }
  if (errors.length) return { valid: false, errors };

  const dataRows = rowEntries.slice(1)
    .filter(({ row }) => Array.isArray(row) && row.some((value) => importCellText(value) !== ''));
  if (dataRows.length > PRODUCT_IMPORT_MAX_ROWS) {
    return { valid: false, errors: [{ row: 1, message: 'The file exceeds the limit of ' + PRODUCT_IMPORT_MAX_ROWS + ' products.' }] };
  }
  const usedIds = new Set();
  const imported = [];
  const summaries = [];

  dataRows.forEach(({ row, rowNumber }) => {
    if (row.length > headers.length && row.slice(headers.length).some((value) => importCellText(value) !== '')) {
      errors.push({ row: rowNumber, message: 'This row contains values beyond the header columns.' });
      return;
    }
    const valueFor = (column) => columnIndexes.has(column) ? row[columnIndexes.get(column)] : undefined;
    const name = clean(valueFor('name'), 100);
    const categoryInput = importCellText(valueFor('category')).toLowerCase();
    const category = store.categories.find((item) => item.id.toLowerCase() === categoryInput
      || item.name.trim().toLowerCase() === categoryInput);
    const priceText = importCellText(valueFor('price'));
    const price = typeof valueFor('price') === 'number' ? valueFor('price') : Number(priceText);
    let rowInvalid = false;
    const addError = (message) => { errors.push({ row: rowNumber, message }); rowInvalid = true; };

    if (name.length < 2) addError('Product name must contain at least 2 characters.');
    if (!category) addError('Category must match a store category ID or name.');
    if (!priceText) addError('Price is required.');
    else if (!Number.isFinite(price)) addError('Price must be a valid number.');
    else if (price < 0.01) addError('Price must be greater than 0.');
    else if (price > 1000000) addError('Price must not exceed 1,000,000.');

    const suppliedId = importCellText(valueFor('id'));
    const id = importProductId(suppliedId, name, usedIds);
    if (!id) addError(suppliedId ? 'Product ID is invalid or duplicated in this file.' : 'Product name cannot be converted into a unique product ID.');
    else usedIds.add(id);

    const current = id && productById.get(id);
    const parseOptionalNumber = (column, fallback, wholeNumber, maximum) => {
      if (!columnIndexes.has(column) || !importCellText(valueFor(column))) return fallback;
      const rawValue = valueFor(column);
      const text = importCellText(rawValue);
      const parsed = typeof rawValue === 'number' ? rawValue : Number(text);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > maximum || (wholeNumber && !Number.isInteger(parsed))) {
        addError(column === 'stock'
          ? 'Stock must be a whole number between 0 and 1,000,000.'
          : 'Price must be a valid number.');
        return fallback;
      }
      return parsed;
    };
    const inStock = columnIndexes.has('instock')
      ? parseImportBoolean(valueFor('instock'), current ? current.inStock : true, 'inStock', rowNumber, errors)
      : current ? current.inStock : true;
    const preOrder = columnIndexes.has('preorder')
      ? parseImportBoolean(valueFor('preorder'), current ? current.preOrder === true : false, 'preOrder', rowNumber, errors)
      : current ? current.preOrder === true : false;
    const stock = parseOptionalNumber('stock', current ? current.stock : undefined, true, 1000000);
    const imageInput = columnIndexes.has('image') ? clean(valueFor('image'), 1000) : '';
    const image = imageInput || (current ? current.image || '' : '');
    if (!validProductImage(image)) addError('Image must be a /uploads or /images path, or a supported HTTPS Cloudinary URL.');

    const parseList = (column) => {
      if (!columnIndexes.has(column) || !importCellText(valueFor(column))) {
        return current && Array.isArray(current[column]) ? current[column] : [];
      }
      return importCellText(valueFor(column)).split(',').map((item) => clean(item, column === 'sizes' ? 30 : 40))
        .filter(Boolean).slice(0, 30);
    };
    const description = columnIndexes.has('description') && importCellText(valueFor('description'))
      ? clean(valueFor('description'), 500)
      : current ? current.description || '' : '';

    if (rowInvalid) return;
    const product = {
      id,
      name,
      category: category.id,
      price: Math.round(price * 100) / 100,
      inStock,
      preOrder,
      image,
      description,
      sizes: parseList('sizes'),
      colors: parseList('colors')
    };
    if (stock !== undefined) product.stock = stock;
    imported.push({ product, current });
    summaries.push({ row: rowNumber, id, name, action: current ? 'update' : 'add', price: product.price });
  });

  if (errors.length) return { valid: false, errors };
  if (imported.length === 0) return { valid: false, errors: [{ row: 2, message: 'No product rows were found.' }] };
  return {
    valid: true,
    imported,
    summaries,
    added: imported.filter((item) => !item.current).length,
    updated: imported.filter((item) => item.current).length
  };
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

async function adminAuthorised(req) {
  const id = adminSessionId(req);
  const session = id && (database ? await database.getAdminSession(id) : adminSessions.get(id));
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    if (database) await database.deleteAdminSession(id);
    else adminSessions.delete(id);
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
    updatedAt: o.updatedAt || o.createdAt,
    customerName: o.customer.name,
    customerEmail: o.customer.email || '',
    items: o.items,
    subtotal: o.subtotal,
    paymentSubmitted: !!o.payment
  };
}

function clientIp(req) {
  if (TRUST_PROXY && req && req.headers) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

/* ------------------------------------------------------------------ */
/* Rate limiting (fixed window, in memory)                            */
/* ------------------------------------------------------------------ */
const buckets = new Map();
async function limited(req, name, max, windowMs) {
  const key = name + '|' + clientIp(req);
  if (database) {
    const bucket = await database.incrementRateLimit(key, windowMs);
    return bucket.count > max;
  }
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.count += 1;
  return b.count > max;
}
async function recordAdminLoginFailure(req) {
  const key = clientIp(req);
  if (database) return database.incrementRateLimit('admin-login|' + key, ADMIN_LOGIN_WINDOW_MS);
  const now = Date.now();
  let bucket = adminLoginFailures.get(key);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + ADMIN_LOGIN_WINDOW_MS };
    adminLoginFailures.set(key, bucket);
  }
  bucket.count += 1;
  return bucket;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
  for (const [k, b] of adminLoginFailures) if (b.reset <= now) adminLoginFailures.delete(k);
  if (database && databaseReady) {
    database.pruneAuthState().catch((error) => {
      console.error('Could not prune expired authentication data:', error.message);
    });
  }
}, 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/* Responses                                                          */
/* ------------------------------------------------------------------ */
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://js.paystack.co",
    "style-src 'self' 'unsafe-inline' https://paystack.com/public/css/",
    "img-src 'self' data: https:",
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

function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('too large'), { status: 413 }));
      resolve(Buffer.concat(chunks));
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
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8'
};

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return fail(res, 400, 'Bad request.'); }
  if (rel.includes('\0')) return fail(res, 400, 'Bad request.');
  if (rel === '/') rel = '/index.html';
  const isUpload = rel.startsWith('/uploads/');
  const root = isUpload ? UPLOADS_DIR : PUBLIC;
  const relativePath = isUpload ? rel.slice('/uploads/'.length) : rel.replace(/^[\/\\]/, '');
  const file = path.resolve(root, relativePath);
  if (file !== root && !file.startsWith(root + path.sep)) return fail(res, 403, 'Forbidden.');

  let st;
  try {
    st = await fs.promises.stat(file);
    if (!st.isFile()) throw new Error('Not a file');
  } catch {
    if (path.extname(rel)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    return await serveStatic(req, res, '/index.html');
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
  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      if (!res.headersSent) fail(res, 500, 'Failed to read file.');
      reject(err);
    });
    res.on('finish', resolve);
    res.on('close', resolve);
    stream.pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */
async function handleApi(req, res, pathname) {
  const method = req.method;

  if (method === 'POST' && pathname === '/api/store/visit') {
    if (!sameOrigin(req)) return fail(res, 403, 'Request rejected.');
    if (await limited(req, 'store-visit', 120, 15 * 60 * 1000)) return fail(res, 429, 'Too many visits recorded. Please try again later.');
    const body = await readJson(req, 1024);
    const visitorId = typeof body.visitorId === 'string' ? body.visitorId : '';
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(visitorId)) {
      return fail(res, 400, 'A valid visitor ID is required.');
    }
    await recordStoreVisit(visitorId.toLowerCase());
    return json(res, 202, { success: true });
  }

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
    if (await limited(req, 'order', 10, 60 * 60 * 1000)) return fail(res, 429, 'Too many orders from this device. Please try again later or contact us on WhatsApp.');
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
      updatedAt: new Date().toISOString(),
      customer: { name, email, phone, town, address, notes },
      items: lines,
      subtotal: pesewas / 100,
      payment: null
    };
    await persist(order);
    return json(res, 201, { order: publicOrder(order) });
  }

  /* ---- create Paystack payment reference ---- */
  if (method === 'POST' && pathname === '/api/orders/paystack/reference') {
    if (await limited(req, 'paystack-reference', 20, 15 * 60 * 1000)) return fail(res, 429, 'Too many payment attempts. Please wait and try again.');
    if (!PAYSTACK_CONFIGURED) return fail(res, 503, 'Online payment is not available right now. Please contact us on WhatsApp.');
    const b = await readJson(req);
    const ref = clean(b.ref, 20).toUpperCase();
    const phone = normalizePhone(b.phone);
    const order = phone && orders.find((o) => o.ref === ref && o.customer.phone === phone);
    if (!order) return fail(res, 404, 'We could not find an order with those details.');
    if (order.status !== 'awaiting_payment') return fail(res, 409, 'This order is no longer awaiting payment.');

    const reference = 'LG' + crypto.randomBytes(16).toString('hex');
    const updatedOrder = {
      ...order,
      paystackReferences: [...(Array.isArray(order.paystackReferences) ? order.paystackReferences : []), reference]
    };
    await persist(order, updatedOrder);
    return json(res, 200, { reference });
  }

  /* ---- verify Paystack payment server-side ---- */
  if (method === 'POST' && pathname === '/api/orders/paystack/verify') {
    if (await limited(req, 'paystack-verify', 20, 15 * 60 * 1000)) return fail(res, 429, 'Too many payment checks. Please wait and try again.');
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

    await persist(order, {
      ...order,
      payment: {
        provider: 'paystack',
        reference,
        transactionId: payment.id,
        channel: clean(payment.channel, 40),
        amount: payment.amount / 100,
        paidAt: payment.paid_at || new Date().toISOString()
      },
      status: 'confirmed',
      updatedAt: new Date().toISOString()
    });
    return json(res, 200, { order: publicOrder(order) });
  }

  /* ---- track / fetch own order ---- */
  if (method === 'POST' && pathname === '/api/orders/track') {
    if (await limited(req, 'track', 20, 15 * 60 * 1000)) return fail(res, 429, 'Too many attempts. Please wait a few minutes and try again.');
    const b = await readJson(req);
    const ref = clean(b.ref, 20).toUpperCase();
    const phone = normalizePhone(b.phone);
    const order = phone && orders.find((o) => o.ref === ref && o.customer.phone === phone);
    if (!order) return fail(res, 404, 'We could not find an order with those details.');
    return json(res, 200, { order: publicOrder(order) });
  }

  /* ---- submit Mobile Money payment details ---- */
  if (method === 'POST' && pathname === '/api/orders/pay') {
    if (await limited(req, 'pay', 15, 15 * 60 * 1000)) return fail(res, 429, 'Too many attempts. Please wait a few minutes and try again.');
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
    await persist(order, {
      ...order,
      payment: { txnId, payerName, submittedAt: new Date().toISOString(), amount: order.subtotal },
      status: 'payment_submitted',
      updatedAt: new Date().toISOString()
    });
    return json(res, 200, { order: publicOrder(order) });
  }

  /* ---- admin ---- */
  if (pathname.startsWith('/api/admin/')) {
    if (await limited(req, 'admin', 300, 15 * 60 * 1000)) return fail(res, 429, 'Too many requests.');
    if (method === 'POST' && !sameOrigin(req)) return fail(res, 403, 'Request rejected.');
    if (method === 'POST' && pathname === '/api/admin/login') {
      const b = await readJson(req);
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase().slice(0, 254) : '';
      const password = typeof b.password === 'string' && b.password.length <= 256 ? b.password : '';
      const failures = await recordAdminLoginFailure(req);
      if (failures.count > ADMIN_LOGIN_FAILURE_LIMIT) {
        return fail(res, 429, 'Too many incorrect sign-in attempts. Please wait 15 minutes before trying again.');
      }
      const passwordHash = await new Promise((resolve, reject) => {
        crypto.scrypt(password, ADMIN_PASSWORD_SALT, 64, (error, derived) => error ? reject(error) : resolve(derived));
      });
      const credentialsMatch = Number(safeEqual(email, ADMIN_EMAIL)) & Number(crypto.timingSafeEqual(passwordHash, ADMIN_PASSWORD_HASH));
      if (!credentialsMatch) {
        if (failures.count >= ADMIN_LOGIN_FAILURE_LIMIT) {
          return fail(res, 429, 'Too many incorrect sign-in attempts. Please wait 15 minutes before trying again.');
        }
        return fail(res, 401, 'Email or password is incorrect.');
      }

      const id = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + ADMIN_SESSION_TTL;
      if (database) await database.saveAdminSession(id, expiresAt);
      else adminSessions.set(id, { expiresAt });
      if (database) await database.clearRateLimit('admin-login|' + clientIp(req));
      adminLoginFailures.delete(clientIp(req));
      return json(res, 200, { email: ADMIN_EMAIL }, { 'Set-Cookie': adminCookie(id, ADMIN_SESSION_TTL / 1000) });
    }
    if (method === 'GET' && pathname === '/api/admin/session') {
      if (!await adminAuthorised(req)) return json(res, 200, { authenticated: false });
      return json(res, 200, { authenticated: true, email: ADMIN_EMAIL });
    }
    if (method === 'POST' && pathname === '/api/admin/logout') {
      const id = adminSessionId(req);
      if (id) {
        if (database) await database.deleteAdminSession(id);
        else adminSessions.delete(id);
      }
      return json(res, 200, { success: true }, { 'Set-Cookie': adminCookie('', 0) });
    }
    if (!await adminAuthorised(req)) {
      return fail(res, 401, 'Not authorised.');
    }
    if (method === 'GET' && pathname === '/api/admin/dashboard') {
      return json(res, 200, { orders: orders.slice().reverse(), products, categories: store.categories, store: { name: store.name } });
    }
    if (method === 'GET' && pathname === '/api/admin/analytics') {
      const requestedDays = Number(new URL(req.url, 'http://x').searchParams.get('days'));
      const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
      return json(res, 200, storeAnalyticsSummary(days));
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
      const updatedOrder = order.status === status ? order : {
        ...order,
        status,
        updatedAt: new Date().toISOString()
      };
      await persist(order, updatedOrder);
      return json(res, 200, { order });
    }
    if (method === 'POST' && pathname === '/api/admin/products/import/preview') {
      try {
        const body = await readJson(req, 7 * 1024 * 1024);
        const result = await parseProductImport(body);
        return json(res, 200, result.valid
          ? { valid: true, added: result.added, updated: result.updated, products: result.summaries }
          : { valid: false, errors: result.errors });
      } catch (error) {
        if (!error.status) console.error('Product import preview failed:', error.message);
        const status = error.status || 500;
        return fail(res, status, status === 413
          ? 'The spreadsheet request is too large.'
          : status === 400 ? error.message : 'The spreadsheet could not be previewed. Please try again.');
      }
    }
    if (method === 'POST' && pathname === '/api/admin/products/import') {
      try {
        const body = await readJson(req, 7 * 1024 * 1024);
        const result = await parseProductImport(body);
        if (!result.valid) return json(res, 400, { error: 'Fix the spreadsheet errors before importing.', rows: result.errors });
        const updates = new Map(result.imported.map(({ product }) => [product.id, product]));
        const additions = result.imported.filter(({ current }) => !current).map(({ product }) => product);
        const updatedIds = new Set(result.imported.filter(({ current }) => current).map(({ product }) => product.id));
        await persistProducts((currentProducts) => {
          const currentIds = new Set(currentProducts.map((product) => product.id));
          if (additions.some((product) => currentIds.has(product.id))
            || [...updatedIds].some((id) => !currentIds.has(id))) {
            throw Object.assign(new Error('The catalog changed while this spreadsheet was being imported. Review it and try again.'), { status: 409 });
          }
          const nextProducts = currentProducts.map((product) => updates.get(product.id) || product);
          return [...additions, ...nextProducts];
        });
        return json(res, 200, {
          added: result.added,
          updated: result.updated,
          products: result.imported.map(({ product }) => product)
        });
      } catch (error) {
        if (!error.status) console.error('Product import failed:', error.message);
        const status = error.status || 500;
        return fail(res, status, status === 413
          ? 'The spreadsheet request is too large.'
          : status < 500 ? error.message : 'Products could not be imported. Please try again.');
      }
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
        || !validProductImage(image)) {
        return fail(res, 400, 'Check the product name, category, price, stock quantity, and image URL.');
      }
      const existingId = clean(b.id, 80);
      const baseId = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70)
        || 'product-' + crypto.randomBytes(4).toString('hex');
      let saved;
      let created;
      await persistProducts((currentProducts) => {
        let id = existingId || baseId;
        if (!existingId) {
          let suffix = 2;
          while (currentProducts.some((product) => product.id === id)) {
            id = baseId.slice(0, 70 - String(suffix).length) + '-' + suffix++;
          }
        }
        const current = currentProducts.find((product) => product.id === id);
        if (existingId && !current) {
          throw Object.assign(new Error('Product not found.'), { status: 404 });
        }
        saved = {
          id, name, category, price: Math.round(price * 100) / 100,
          inStock: b.inStock === true, preOrder: b.preOrder === true,
          image, description, sizes, colors
        };
        if (stock !== null) saved.stock = stock;
        else if (current && Number.isInteger(current.stock)) saved.stock = current.stock;
        created = !current;
        return current
          ? currentProducts.map((product) => product.id === id ? saved : product)
          : [saved, ...currentProducts];
      });
      return json(res, created ? 201 : 200, { product: saved });
    }
    if (method === 'POST' && pathname === '/api/admin/products/delete') {
      const b = await readJson(req);
      const id = clean(b.id, 80);
      let deleted = false;
      await persistProducts((currentProducts) => {
        const nextProducts = currentProducts.filter((product) => product.id !== id);
        deleted = nextProducts.length !== currentProducts.length;
        return deleted ? nextProducts : currentProducts;
      });
      if (!deleted) return fail(res, 404, 'Product not found.');
      return json(res, 200, { success: true });
    }
    if (method === 'POST' && pathname === '/api/admin/upload') {
      const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!sameOrigin(req)) return fail(res, 403, 'Request rejected.');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
        return fail(res, 400, 'Choose a valid JPG, PNG, or WebP image smaller than 4 MB.');
      }
      const bytes = await readBuffer(req, 4 * 1024 * 1024);
      const validImage = mime === 'image/png'
        ? bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : mime === 'image/jpeg'
          ? bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!validImage || bytes.length > 4 * 1024 * 1024) return fail(res, 400, 'The uploaded file is not a valid supported image.');
      const extension = mime === 'image/jpeg' ? '.jpg' : mime === 'image/png' ? '.png' : '.webp';
      const filename = crypto.randomBytes(18).toString('hex') + extension;
      if (IS_VERCEL) {
        const { put } = require('@vercel/blob');
        const blob = await put('uploads/' + filename, bytes, {
          access: 'public',
          contentType: mime,
          addRandomSuffix: false
        });
        return json(res, 201, { image: blob.url });
      }
      await fs.promises.writeFile(path.join(UPLOADS_DIR, filename), bytes, { flag: 'wx', mode: 0o644 });
      return json(res, 201, { image: '/uploads/' + filename });
    }
  }

  return fail(res, 404, 'Not found.');
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */
async function handleRequest(req, res) {
  try {
    await ensureInitialized();
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { return fail(res, 400, 'Bad request.'); }

    if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (database) await database.healthCheck();
      return json(res, 200, { status: 'ok' }, { 'Cache-Control': 'no-store' });
    }

    if (pathname.startsWith('/api/') && database) {
      const current = await database.loadState();
      products = current.products;
      orders = current.orders;
      storeAnalytics = current.analytics;
      productById = new Map(products.map((product) => [product.id, product]));
    }

    if (await limited(req, 'global', 600, 15 * 60 * 1000)) return fail(res, 429, 'Too many requests. Please slow down.');

    if (pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return send(res, 204, '', { 'Allow': 'GET, POST' }); // no CORS: same-origin only
      return await handleApi(req, res, pathname);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.');
    if (pathname === '/dashboard' || pathname === '/dashboard/') return await serveStatic(req, res, '/admin.html');
    return await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status === 500) console.error('Unhandled error:', err && err.message);
    const msg = status === 413 ? 'Request too large.'
      : status === 415 ? 'Unsupported content type.'
        : status === 400 ? 'Invalid request.'
          : status === 404 ? 'Not found.'
            : status === 409 ? 'The data changed while you were working. Refresh and try again.'
              : 'Something went wrong. Please try again.';
    if (!res.headersSent) return fail(res, status, msg);
    res.end();
  }
}

const server = http.createServer(handleRequest);
server.headersTimeout = 15000;
server.requestTimeout = 20000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;

let initialization;
async function ensureInitialized() {
  if (!initialization) {
    initialization = (async () => {
      if (!IS_VERCEL) await prepareUploadsDirectory();
      if (!database) {
        console.warn('DATABASE_URL is not set; using local JSON-file storage.');
        return;
      }
      const saved = await database.initialize({
        products: IMPORT_LEGACY_DATA ? products : [],
        orders: IMPORT_LEGACY_DATA ? orders : [],
        analytics: IMPORT_LEGACY_DATA ? storeAnalytics : { days: [] }
      });
      products = saved.products;
      orders = saved.orders;
      storeAnalytics = saved.analytics;
      productById = new Map(products.map((product) => [product.id, product]));
      await database.pruneAuthState();
      databaseReady = true;
      console.log('PostgreSQL connected; database data is ready.');
    })();
  }
  return initialization;
}

async function startServer() {
  await ensureInitialized();
  server.listen(PORT, HOST, () => console.log(`Le-Gacy's Importation running on http://localhost:${PORT}`));
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; shutting down.`);
  server.close(async (error) => {
    if (database) await database.close();
    if (error) {
      console.error('Could not shut down cleanly:', error.message);
      process.exitCode = 1;
    }
  });
  setTimeout(() => {
    console.error('Graceful shutdown timed out.');
    process.exit(1);
  }, 10000).unref();
}

if (require.main === module) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  startServer().catch(async (error) => {
    console.error('Could not start the server:', error.message);
    if (database) await database.close();
    process.exitCode = 1;
  });
}

module.exports = { handler: handleRequest };
