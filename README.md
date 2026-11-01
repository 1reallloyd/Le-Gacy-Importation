# Le-Gacy's Importation – online store

Responsive storefront (browse → cart → checkout → Paystack payment → order tracking) with a small Node server. PostgreSQL is optional for local development and required in production.

## Run locally with PostgreSQL
1. Install PostgreSQL for Windows and start the PostgreSQL service. In pgAdmin, create a database named `legacys`.
2. Copy `.env.example` to `.env` if you have not already created it. Set `DATABASE_URL` to your local database, replacing the username and password with your PostgreSQL credentials. URL-encode special characters in the password:
   ```
   DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/legacys
   ```
3. Set `ADMIN_EMAIL` and a private `ADMIN_PASSWORD` (20+ characters). Add your Paystack **test** keys when you are ready to test checkout. Do not commit or share `.env`.
4. Install dependencies and start the server:
```
npm install
npm start
```
Open http://localhost:3000. On its first successful connection, local development creates the PostgreSQL tables and imports the current products, orders, and analytics JSON data once. In production, the database starts empty unless `IMPORT_LEGACY_DATA=1` is set for its first startup. After initialization, PostgreSQL is authoritative for products and orders; use the dashboard to manage products. `data/store.json` remains the source for store contact details and categories. Uploaded images are stored under `public/uploads/` by default; `UPLOADS_DIR` can point them at a persistent disk.

If `DATABASE_URL` is blank in local development, the existing JSON-file storage remains available. Production startup requires `DATABASE_URL` so orders are not accidentally written to ephemeral local files. When PostgreSQL is configured, API requests refresh product, order, and analytics data from the database, and admin sessions and rate limits are stored there.

## Moving local data to production
Use a hosted PostgreSQL database for production; a database on your computer is not accessible to a deployed site. To move your already-tested local database, back it up before deploying:
```
pg_dump --format=custom --no-owner --no-acl --file=legacys-backup.dump --dbname="$env:DATABASE_URL"
```
Restore that dump into a **new, empty** hosted database before starting the application against it:
```
pg_restore --no-owner --no-acl --dbname="YOUR_HOSTED_DATABASE_URL" legacys-backup.dump
```
Set the hosted `DATABASE_URL` and production Paystack live keys as deployment secrets, enable HTTPS, and start with `NODE_ENV=production`. Never put production credentials in source control. Keep the dump private and delete it securely when no longer needed. Production uploads also need persistent storage (a persistent disk or object-storage service); PostgreSQL stores product/order data, not image files.

## Vercel deployment
This repository includes a Vercel Node function adapter. It keeps `npm start` available for local development and routes storefront pages, dashboard requests, API calls, and `/healthz` through the same server handler. Vercel deployments use PostgreSQL for product/order/analytics data, sessions, and rate limits; admin image uploads are stored as public Vercel Blob objects. Product mutations and analytics updates are serialized in PostgreSQL transactions across function instances. Order updates use optimistic concurrency checks and reject stale writes instead of silently replacing a newer update.

### Production setup
1. Import the GitHub repository into Vercel. Ensure the Vercel **Production Branch** points at the reviewed commit/branch; do not assume importing the repository selects `vercel-preview`. Deploying from an outdated `main` branch would omit the Vercel adapter and recent changes.
2. Create a **new, dedicated production Neon database** and Vercel Blob store. Keep them separate from any Preview resources. In Vercel's **Production** environment variables, set `DATABASE_URL` to Neon's pooled connection URL, `ADMIN_EMAIL`, a private `ADMIN_PASSWORD` of 20–256 characters, and `TRUST_PROXY=1`. Add the production Blob store so `BLOB_READ_WRITE_TOKEN` is provided to Production.
3. Add matching Paystack **live** keys only in Vercel's private **Production** environment variables: `PAYSTACK_PUBLIC_KEY=pk_live_...` and `PAYSTACK_SECRET_KEY=sk_live_...`. Do not set `PAYSTACK_TEST_MODE` in Production. Never put key values in Git, Preview settings, or chat. Vercel sets `NODE_ENV` for deployment; production startup rejects missing, mismatched, or test payment keys.
4. Leave `IMPORT_LEGACY_DATA` unset so the new production database starts empty. Do not use the Render staging database as the production database. After deploying, check `/healthz`, sign into `/dashboard`, add a product, upload an image, and verify the site and database remain healthy after a redeploy. Before announcing the store, complete Paystack live account activation, check delivery/contact details, and make a controlled payment test.
5. Configure Neon backups and perform a restore test. Review Vercel, Neon, and Blob plan limits and billing. The existing Render staging database is separate and is not used by Vercel.

### Preview and payment testing
Use Vercel **Preview** deployments for testing before directing customers to Production. Give Preview its own Neon database and Blob store, set matching Paystack **test** keys and `PAYSTACK_TEST_MODE=1` only in the Preview environment, and leave `IMPORT_LEGACY_DATA` unset. Never copy production keys into Preview or use live payments for testing. Vercel Preview can be restricted with deployment protection while it is being tested.

## Admin account storage
This store currently supports one administrator. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` as private environment secrets; admin credentials are intentionally not stored in PostgreSQL. The server verifies the configured password with scrypt. Admin session cookies are HTTP-only and same-site; session IDs and rate limits are stored in PostgreSQL when configured and otherwise remain local to the development process. Do not add `ADMIN_PASSWORD` to a database dump or commit it to Git.

## Deploying on Render
1. Push the reviewed project to a private GitHub repository and create a Render **Web Service** from it. Use the same region for the service and a Render PostgreSQL database. Set the build command to `npm ci`, the start command to `npm start`, and the health-check path to `/healthz`.
2. In Render, set the web service environment variables: `NODE_ENV=production`, `TRUST_PROXY=1`, `UPLOADS_DIR=/var/data/uploads`, `DATABASE_URL` to the database's **internal** connection URL, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `PAYSTACK_PUBLIC_KEY`, and `PAYSTACK_SECRET_KEY`. Keep secrets in Render's environment settings—never in Git. The live public and secret keys must belong to the same Paystack account. Production startup refuses test or mismatched keys by default.
3. Add a persistent disk to the web service mounted at `/var/data` (Render persistent disks require a paid service plan). The app copies any packaged `public/uploads/` images onto this disk at startup and stores future admin uploads there. With PostgreSQL configured, product mutations and analytics updates are serialized across instances, order updates reject stale writes, and sessions and rate limits survive service restarts. A local JSON-file deployment still requires a single instance.
4. Review `data/products.json`, `data/store.json`, and packaged uploaded images before the first deploy. A new production or staging database starts with an empty product catalog and no local JSON orders or analytics by default, so the administrator can add products from the dashboard. To import the local products and curated history instead, clean the JSON files of test records and set `IMPORT_LEGACY_DATA=1` for the first startup of the empty database, then remove that setting. Alternatively, back up and restore a verified local database into a new, empty Render database before the first deploy. The one-time import marker prevents automatic re-import on later restarts.
5. Before enabling customers, deploy to a separate staging service/database using Paystack test keys and set `PAYSTACK_TEST_MODE=1` (this keeps production HTTPS cookies enabled while explicitly permitting test keys). Verify browsing, checkout success/failure, order tracking, admin edits/uploads, and restart behavior. Do not copy test orders into production. For production, remove `PAYSTACK_TEST_MODE`, use the matching Paystack live keys in Render secrets, complete Paystack's live account setup, and test a small real transaction if appropriate.
6. Configure database backups in Render and perform a restore test before launch. Check Render deploy/runtime logs, verify `/healthz` reports healthy, confirm an admin login and order appear correctly, and ensure the production domain serves HTTPS. Production images are on the persistent disk; include those files in your backup/migration process.

## Before going live
1. **Configure Paystack keys** from your Paystack dashboard. Open the local `.env` file in the project folder and paste the matching test keys after `PAYSTACK_PUBLIC_KEY=` (`pk_test_...`) and `PAYSTACK_SECRET_KEY=` (`sk_test_...`). Save the file, then restart the server with `npm start`. The `.env` file is ignored by Git; do not share or commit it. Use live keys only over HTTPS.
2. **Configure the administrator login** in `.env`: set `ADMIN_EMAIL` to the administrator's unique sign-in email and `ADMIN_PASSWORD` to a private password of at least 20 characters. Open `/dashboard` and sign in; there is no public sign-up. Passwords are checked using scrypt, failed sign-ins are rate-limited, and dashboard access uses short-lived HTTP-only, same-site session cookies. Change the password in `.env` and restart the server to rotate it and invalidate existing sessions. The dashboard manages products and uploaded images, orders and fulfillment, inventory, customer summaries, sales reports, and store performance analytics. When PostgreSQL is configured, product edits are saved in the database; without it, they are saved in `data/products.json`. Uploaded images are saved under `public/uploads/`.
3. **Serve over HTTPS** and start with `NODE_ENV=production` (adds HSTS and requires matching Paystack live keys). If you sit behind a proxy/host that forwards the client IP, also set `TRUST_PROXY=1` so origin checks and rate limits use the original request protocol/IP.
4. **Replace the sample products** in `data/products.json` before the first database start, or manage them from the dashboard after import. Add optional `"sizes": ["37", "38", "39"]` and `"colors": ["Black", "White"]` arrays to products with size or color choices; customers select configured options on the product details page and those selections are included in orders. Each variant uses the product's listed price. Set `"preOrder": true` for products customers may purchase in advance; leave `inStock` false for these items. Pre-order products can be ordered and are identified in the cart and order records. For photos put files in `public/images/` and set `"image": "/images/name.jpg"`, or use a `res.cloudinary.com` link. The home-page collection carousel uses illustrative photos hosted by Unsplash; update their URLs in `public/app.js` when adding your own collection photography.
5. Contact details and categories live in `data/store.json`.

## Store performance and alerts
The dashboard’s **Store performance** section shows estimated unique browsers, page views, paid orders, sales, and the products most often purchased over the last 7, 30, or 90 days. Visitor tracking starts when this feature is deployed; it uses a random first-party browser ID and stores only its SHA-256 hash in daily aggregates, retained for up to 90 days. It does not collect visitor names or use IP addresses to identify visitors. A person using multiple browsers or devices may be counted more than once. Product rankings include confirmed and fulfilled orders only.

## Order tracking
Admins update order fulfillment from the dashboard’s **Orders** section. Customers see the order timeline, including **Processing your order**, **On the way**, and **Delivered**, with the latest update time. An open tracking page checks for admin status changes once a minute; customers can also revisit Track order at any time.

The dashboard can play a short sound for a newly received order while an administrator is signed in and the dashboard is visible. Sound is limited to new orders (not every notification), can be switched off with the **Order sound** control, and may need to be enabled by clicking that control if the browser blocks audio playback.

## Batch product import
In the admin dashboard’s **Products** section, choose **Batch upload** to validate and preview a `.xlsx` or `.csv` spreadsheet before importing. The downloadable CSV template uses these headers: `id`, `name`, `category`, `price`, `inStock`, `preOrder`, `qty`, `description`, `sizes`, `colors`, and `image`. Only `name`, `category`, and `price` are required. `qty` is the optional whole-number inventory quantity (the older `stock` header remains accepted as an alias; use only one). Category accepts a store category name or ID; `inStock` and `preOrder` accept `true`/`false`, `yes`/`no`, or `1`/`0`; separate sizes and colors with commas. A supplied ID updates a matching product or is used for a new one; blank IDs are generated, and repeated IDs in the file are rejected. Blank optional cells preserve existing values. `image` accepts a publicly accessible, direct HTTPS image URL from any host or a local `/uploads/` or `/images/` path. The image host must allow the storefront to load the image (hotlinking). An image can also be added later by editing the product. Files are limited to 5 MB and 500 products. Validation is all-or-nothing, and the dashboard refreshes its product-notification baseline after import to avoid generating notifications for imported rows.

## How payment works
Customer enters delivery details and an email → Paystack opens its secure checkout popup for card or Mobile Money payment → the server verifies the Paystack transaction reference, exact amount, currency and customer email before confirming the order. The secret key is used only by the server. Legacy/manual Mobile Money submissions remain available for previously placed orders and can be reviewed in the dashboard.

## Security measures built in
- Prices, totals and stock are computed only on the server; anything the browser sends about price is ignored. Paystack payments are only confirmed after a server-to-server verification of transaction status, amount, GHS currency and customer email.
- All input validated, trimmed and length-limited; Ghana phone numbers normalised; unknown items, bad quantities and oversized/non-JSON bodies rejected.
- All page content is built with safe DOM text (no `innerHTML` with user data) and a strict Content-Security-Policy blocks inline scripts.
- Security headers: CSP allows only the Paystack checkout script, API and payment frames needed for payments (images are otherwise limited to the store, Cloudinary and Unsplash), plus X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP and HSTS in production. No CORS (same-origin only).
- Rate limiting on every route, with tighter limits on orders, tracking, payment verification and admin sign-in attempts.
- Orders can only be viewed with order number **and** phone number; failures return one generic message.
- Admin sign-in uses an environment-configured email and password; passwords are verified with scrypt and constant-time comparisons. Four incorrect sign-in attempts from an IP trigger a 15-minute lockout; successful sign-in clears the failed-attempt count.
- Admin API requires an eight-hour HTTP-only, `SameSite=Strict` session cookie, same-origin checks on every state-changing request, and `Secure` cookies in production. Dashboard is `noindex`, responses are not cached, and there is no public sign-up.
- Product edits and image uploads require an authenticated admin session; uploaded images are size-limited, type-checked, and stored with generated filenames.
- Honeypot field against bots, duplicate-transaction-ID check, cap on unpaid orders per phone.
- Files are served only from `public/`; path traversal is blocked. PostgreSQL writes use transactions; the local JSON fallback writes atomically with restrictive file permissions.

## Not included yet
- Delivery fees: not guessed; the page says they are confirmed on WhatsApp.
