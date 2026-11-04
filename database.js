'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

function getSslConfig() {
  const url = String(process.env.DATABASE_URL || '');
  if (!url || url.includes('localhost') || url.includes('127.0.0.1') || url.includes('sslmode=disable')) {
    return false;
  }
  return { rejectUnauthorized: false };
}

const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: getSslConfig(),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: process.env.VERCEL === '1' ? 1 : 10,
  allowExitOnIdle: process.env.VERCEL === '1'
}) : null;

if (pool) {
  pool.on('error', (error) => {
    console.error('Unexpected PostgreSQL pool error:', error.message);
  });
}

async function transaction(callback) {
  if (!pool) throw new Error('Database connection not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function saveProductRows(client, products) {
  for (const [position, product] of products.entries()) {
    const data = typeof product === 'string' ? product : JSON.stringify(product);
    await client.query(
      `INSERT INTO products (id, position, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, data = EXCLUDED.data`,
      [product.id, position, data]
    );
  }
}

async function saveOrderRow(client, order) {
  const data = typeof order === 'string' ? order : JSON.stringify(order);
  await client.query(
    `INSERT INTO orders (reference, customer_phone, status, created_at, data)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (reference) DO UPDATE
       SET customer_phone = EXCLUDED.customer_phone,
           status = EXCLUDED.status,
           created_at = EXCLUDED.created_at,
           data = EXCLUDED.data`,
    [order.ref, order.customer.phone, order.status, order.createdAt, data]
  );
}

const PRODUCT_WRITE_LOCK = 746851204092;
const ANALYTICS_WRITE_LOCK = 746851204093;

async function loadAnalyticsRows(client) {
  const result = await client.query('SELECT date, views, visitors FROM analytics_days ORDER BY date');
  return result.rows.map((row) => ({
    date: row.date.toISOString ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
    views: row.views,
    visitors: row.visitors
  }));
}

async function writeAnalyticsRows(client, days) {
  for (const day of days) {
    await client.query(
      `INSERT INTO analytics_days (date, views, visitors)
       VALUES ($1, $2, $3)
       ON CONFLICT (date) DO UPDATE SET views = EXCLUDED.views, visitors = EXCLUDED.visitors`,
      [day.date, day.views, JSON.stringify(day.visitors)]
    );
  }
}

async function seedAnalyticsRows(client, days) {
  for (const day of days) {
    await client.query(
      `INSERT INTO analytics_days (date, views, visitors)
       VALUES ($1, $2, $3)
       ON CONFLICT (date) DO NOTHING`,
      [day.date, day.views, JSON.stringify(day.visitors)]
    );
  }
}

function loadBundledProducts() {
  try {
    const file = path.join(__dirname, 'data', 'products.json');
    const products = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(products) ? products : [];
  } catch (error) {
    console.warn('Could not load bundled product catalog for database seeding:', error.message);
    return [];
  }
}

async function initialize(seed) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS products (
      id text PRIMARY KEY,
      position integer NOT NULL,
      data jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      reference text PRIMARY KEY,
      customer_phone text NOT NULL,
      status text NOT NULL,
      created_at timestamptz NOT NULL,
      data jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_phone_created_at_idx ON orders (customer_phone, created_at DESC);
    CREATE INDEX IF NOT EXISTS orders_status_created_at_idx ON orders (status, created_at DESC);
    CREATE TABLE IF NOT EXISTS analytics_days (
      date date PRIMARY KEY,
      views integer NOT NULL CHECK (views >= 0),
      visitors jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id text PRIMARY KEY,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS admin_sessions_expires_at_idx ON admin_sessions (expires_at);
    CREATE TABLE IF NOT EXISTS rate_limits (
      key text PRIMARY KEY,
      count integer NOT NULL CHECK (count > 0),
      reset_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rate_limits_reset_at_idx ON rate_limits (reset_at);
  `);

  await transaction(async (client) => {
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [746851204091]);
    } catch {
      // Advisory locks may not be supported in some connection poolers (e.g. PgBouncer)
    }
    const migration = await client.query(
      'SELECT 1 FROM app_migrations WHERE name = $1',
      ['legacy_json_import_v1']
    );
    const productCount = await client.query('SELECT count(*)::integer AS count FROM products');
    // Always populate a brand-new database with the bundled catalog. This is safe
    // for existing stores because it runs only when the products table is empty.
    const productSeed = Array.isArray(seed.products) && seed.products.length > 0
      ? seed.products
      : loadBundledProducts();
    if (productCount.rows[0].count === 0 && productSeed.length > 0) {
      await saveProductRows(client, productSeed);
    }
    if (migration.rowCount === 0) {
      await client.query('INSERT INTO app_migrations (name) VALUES ($1)', ['legacy_json_import_v1']);
    }

    if (migration.rowCount === 0) {
      const orderCount = await client.query('SELECT count(*)::integer AS count FROM orders');
      if (orderCount.rows[0].count === 0 && Array.isArray(seed.orders) && seed.orders.length > 0) {
        for (const order of seed.orders) await saveOrderRow(client, order);
      }

      const analyticsCount = await client.query('SELECT count(*)::integer AS count FROM analytics_days');
      if (analyticsCount.rows[0].count === 0 && seed.analytics && Array.isArray(seed.analytics.days) && seed.analytics.days.length > 0) {
        await seedAnalyticsRows(client, seed.analytics.days);
      }
    }
  });

  return loadState();
}

async function loadState() {
  const [productRows, orderRows, analyticsRows] = await Promise.all([
    pool.query('SELECT data FROM products ORDER BY position, id'),
    pool.query('SELECT data FROM orders ORDER BY created_at, reference'),
    pool.query('SELECT date, views, visitors FROM analytics_days ORDER BY date')
  ]);
  return {
    products: productRows.rows.map((row) => row.data),
    orders: orderRows.rows.map((row) => row.data),
    analytics: {
      days: analyticsRows.rows.map((row) => ({
        date: row.date.toISOString ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
        views: row.views,
        visitors: row.visitors
      }))
    }
  };
}

async function saveAdminSession(id, expiresAt) {
  await pool.query(
    `INSERT INTO admin_sessions (id, expires_at) VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
    [id, new Date(expiresAt)]
  );
}

async function getAdminSession(id) {
  const result = await pool.query(
    'SELECT expires_at FROM admin_sessions WHERE id = $1 AND expires_at > now()',
    [id]
  );
  return result.rowCount ? { expiresAt: result.rows[0].expires_at.getTime() } : null;
}

async function deleteAdminSession(id) {
  await pool.query('DELETE FROM admin_sessions WHERE id = $1', [id]);
}

async function incrementRateLimit(key, windowMs) {
  const result = await pool.query(
    `INSERT INTO rate_limits (key, count, reset_at)
     VALUES ($1, 1, now() + ($2 * interval '1 millisecond'))
     ON CONFLICT (key) DO UPDATE
       SET count = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.count + 1 END,
           reset_at = CASE WHEN rate_limits.reset_at <= now()
             THEN now() + ($2 * interval '1 millisecond')
             ELSE rate_limits.reset_at
           END
     RETURNING count, reset_at`,
    [key, windowMs]
  );
  return { count: result.rows[0].count, resetAt: result.rows[0].reset_at.getTime() };
}

async function clearRateLimit(key) {
  await pool.query('DELETE FROM rate_limits WHERE key = $1', [key]);
}

async function pruneAuthState() {
  await pool.query('DELETE FROM admin_sessions WHERE expires_at <= now()');
  await pool.query('DELETE FROM rate_limits WHERE reset_at <= now()');
}

async function saveOrder(order, expectedUpdatedAt) {
  await transaction(async (client) => {
    if (expectedUpdatedAt === undefined) {
      const result = await client.query(
        `INSERT INTO orders (reference, customer_phone, status, created_at, data)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (reference) DO NOTHING
         RETURNING reference`,
        [order.ref, order.customer.phone, order.status, order.createdAt, order]
      );
      if (result.rowCount === 0) {
        throw Object.assign(new Error('The order reference already exists.'), { status: 409 });
      }
      return;
    }

    const result = await client.query(
      `UPDATE orders
       SET customer_phone = $2, status = $3, created_at = $4, data = $5
       WHERE reference = $1
         AND COALESCE(data->>'updatedAt', data->>'createdAt') = $6
       RETURNING reference`,
      [order.ref, order.customer.phone, order.status, order.createdAt, order, expectedUpdatedAt]
    );
    if (result.rowCount === 0) {
      throw Object.assign(new Error('The order changed during this request.'), { status: 409 });
    }
  });
}

async function updateProducts(update) {
  if (typeof update !== 'function') throw new TypeError('Product updates must be a function.');
  return transaction(async (client) => {
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [PRODUCT_WRITE_LOCK]);
    } catch {
      // Advisory locks may not be supported in some connection poolers
    }
    const result = await client.query('SELECT data FROM products ORDER BY position, id');
    const currentProducts = result.rows.map((row) => row.data);
    const nextProducts = await update(currentProducts);
    if (!Array.isArray(nextProducts)) throw new TypeError('Product updates must return a product list.');
    if (nextProducts !== currentProducts) {
      await client.query('DELETE FROM products');
      await saveProductRows(client, nextProducts);
    }
    return nextProducts;
  });
}

async function updateAnalytics(update) {
  if (typeof update !== 'function') throw new TypeError('Analytics updates must be a function.');
  return transaction(async (client) => {
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ANALYTICS_WRITE_LOCK]);
    } catch {
      // Advisory locks may not be supported in some connection poolers
    }
    const currentDays = await loadAnalyticsRows(client);
    const nextDays = await update(currentDays);
    if (!Array.isArray(nextDays)) throw new TypeError('Analytics updates must return an analytics list.');
    const retainedDates = nextDays.map((day) => day.date);
    if (retainedDates.length) {
      await client.query('DELETE FROM analytics_days WHERE NOT (date = ANY($1::date[]))', [retainedDates]);
    } else {
      await client.query('DELETE FROM analytics_days');
    }
    await writeAnalyticsRows(client, nextDays);
    return nextDays;
  });
}

async function healthCheck() {
  if (!pool) return;
  await pool.query('SELECT 1');
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  initialize,
  loadState,
  saveAdminSession,
  getAdminSession,
  deleteAdminSession,
  incrementRateLimit,
  clearRateLimit,
  pruneAuthState,
  saveOrder,
  updateProducts,
  updateAnalytics,
  healthCheck,
  close
};
