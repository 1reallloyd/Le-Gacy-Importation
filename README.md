# Le-Gacy's Importation – online store

Responsive storefront (browse → cart → checkout → Paystack payment → order tracking) with a small, dependency-free Node server.

## Run it
Before the first start, add `ADMIN_EMAIL` and a private `ADMIN_PASSWORD` (20+ characters) to `.env`. The starter names are in `.env.example`; do not commit `.env`.
```
node server.js            # needs Node 18+, nothing to npm install
```
Open http://localhost:3000. Orders are saved in `data/orders.json` (created automatically).

## Before going live
1. **Configure Paystack keys** from your Paystack dashboard. Open the local `.env` file in the project folder and paste the matching test keys after `PAYSTACK_PUBLIC_KEY=` (`pk_test_...`) and `PAYSTACK_SECRET_KEY=` (`sk_test_...`). Save the file, then restart the server with `npm start`. The `.env` file is ignored by Git; do not share or commit it. Use live keys only over HTTPS.
2. **Configure the administrator login** in `.env`: set `ADMIN_EMAIL` to the administrator's unique sign-in email and `ADMIN_PASSWORD` to a private password of at least 20 characters. Open `/dashboard` and sign in; there is no public sign-up. Passwords are checked using scrypt, failed sign-ins are rate-limited, and dashboard access uses short-lived HTTP-only, same-site session cookies. Change the password in `.env` and restart the server to rotate it and invalidate existing sessions. The dashboard manages products and uploaded images, orders and fulfillment, inventory, customer summaries, and sales reports. Product edits are saved in `data/products.json`; uploaded images are saved under `public/uploads/`.
3. **Serve over HTTPS** and start with `NODE_ENV=production` (adds HSTS). If you sit behind a proxy/host that forwards the client IP, also set `TRUST_PROXY=1` so rate limits work per customer.
4. **Replace the sample products** in `data/products.json` (name, price, description, `inStock`). Add optional `"sizes": ["37", "38", "39"]` and `"colors": ["Black", "White"]` arrays to products with size or color choices; customers select configured options on the product details page and those selections are included in orders. Each variant uses the product's listed price. Set `"preOrder": true` for products customers may purchase in advance; leave `inStock` false for these items. Pre-order products can be ordered and are identified in the cart and order records. For photos put files in `public/images/` and set `"image": "/images/name.jpg"`, or use a `res.cloudinary.com` link. The home-page collection carousel uses illustrative photos hosted by Unsplash; update their URLs in `public/app.js` when adding your own collection photography.
5. Contact details and categories live in `data/store.json`.

## How payment works
Customer enters delivery details and an email → Paystack opens its secure checkout popup for card or Mobile Money payment → the server verifies the Paystack transaction reference, exact amount, currency and customer email before confirming the order. The secret key is used only by the server. Legacy/manual Mobile Money submissions remain available for previously placed orders and can be reviewed in the dashboard.

## Security measures built in
- Prices, totals and stock are computed only on the server; anything the browser sends about price is ignored. Paystack payments are only confirmed after a server-to-server verification of transaction status, amount, GHS currency and customer email.
- All input validated, trimmed and length-limited; Ghana phone numbers normalised; unknown items, bad quantities and oversized/non-JSON bodies rejected.
- All page content is built with safe DOM text (no `innerHTML` with user data) and a strict Content-Security-Policy blocks inline scripts.
- Security headers: CSP allows only the Paystack checkout script, API and payment frames needed for payments (images are otherwise limited to the store, Cloudinary and Unsplash), plus X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP and HSTS in production. No CORS (same-origin only).
- Rate limiting on every route, with tighter limits on orders, tracking, payment verification and admin sign-in attempts.
- Orders can only be viewed with order number **and** phone number; failures return one generic message.
- Admin sign-in uses an environment-configured email and password; passwords are verified with scrypt and constant-time comparisons. Sign-in attempts are rate-limited by IP and email.
- Admin API requires an eight-hour HTTP-only, `SameSite=Strict` session cookie, same-origin checks on every state-changing request, and `Secure` cookies in production. Dashboard is `noindex`, responses are not cached, and there is no public sign-up.
- Product edits and image uploads require an authenticated admin session; uploaded images are size-limited, type-checked, and stored with generated filenames.
- Honeypot field against bots, duplicate-transaction-ID check, cap on unpaid orders per phone.
- Files are served only from `public/`; path traversal is blocked; order data is written atomically with owner-only permissions.

## Not included yet
- Delivery fees: not guessed; the page says they are confirmed on WhatsApp.
