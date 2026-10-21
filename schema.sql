-- Mysure database for Supabase (PostgreSQL).
-- Run in: Supabase Dashboard > SQL Editor > New query > paste > Run.

CREATE TABLE users (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  phone VARCHAR(15),
  password_hash VARCHAR(100) NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE
);

CREATE TABLE products (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  price NUMERIC(10,2) NOT NULL CHECK (price > 0),
  mrp NUMERIC(10,2),
  stock INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  category_id INT REFERENCES categories(id) ON DELETE SET NULL,
  image_url VARCHAR(500),
  icon VARCHAR(8) DEFAULT '📦',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_name_idx ON products (name);

CREATE TABLE orders (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  customer_name VARCHAR(100) NOT NULL,
  phone VARCHAR(15) NOT NULL,
  address TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'COD' CHECK (payment_method IN ('COD','ONLINE')),
  discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  shipping NUMERIC(10,2) NOT NULL DEFAULT 0,
  total NUMERIC(10,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Shipped','Delivered','Cancelled','Refunded')),
  payment_status TEXT NOT NULL DEFAULT 'Unpaid' CHECK (payment_status IN ('Unpaid','Paid')),
  rp_order_id VARCHAR(40),
  rp_payment_id VARCHAR(40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_user_idx ON orders (user_id);

CREATE TABLE order_items (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(200) NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  quantity INT NOT NULL
);

CREATE TABLE reviews (
  id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment VARCHAR(300) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);

-- IMPORTANT (Supabase): lock these tables so the public "anon" API key can never read or write them.
-- The Node server connects directly as the database owner, which is not affected by this.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;

INSERT INTO categories (name) VALUES ('Electronics'),('Fashion'),('Home');

INSERT INTO products (name, description, price, mrp, stock, category_id, icon) VALUES
('Wireless Headphones','Bluetooth 5.3, 30h battery, deep bass.',2499,3299,15,1,'🎧'),
('Smartphone','6.5-inch AMOLED, 128GB, 50MP camera.',18999,22999,25,1,'📱'),
('Smart Watch','Heart-rate, sleep tracking and 7-day battery.',3999,5999,3,1,'⌚'),
('Running Shoes','Light, breathable and built for daily runs.',1999,2799,30,2,'👟'),
('Casual Shirt','Soft cotton, slim fit, all-day comfort.',999,1799,40,2,'👕'),
('Backpack','Water-resistant, 25L, laptop sleeve.',1299,1899,20,2,'🎒'),
('Coffee Mug','Ceramic, 350ml, microwave safe.',299,499,50,3,'☕'),
('Desk Lamp','LED with adjustable brightness and warmth.',899,1299,12,3,'💡');
