// Creates the ONE admin account directly in the database (no public admin signup exists).
require('dotenv').config();
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
(async () => {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD, DATABASE_URL } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (8+ chars) in .env');
  if (!DATABASE_URL) throw new Error('Set DATABASE_URL in .env');
  const db = new Client({ connectionString: DATABASE_URL, ssl: process.env.DB_SSL === 'off' ? false : { rejectUnauthorized: false } });
  await db.connect();
  const { rows: [{ n }] } = await db.query("SELECT COUNT(*)::int n FROM users WHERE role='admin'");
  if (n > 0) { console.log('Admin already exists. Nothing changed.'); return process.exit(); }
  await db.query("INSERT INTO users (name,email,password_hash,role) VALUES ($1,$2,$3,'admin')",
    [ADMIN_NAME || 'Admin', ADMIN_EMAIL.toLowerCase(), await bcrypt.hash(ADMIN_PASSWORD, 12)]);
  console.log('Admin created:', ADMIN_EMAIL); process.exit();
})().catch(e => { console.error(e.message); process.exit(1); });
