# Mysure E-Commerce Website (Node.js + Express + Supabase Postgres)

A full store: storefront, cart, checkout, reviews, wishlist, and a single-admin panel with product photo upload.

## Setup
1. Install Node.js 18+.
2. Supabase: create a project. Open **SQL Editor**, paste all of `schema.sql`, click Run (creates the tables, locks them with Row Level Security, adds sample products).
3. Supabase > **Project Settings > Database > Connection string > URI** (Transaction pooler). Copy it into `.env` as `DATABASE_URL` with your database password.
4. Copy `.env.example` to `.env` and fill in `DATABASE_URL`, a long random `JWT_SECRET`, and your admin email and password.
5. Optional, product photos in Supabase: Storage > New bucket named `products`, set **Public**. Then put Project URL and `service_role` key in `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`). Never put that key in the website files.
6. `npm install`
7. `npm run seed-admin`   (creates the one admin account, run once)
8. `npm start`
9. Open http://localhost:3000

The server talks to Supabase directly. Do not use the Supabase anon key in the browser; the tables are locked so it cannot read anything.

## Using it
- Customers: register, browse, add to cart, check out with Cash on Delivery or online payment (Razorpay: UPI, cards, netbanking), review products.
- Admin: log in with the email and password from `.env`, then open Admin.
  - Products tab: Add product, choose a category, and upload a photo (JPG, PNG or WebP, up to 3 MB).
  - Orders tab: change status (Pending, Shipped, Delivered, Cancelled, Refunded).
  - Customers and Dashboard tabs for the rest.
- Coupon `MYSURE10` gives 10% off. Delivery is Rs 49 under Rs 999, free above. These are calculated on the server.

## Where things live
- `server.js`      API (auth, products, orders, reviews, admin, photo upload)
- `schema.sql`     database tables and sample products
- `public/`        the website (index.html) and `public/uploads/` for product photos

## Security built in
bcrypt password hashing, JWT login, admin role checked on every admin route, no public admin signup,
login rate limiting, parameterised SQL, helmet headers, server-side prices, stock locking inside a transaction,
photo uploads limited to admin, image types and 3 MB.

## Before going live
Use HTTPS (put it behind Nginx or a host that provides it), keep `.env` private, use Supabase backups (or a daily dump), and keep photos in Supabase Storage so they survive redeploys.

## Online payment (Razorpay)
1. Create a Razorpay account, complete KYC, and copy the Key ID and Key Secret (use Test mode first).
2. Put them in `.env` as `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. If left blank, only Cash on Delivery is offered.
3. Razorpay dashboard > Webhooks: add `https://yourdomain.com/api/razorpay/webhook`, event `payment.captured`, and put the secret you choose in `RAZORPAY_WEBHOOK_SECRET`. This marks orders paid even if a customer closes the tab after paying.
- Payments are verified on the server with Razorpay's signature; the browser is never trusted.
- Unpaid online orders hold stock for 30 minutes, then are cancelled and restocked. Customers can pay again from My orders.
- Customers cannot cancel a paid online order. Admin cancels it, refunds in the Razorpay dashboard, then sets the status to Refunded.
