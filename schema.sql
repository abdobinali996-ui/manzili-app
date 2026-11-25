-- مخطط قاعدة بيانات برنامج «منزلي» — إدارة محل الأدوات المنزلية (PostgreSQL)
-- نفس المحتوى مضمّن في db.js ويُنفَّذ تلقائياً عند أول تشغيل.
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, username TEXT NOT NULL, display_name TEXT DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'staff',
  active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS parties (
  id SERIAL PRIMARY KEY, type TEXT NOT NULL DEFAULT 'customer', name TEXT NOT NULL,
  phone TEXT DEFAULT '', address TEXT DEFAULT '', opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, barcode TEXT DEFAULT '',
  department TEXT NOT NULL DEFAULT 'home', category TEXT DEFAULT '', unit TEXT DEFAULT 'قطعة',
  cost_price NUMERIC(14,2) NOT NULL DEFAULT 0, sale_price NUMERIC(14,2) NOT NULL DEFAULT 0,
  min_stock NUMERIC(12,3) NOT NULL DEFAULT 0, warranty_months INTEGER NOT NULL DEFAULT 0,
  track_serial BOOLEAN NOT NULL DEFAULT FALSE, active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
  kind TEXT NOT NULL DEFAULT 'in', qty NUMERIC(12,3) NOT NULL DEFAULT 0,
  date DATE NOT NULL, ref_type TEXT DEFAULT '', ref_id INTEGER, notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS stock_movements_item_idx ON stock_movements (item_id);
CREATE TABLE IF NOT EXISTS serials (
  id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
  serial_no TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in_stock',
  purchase_invoice_id INTEGER, sale_invoice_id INTEGER, sale_line_id INTEGER,
  customer_id INTEGER, warranty_months INTEGER DEFAULT 0,
  warranty_start DATE, warranty_end DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS serials_item_no_idx ON serials (item_id, serial_no);
CREATE INDEX IF NOT EXISTS serials_item_idx ON serials (item_id);
CREATE TABLE IF NOT EXISTS purchase_invoices (
  id SERIAL PRIMARY KEY, invoice_no TEXT NOT NULL, supplier_id INTEGER NOT NULL REFERENCES parties(id),
  date DATE NOT NULL, discount NUMERIC(14,2) NOT NULL DEFAULT 0, vat_rate NUMERIC(6,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0, vat_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0, paid NUMERIC(14,2) NOT NULL DEFAULT 0,
  method TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'posted', void_date DATE,
  notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS purchase_invoices_no_idx ON purchase_invoices (invoice_no);
CREATE TABLE IF NOT EXISTS purchase_lines (
  id SERIAL PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id), qty NUMERIC(12,3) NOT NULL DEFAULT 0,
  cost NUMERIC(14,2) NOT NULL DEFAULT 0, line_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  serial_nos TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS sales_invoices (
  id SERIAL PRIMARY KEY, invoice_no TEXT NOT NULL, customer_id INTEGER REFERENCES parties(id),
  customer_name TEXT DEFAULT '', date DATE NOT NULL,
  discount NUMERIC(14,2) NOT NULL DEFAULT 0, vat_rate NUMERIC(6,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0, vat_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0, paid_now NUMERIC(14,2) NOT NULL DEFAULT 0,
  method TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'posted',
  notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS sales_invoices_no_idx ON sales_invoices (invoice_no);
CREATE TABLE IF NOT EXISTS sales_lines (
  id SERIAL PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id), qty NUMERIC(12,3) NOT NULL DEFAULT 0,
  price NUMERIC(14,2) NOT NULL DEFAULT 0, cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL DEFAULT 0, serial_ids TEXT DEFAULT '[]',
  warranty_months INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sales_returns (
  id SERIAL PRIMARY KEY, return_no TEXT NOT NULL, sale_invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id),
  customer_id INTEGER, date DATE NOT NULL, total NUMERIC(14,2) NOT NULL DEFAULT 0,
  settlement TEXT NOT NULL DEFAULT 'account', refund_method TEXT DEFAULT '',
  notes TEXT DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS sales_returns_no_idx ON sales_returns (return_no);
CREATE TABLE IF NOT EXISTS sales_return_lines (
  id SERIAL PRIMARY KEY, return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  sale_line_id INTEGER, item_id INTEGER NOT NULL REFERENCES items(id), qty NUMERIC(12,3) NOT NULL DEFAULT 0,
  price NUMERIC(14,2) NOT NULL DEFAULT 0, cost NUMERIC(14,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(14,2) NOT NULL DEFAULT 0, serial_ids TEXT DEFAULT '[]');
CREATE TABLE IF NOT EXISTS installment_plans (
  id SERIAL PRIMARY KEY, sale_invoice_id INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES parties(id), total NUMERIC(14,2) NOT NULL DEFAULT 0,
  down_payment NUMERIC(14,2) NOT NULL DEFAULT 0, months INTEGER NOT NULL DEFAULT 1,
  first_due DATE NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS installments (
  id SERIAL PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES installment_plans(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 1, due_date DATE NOT NULL, amount NUMERIC(14,2) NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS installment_payments (
  id SERIAL PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES installment_plans(id) ON DELETE CASCADE,
  receipt_no INTEGER, date DATE NOT NULL, amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  method TEXT DEFAULT '', notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS party_payments (
  id SERIAL PRIMARY KEY, party_id INTEGER NOT NULL REFERENCES parties(id),
  receipt_no INTEGER, date DATE NOT NULL, amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  method TEXT DEFAULT '', notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE SEQUENCE IF NOT EXISTS sales_seq START 1;
CREATE SEQUENCE IF NOT EXISTS purchase_seq START 1;
CREATE SEQUENCE IF NOT EXISTS returns_seq START 1;
CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1;
