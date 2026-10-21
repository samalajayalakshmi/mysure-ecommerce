require('dotenv').config();
const express = require('express'), helmet = require('helmet'), cors = require('cors');
const rateLimit = require('express-rate-limit'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const multer = require('multer'), fs = require('fs'), crypto = require('crypto');
fs.mkdirSync('public/uploads', { recursive: true });

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET missing in .env');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing in .env (Supabase connection string)');
// Supabase Postgres. SSL is required by Supabase.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'off' ? false : { rejectUnauthorized: false }, max: 10 });
const rows = async (sql, args = [], db = pool) => (await db.query(sql, args)).rows;
const one = async (sql, args = [], db = pool) => (await rows(sql, args, db))[0];

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), SB_KEY = process.env.SUPABASE_SERVICE_KEY, SB_BUCKET = process.env.SUPABASE_BUCKET || 'products';
const SB_ON = !!(SB_URL && SB_KEY);
const IMG_RE = SB_ON ? new RegExp('^(/uploads/|' + (SB_URL + '/storage/v1/object/public/' + SB_BUCKET + '/').replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + ')[a-f0-9]+\\.(jpg|png|webp)$') : /^\/uploads\/[a-f0-9]+\.(jpg|png|webp)$/;

const app = express();
// index.html uses an inline <script> and onclick= handlers; helmet's default CSP would block all of them and the page would be dead.
const csp = { ...helmet.contentSecurityPolicy.getDefaultDirectives(),
  'script-src': ["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com'], 'script-src-attr': ["'unsafe-inline'"],
  'frame-src': ['https://api.razorpay.com', 'https://checkout.razorpay.com'], 'connect-src': ["'self'", 'https://lumberjack.razorpay.com'],
  'img-src': ["'self'", 'data:', 'https://*.supabase.co'] };
app.use(helmet({ contentSecurityPolicy: { directives: csp } }), cors(),
  (req, res, next) => req.path === '/api/razorpay/webhook' ? next() : express.json({ limit: '100kb' })(req, res, next));
app.use(express.static('public')); // put your frontend files in /public

// ---------- helpers ----------
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const sign = u => jwt.sign({ id: u.id, role: u.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
const auth = (req, res, next) => {
  try { req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Login required' }); }
};
// Every admin route re-checks role from the token: customers get 403.
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
const admin = [auth, adminOnly];
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts. Try later.' } });
const ok = (v, min = 1, max = 500) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const withItems = async list => { for (const o of list) o.items = await rows('SELECT product_name,price,quantity FROM order_items WHERE order_id=$1', [o.id]); return list; };

// ---------- auth ----------
app.post('/api/auth/register', loginLimiter, wrap(async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!ok(name, 1, 100) || !ok(email, 5, 150) || !email.includes('@') || !ok(password, 6, 72)) return res.status(400).json({ error: 'Invalid details' });
  if (await one('SELECT id FROM users WHERE email=$1', [email.toLowerCase()])) return res.status(409).json({ error: 'Email already registered' });
  // role is ALWAYS customer here; nobody can register as admin
  const r = await one("INSERT INTO users (name,email,phone,password_hash,role) VALUES ($1,$2,$3,$4,'customer') RETURNING id",
    [name.trim(), email.toLowerCase(), phone || null, await bcrypt.hash(password, 12)]);
  res.status(201).json({ token: sign({ id: r.id, role: 'customer' }), name });
}));

app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const { email, password } = req.body;
  const u = await one('SELECT * FROM users WHERE email=$1', [String(email || '').toLowerCase()]);
  if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash))) return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: sign(u), name: u.name, role: u.role });
}));

// ---------- public catalogue ----------
app.get('/api/categories', wrap(async (_, res) => res.json(await rows('SELECT * FROM categories ORDER BY name'))));

app.get('/api/products', wrap(async (req, res) => {
  const { q = '', category } = req.query, args = [`%${String(q).replace(/[\\%_]/g, '\\$&')}%`];
  let sql = 'SELECT p.*, c.name category, (SELECT ROUND(AVG(r.rating),1) FROM reviews r WHERE r.product_id=p.id) rating, (SELECT COUNT(*)::int FROM reviews r WHERE r.product_id=p.id) rc FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.active AND p.name ILIKE $1';
  if (category) { args.push(+category || 0); sql += ' AND p.category_id=$2'; }
  res.json(await rows(sql + ' ORDER BY p.id DESC', args));
}));

app.get('/api/products/:id', wrap(async (req, res) => {
  const p = await one('SELECT * FROM products WHERE id=$1 AND active', [req.params.id]);
  p ? res.json(p) : res.status(404).json({ error: 'Not found' });
}));

// ---------- Razorpay (plain REST, no SDK) ----------
const RZP_ON = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const rzp = async (path, body) => {
  const r = await fetch('https://api.razorpay.com/v1' + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(process.env.RAZORPAY_KEY_ID + ':' + process.env.RAZORPAY_KEY_SECRET).toString('base64') }, body: JSON.stringify(body) });
  const d = await r.json(); if (!r.ok) throw new Error(d.error?.description || 'Razorpay error'); return d;
};
const markPaid = async (rpOrderId, paymentId) => (await pool.query("UPDATE orders SET payment_status='Paid', rp_payment_id=$1 WHERE rp_order_id=$2 AND payment_status='Unpaid' AND status='Pending'", [paymentId, rpOrderId])).rowCount;
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- customer orders ----------
app.get('/api/config', (_, res) => res.json({ online: RZP_ON, key: RZP_ON ? process.env.RAZORPAY_KEY_ID : null }));

// Cancel + restock atomically; the conditional UPDATE stops a double-click/race from restocking twice.
const cancelOrder = async (id, userId) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query("UPDATE orders SET status='Cancelled' WHERE id=$1 AND status='Pending'" + (userId ? " AND user_id=$2 AND NOT (payment_method='ONLINE' AND payment_status='Paid')" : ''), userId ? [id, userId] : [id]);
    if (!r.rowCount) { await c.query('ROLLBACK'); return false; }
    await c.query('UPDATE products p SET stock = p.stock + i.q FROM (SELECT product_id, SUM(quantity) q FROM order_items WHERE order_id=$1 AND product_id IS NOT NULL GROUP BY product_id) i WHERE p.id = i.product_id', [id]);
    await c.query('COMMIT'); return true;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
};

// Prices come from the DB, never from the browser. Stock is locked inside a transaction.
app.post('/api/orders', auth, wrap(async (req, res) => {
  const { items, name, phone, address, payment = 'COD' } = req.body;
  if (!Array.isArray(items) || !items.length || !ok(name) || !/^[0-9]{10}$/.test(phone || '') || !ok(address, 5, 500)) return res.status(400).json({ error: 'Invalid order details' });
  const c = await pool.connect();
  let orderId, total = 0, method;
  try {
    await c.query('BEGIN');
    const lines = [];
    for (const it of items) {
      const qty = parseInt(it.quantity, 10), pid = parseInt(it.product_id, 10);
      if (!(qty > 0) || !(pid > 0)) throw Object.assign(new Error('Bad quantity'), { code: 400 });
      const p = await one('SELECT * FROM products WHERE id=$1 AND active FOR UPDATE', [pid], c);
      if (!p || p.stock < qty) throw Object.assign(new Error(`Not enough stock: ${p ? p.name : 'item'}`), { code: 409 });
      await c.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [qty, p.id]);
      total += p.price * qty; lines.push([p.id, p.name, p.price, qty]);
    }
    const discount = String(req.body.coupon || '').toUpperCase() === 'MYSURE10' ? Math.round(total * 0.1) : 0, shipping = total - discount < 999 ? 49 : 0;
    total = total - discount + shipping;
    method = payment === 'ONLINE' ? 'ONLINE' : 'COD';
    if (method === 'ONLINE' && !RZP_ON) throw Object.assign(new Error('Online payment is not available right now'), { code: 400 });
    orderId = (await one('INSERT INTO orders (user_id,customer_name,phone,address,payment_method,total,discount,shipping) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [req.user.id, name.trim(), phone, address, method, total, discount, shipping], c)).id;
    for (const l of lines) await c.query('INSERT INTO order_items (order_id,product_id,product_name,price,quantity) VALUES ($1,$2,$3,$4,$5)', [orderId, ...l]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); return res.status(e.code === 400 || e.code === 409 ? e.code : 500).json({ error: e.code === 400 || e.code === 409 ? e.message : 'Order failed' }); }
  finally { c.release(); }
  if (method === 'ONLINE') {
    try {
      const rp = await rzp('/orders', { amount: Math.round(total * 100), currency: 'INR', receipt: 'order_' + orderId });
      await pool.query('UPDATE orders SET rp_order_id=$1 WHERE id=$2', [rp.id, orderId]);
      return res.status(201).json({ order_id: orderId, total, online: { key: process.env.RAZORPAY_KEY_ID, rp_order_id: rp.id, amount: rp.amount } });
    } catch (e) { console.error('Razorpay order failed', e.message); await cancelOrder(orderId); return res.status(502).json({ error: 'Could not start payment. Please try again or choose Cash on Delivery.' }); }
  }
  res.status(201).json({ order_id: orderId, total });
}));

app.get('/api/orders/mine', auth, wrap(async (req, res) => res.json(await withItems(await rows('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC', [req.user.id])))));

// Browser calls this after Razorpay checkout succeeds; the signature proves the payment is real.
app.post('/api/orders/:id/verify', auth, wrap(async (req, res) => {
  const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = req.body;
  const o = await one('SELECT rp_order_id FROM orders WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  if (!o || !o.rp_order_id || o.rp_order_id !== oid || typeof pid !== 'string' || typeof sig !== 'string') return res.status(400).json({ error: 'Invalid payment' });
  const good = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(oid + '|' + pid).digest('hex');
  if (!safeEq(good, sig)) return res.status(400).json({ error: 'Payment could not be verified' });
  await markPaid(oid, pid); res.json({ ok: true });
}));
// Backup in case the customer closes the tab after paying. Set the webhook in the Razorpay dashboard (event: payment.captured).
app.post('/api/razorpay/webhook', express.raw({ type: '*/*', limit: '100kb' }), wrap(async (req, res) => {
  const sig = String(req.headers['x-razorpay-signature'] || '');
  if (!process.env.RAZORPAY_WEBHOOK_SECRET || !safeEq(crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(req.body).digest('hex'), sig)) return res.status(400).end();
  const ev = JSON.parse(req.body.toString()), pay = ev.payload?.payment?.entity;
  if (ev.event === 'payment.captured' && pay) await markPaid(pay.order_id, pay.id);
  res.json({ ok: true });
}));

app.post('/api/orders/:id/cancel', auth, wrap(async (req, res) => {
  if (!(await cancelOrder(req.params.id, req.user.id))) return res.status(400).json({ error: 'Cannot cancel this order' });
  res.json({ ok: true });
}));

// ---------- ADMIN ONLY ----------
const pf = b => [b.name, b.description || '', +b.price, b.mrp ? +b.mrp : null, +b.stock, b.category_id || null, b.image_url || null, String(b.icon || '📦').slice(0, 8)];
const validP = b => ok(b.name, 1, 200) && +b.price > 0 && Number.isInteger(+b.stock) && +b.stock >= 0 && (!b.image_url || IMG_RE.test(b.image_url));

app.post('/api/admin/products', admin, wrap(async (req, res) => {
  if (!validP(req.body)) return res.status(400).json({ error: 'Invalid product' });
  const r = await one('INSERT INTO products (name,description,price,mrp,stock,category_id,image_url,icon) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', pf(req.body));
  res.status(201).json({ id: r.id });
}));
app.put('/api/admin/products/:id', admin, wrap(async (req, res) => {
  if (!validP(req.body)) return res.status(400).json({ error: 'Invalid product' });
  await pool.query('UPDATE products SET name=$1,description=$2,price=$3,mrp=$4,stock=$5,category_id=$6,image_url=$7,icon=$8 WHERE id=$9', [...pf(req.body), req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/admin/products/:id', admin, wrap(async (req, res) => {
  await pool.query('UPDATE products SET active=FALSE WHERE id=$1', [req.params.id]); // soft delete keeps order history intact
  res.json({ ok: true });
}));
app.post('/api/admin/categories', admin, wrap(async (req, res) => {
  if (!ok(req.body.name, 1, 100)) return res.status(400).json({ error: 'Invalid name' });
  const r = await one('INSERT INTO categories (name) VALUES ($1) RETURNING id', [req.body.name.trim()]);
  res.status(201).json({ id: r.id });
}));
app.get('/api/admin/orders', admin, wrap(async (_, res) => res.json(await withItems(await rows('SELECT * FROM orders ORDER BY id DESC')))));
app.put('/api/admin/orders/:id/status', admin, wrap(async (req, res) => {
  if (!['Pending', 'Shipped', 'Delivered', 'Cancelled', 'Refunded'].includes(req.body.status)) return res.status(400).json({ error: 'Bad status' });
  const o = await one('SELECT status FROM orders WHERE id=$1', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (req.body.status === 'Cancelled' && o.status === 'Pending') await cancelOrder(req.params.id); // restocks items
  else if (req.body.status === 'Cancelled' && o.status !== 'Cancelled') await pool.query("UPDATE orders SET status='Cancelled' WHERE id=$1", [req.params.id]);
  else if (o.status === 'Cancelled' && !['Cancelled', 'Refunded'].includes(req.body.status)) return res.status(400).json({ error: 'Cancelled orders cannot be reopened (stock was already returned)' });
  else await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
  res.json({ ok: true });
}));
app.get('/api/admin/customers', admin, wrap(async (_, res) =>
  res.json(await rows("SELECT id,name,email,phone,created_at FROM users WHERE role='customer' ORDER BY id DESC"))));
app.get('/api/admin/stats', admin, wrap(async (_, res) => {
  const s = await one("SELECT COUNT(*)::int orders, COALESCE(SUM(CASE WHEN status NOT IN ('Cancelled','Refunded') THEN total END),0) revenue FROM orders");
  res.json({ ...s, low_stock: await rows('SELECT id,name,stock FROM products WHERE active AND stock<5') });
}));

// ---------- product photo upload (ADMIN ONLY) ----------
// Photos go to Supabase Storage when SUPABASE_URL + SUPABASE_SERVICE_KEY are set (survives redeploys); otherwise to public/uploads.
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, !!EXT[f.mimetype])
});
app.post('/api/admin/upload', admin, upload.single('image'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a JPG, PNG or WebP image under 3 MB' });
  const name = crypto.randomBytes(12).toString('hex') + EXT[req.file.mimetype];
  if (!SB_ON) { fs.writeFileSync('public/uploads/' + name, req.file.buffer); return res.json({ url: '/uploads/' + name }); }
  const r = await fetch(`${SB_URL}/storage/v1/object/${SB_BUCKET}/${name}`, { method: 'POST', headers: { Authorization: 'Bearer ' + SB_KEY, apikey: SB_KEY, 'Content-Type': req.file.mimetype }, body: req.file.buffer });
  if (!r.ok) { console.error('Storage upload failed', r.status, await r.text()); return res.status(502).json({ error: 'Photo upload failed' }); }
  res.json({ url: `${SB_URL}/storage/v1/object/public/${SB_BUCKET}/${name}` });
}));

// ---------- reviews ----------
app.get('/api/products/:id/reviews', wrap(async (req, res) => res.json(await rows(
  'SELECT r.rating, r.comment, r.created_at, u.name FROM reviews r JOIN users u ON u.id=r.user_id WHERE r.product_id=$1 ORDER BY r.id DESC', [req.params.id]))));
app.post('/api/products/:id/reviews', auth, wrap(async (req, res) => {
  const rating = parseInt(req.body.rating, 10);
  if (req.user.role !== 'customer' || !(rating >= 1 && rating <= 5) || !ok(req.body.comment, 1, 300)) return res.status(400).json({ error: 'Invalid review' });
  await pool.query('INSERT INTO reviews (product_id,user_id,rating,comment) VALUES ($1,$2,$3,$4) ON CONFLICT (product_id,user_id) DO UPDATE SET rating=EXCLUDED.rating, comment=EXCLUDED.comment',
    [req.params.id, req.user.id, rating, req.body.comment.trim()]);
  res.status(201).json({ ok: true });
}));

// Unpaid online orders hold stock; release it after 30 minutes.
setInterval(async () => {
  try { for (const o of await rows("SELECT id FROM orders WHERE payment_method='ONLINE' AND payment_status='Unpaid' AND status='Pending' AND created_at < now() - interval '30 minutes'")) await cancelOrder(o.id); }
  catch (e) { console.error('expiry job', e.message); }
}, 5 * 60 * 1000).unref();

app.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image must be under 3 MB' });
  if (err.code === '22P02') return res.status(400).json({ error: 'Invalid id' });
  if (err.code === '23503') return res.status(404).json({ error: 'Not found' });
  if (err.code === '23505') return res.status(409).json({ error: 'Already exists' });
  console.error(err); res.status(500).json({ error: 'Server error' });
});
app.listen(process.env.PORT || 3000, () => console.log('Server running on port', process.env.PORT || 3000));
