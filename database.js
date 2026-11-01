'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error.message);
});

async function transaction(callback) {
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
    await client.query(
      `INSERT INTO products (id, position, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, data = EXCLUDED.data`,
      [product.id, position, product]
    );
  }
}

async function saveOrderRow(client, order) {
  await client.query(
    `INSERT INTO orders (reference, customer_phone, status, created_at, data)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (reference) DO UPDATE
       SET customer_phone = EXCLUDED.customer_phone,
           status = EXCLUDED.status,
           created_at = EXCLUDED.created_at,
           data = EXCLUDED.data`,
    [order.ref, order.customer.phone, order.status, order.createdAt, order]
  );
}

async function saveAnalyticsRows(client, days) {
  await client.query('DELETE FROM analytics_days');
  for (const day of days) {
    await client.query(
      `INSERT INTO analytics_days (date, views, visitors)
       VALUES ($1, $2, $3)
       ON CONFLICT (date) DO UPDATE SET views = EXCLUDED.views, visitors = EXCLUDED.visitors`,
      [day.date, day.views, JSON.stringify(day.visitors)]
    );
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
  `);

  await transaction(async (client) => {
    const migration = await client.query(
      'SELECT 1 FROM app_migrations WHERE name = $1',
      ['legacy_json_import_v1']
    );
    if (migration.rowCount === 0) {
      const productCount = await client.query('SELECT count(*)::integer AS count FROM products');
      if (productCount.rows[0].count === 0) await saveProductRows(client, seed.products);

      const orderCount = await client.query('SELECT count(*)::integer AS count FROM orders');
      if (orderCount.rows[0].count === 0) {
        for (const order of seed.orders) await saveOrderRow(client, order);
      }

      const analyticsCount = await client.query('SELECT count(*)::integer AS count FROM analytics_days');
      if (analyticsCount.rows[0].count === 0) await saveAnalyticsRows(client, seed.analytics.days);

      await client.query('INSERT INTO app_migrations (name) VALUES ($1)', ['legacy_json_import_v1']);
    }
  });

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

async function saveOrder(order) {
  await saveOrderRow(pool, order);
}

async function saveProducts(products) {
  await transaction(async (client) => {
    if (products.length) {
      await client.query('DELETE FROM products WHERE NOT (id = ANY($1::text[]))', [products.map((product) => product.id)]);
    } else {
      await client.query('DELETE FROM products');
    }
    await saveProductRows(client, products);
  });
}

async function saveAnalytics(days) {
  await transaction((client) => saveAnalyticsRows(client, days));
}

async function healthCheck() {
  await pool.query('SELECT 1');
}

async function close() {
  await pool.end();
}

module.exports = { initialize, saveOrder, saveProducts, saveAnalytics, healthCheck, close };
