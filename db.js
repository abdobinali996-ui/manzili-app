'use strict';
// طبقة البيانات: PostgreSQL عند وجود DATABASE_URL،
// وإلا مخزن ملف JSON محلي للتجربة والتشغيل بدون قاعدة بيانات.
// (نفس نمط برنامج إدارة الأملاك وبرنامج «رصيد» المجرّبين.)
const fs = require('fs');
const path = require('path');

const TABLES = {
  parties: ['type', 'name', 'phone', 'address', 'opening_balance', 'notes', 'active'],
  items: ['name', 'barcode', 'department', 'category', 'unit', 'cost_price', 'sale_price', 'min_stock', 'warranty_months', 'track_serial', 'active'],
  stock_movements: ['item_id', 'kind', 'qty', 'date', 'ref_type', 'ref_id', 'notes'],
  serials: ['item_id', 'serial_no', 'status', 'purchase_invoice_id', 'sale_invoice_id', 'sale_line_id', 'customer_id', 'warranty_months', 'warranty_start', 'warranty_end'],
  purchase_invoices: ['invoice_no', 'supplier_id', 'date', 'discount', 'vat_rate', 'subtotal', 'vat_total', 'total', 'paid', 'method', 'status', 'void_date', 'notes'],
  purchase_lines: ['invoice_id', 'item_id', 'qty', 'cost', 'line_total', 'serial_nos'],
  sales_invoices: ['invoice_no', 'customer_id', 'customer_name', 'date', 'discount', 'vat_rate', 'subtotal', 'vat_total', 'total', 'paid_now', 'method', 'status', 'notes'],
  sales_lines: ['invoice_id', 'item_id', 'qty', 'price', 'cost', 'line_total', 'serial_ids', 'warranty_months'],
  sales_returns: ['return_no', 'sale_invoice_id', 'customer_id', 'date', 'total', 'settlement', 'refund_method', 'notes'],
  sales_return_lines: ['return_id', 'sale_line_id', 'item_id', 'qty', 'price', 'cost', 'line_total', 'serial_ids'],
  installment_plans: ['sale_invoice_id', 'customer_id', 'total', 'down_payment', 'months', 'first_due', 'status'],
  installments: ['plan_id', 'seq', 'due_date', 'amount'],
  installment_payments: ['plan_id', 'receipt_no', 'date', 'amount', 'method', 'notes'],
  party_payments: ['party_id', 'receipt_no', 'date', 'amount', 'method', 'notes'],
};
// أعمدة تُخزَّن NULL عند إرسال نص فارغ
const NULLABLE = new Set([
  'customer_id', 'purchase_invoice_id', 'sale_invoice_id', 'sale_line_id',
  'warranty_start', 'warranty_end', 'void_date', 'ref_id',
]);
const BOOLS = new Set(['active', 'track_serial']);
const SEQUENCES = { sales: 'sales_seq', purchase: 'purchase_seq', returns: 'returns_seq', receipt: 'receipt_seq' };

const SETTING_KEYS = ['company_name', 'company_logo', 'company_phone', 'company_address', 'country', 'default_vat_rate', 'warranty_enabled'];
const SETTING_DEFAULTS = { country: 'sa', default_vat_rate: '15' };

const usePg = !!process.env.DATABASE_URL;
let pool = null;

if (usePg) {
  const pg = require('pg');
  // التواريخ كنص YYYY-MM-DD والأرقام العشرية كأعداد — حتى يتصرف وضع PostgreSQL
  // تماماً كوضع JSON المحلي
  pg.types.setTypeParser(1082, (v) => v); // DATE
  pg.types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC
  pg.types.setTypeParser(20, (v) => Number(v)); // INT8
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

// إنشاء الجداول تلقائياً عند أول تشغيل (نفس محتوى schema.sql)
const DDL = `
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
`;

// ---------------- مخزن JSON المحلي ----------------
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let mem = null;

function loadMem() {
  if (mem) return mem;
  try {
    mem = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    mem = { seq: {}, counters: { sales: 0, purchase: 0, returns: 0, receipt: 0 }, settings: {}, users: [] };
  }
  for (const t of Object.keys(TABLES)) {
    if (!Array.isArray(mem[t])) mem[t] = [];
    if (!mem.seq) mem.seq = {};
    if (!mem.seq[t]) mem.seq[t] = mem[t].reduce((m, r) => Math.max(m, r.id || 0), 0);
  }
  if (!Array.isArray(mem.users)) mem.users = [];
  if (!mem.seq.users) mem.seq.users = mem.users.reduce((m, r) => Math.max(m, r.id || 0), 0);
  if (!mem.counters) mem.counters = { sales: 0, purchase: 0, returns: 0, receipt: 0 };
  if (!mem.settings || typeof mem.settings !== 'object') mem.settings = {};
  return mem;
}

function saveMem() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(mem, null, 1), 'utf8');
}

// ---------------- واجهة موحّدة ----------------
async function init() {
  if (usePg) await pool.query(DDL);
  else { loadMem(); saveMem(); }
}

async function list(table) {
  if (usePg) {
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id`);
    return rows;
  }
  return [...loadMem()[table]].sort((a, b) => a.id - b.id);
}

async function get(table, id) {
  if (usePg) {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return rows[0] || null;
  }
  return loadMem()[table].find((r) => r.id === Number(id)) || null;
}

function pick(table, obj) {
  const out = {};
  for (const col of TABLES[table]) {
    if (obj[col] === undefined) continue;
    let v = obj[col];
    if (v === '' && NULLABLE.has(col)) v = null;
    if (BOOLS.has(col)) v = v === true || v === 'true' || v === 1 || v === '1';
    out[col] = v;
  }
  return out;
}

function applyDefaults(table, data) {
  if (data.active === undefined && (table === 'parties' || table === 'items')) data.active = true;
  if (table === 'items') {
    if (data.track_serial === undefined) data.track_serial = false;
    if (data.warranty_months === undefined) data.warranty_months = 0;
    if (data.min_stock === undefined) data.min_stock = 0;
  }
  if (table === 'serials' && data.status === undefined) data.status = 'in_stock';
  return data;
}

async function insert(table, obj) {
  const data = applyDefaults(table, pick(table, obj));
  if (usePg) {
    const cols = Object.keys(data);
    const vals = cols.map((c) => data[c]);
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) RETURNING *`, vals);
    return rows[0];
  }
  const m = loadMem();
  const row = { id: ++m.seq[table], created_at: new Date().toISOString(), ...data };
  m[table].push(row);
  saveMem();
  return row;
}

// إدراج سند برقم إيصال من تسلسل السندات المشترك (سدادات الأقساط وسندات الأطراف)
async function insertReceipt(table, obj) {
  const receipt_no = await nextSeq('receipt');
  return insert(table, { ...obj, receipt_no });
}

async function update(table, id, obj) {
  const data = pick(table, obj);
  const cols = Object.keys(data);
  if (!cols.length) return get(table, id);
  if (usePg) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(',');
    const { rows } = await pool.query(
      `UPDATE ${table} SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map((c) => data[c]), id]);
    return rows[0] || null;
  }
  const m = loadMem();
  const row = m[table].find((r) => r.id === Number(id));
  if (!row) return null;
  Object.assign(row, data);
  saveMem();
  return row;
}

async function remove(table, id) {
  if (usePg) {
    await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    return true;
  }
  const m = loadMem();
  const before = m[table].length;
  const nid = Number(id);
  m[table] = m[table].filter((r) => r.id !== nid);
  // حذف متسلسل بسيط في الوضع المحلي (في PostgreSQL تتولاه قيود ON DELETE CASCADE)
  if (table === 'purchase_invoices') m.purchase_lines = m.purchase_lines.filter((l) => l.invoice_id !== nid);
  if (table === 'sales_invoices') {
    m.sales_lines = m.sales_lines.filter((l) => l.invoice_id !== nid);
    m.installment_plans = m.installment_plans.filter((p) => p.sale_invoice_id !== nid);
  }
  if (table === 'sales_returns') m.sales_return_lines = m.sales_return_lines.filter((l) => l.return_id !== nid);
  if (table === 'installment_plans') {
    const planIds = [nid];
    m.installments = m.installments.filter((i) => !planIds.includes(i.plan_id));
    m.installment_payments = m.installment_payments.filter((p) => !planIds.includes(p.plan_id));
  }
  saveMem();
  return m[table].length !== before;
}

async function removeWhere(table, predicate) {
  if (usePg) {
    const rows = await list(table);
    for (const r of rows.filter(predicate)) await remove(table, r.id);
    return true;
  }
  const m = loadMem();
  m[table] = m[table].filter((r) => !predicate(r));
  saveMem();
  return true;
}

// تسلسلات الترقيم: فواتير المبيعات والمشتريات والمرتجعات والسندات
async function nextSeq(name) {
  if (usePg) {
    const { rows } = await pool.query(`SELECT nextval('${SEQUENCES[name]}') AS v`);
    return Number(rows[0].v);
  }
  const m = loadMem();
  m.counters[name] = (m.counters[name] || 0) + 1;
  saveMem();
  return m.counters[name];
}

async function resetSeqs() {
  if (usePg) {
    for (const s of Object.values(SEQUENCES)) await pool.query(`SELECT setval('${s}', 1, false)`);
    return;
  }
  const m = loadMem();
  m.counters = { sales: 0, purchase: 0, returns: 0, receipt: 0 };
  saveMem();
}

// ---------------- الإعدادات ----------------
async function getSettings() {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = SETTING_DEFAULTS[k] || '';
  if (usePg) {
    const { rows } = await pool.query('SELECT key, value FROM settings');
    for (const r of rows) if (SETTING_KEYS.includes(r.key)) out[r.key] = r.value || '';
    return out;
  }
  const s = loadMem().settings || {};
  for (const k of SETTING_KEYS) if (s[k] !== undefined) out[k] = s[k] || '';
  return out;
}

async function setSettings(obj) {
  const data = {};
  for (const k of SETTING_KEYS) {
    if (obj && obj[k] !== undefined) data[k] = obj[k] === null ? '' : String(obj[k]);
  }
  if (usePg) {
    for (const [k, v] of Object.entries(data)) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
    }
    return getSettings();
  }
  const m = loadMem();
  m.settings = { ...(m.settings || {}), ...data };
  saveMem();
  return getSettings();
}

// ---------------- المستخدمون (حسابات الدخول) ----------------
// password_hash بصيغة salt:hash (scrypt) — لا يُعاد أبداً في أي استجابة API.
// ملاحظة: المستخدمون خارج النسخة الاحتياطية (exportAll/importAll) عمداً.
function publicUser(r) {
  if (!r) return null;
  return {
    id: r.id, username: r.username, display_name: r.display_name || '',
    role: r.role === 'admin' ? 'admin' : 'staff',
    active: r.active === undefined || r.active === null ? true : !!r.active,
    created_at: r.created_at,
  };
}
async function listUsers() {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
    return rows.map(publicUser);
  }
  return [...loadMem().users].sort((a, b) => a.id - b.id).map(publicUser);
}
async function getUserByUsername(username) {
  const u = String(username || '').trim().toLowerCase();
  if (!u) return null;
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1', [u]);
    return rows[0] || null;
  }
  return loadMem().users.find((r) => String(r.username || '').toLowerCase() === u) || null;
}
async function getUserById(id) {
  if (usePg) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] || null;
  }
  return loadMem().users.find((r) => r.id === Number(id)) || null;
}
async function insertUser(obj) {
  const data = {
    username: String(obj.username || '').trim(),
    display_name: String(obj.display_name || '').trim(),
    password_hash: String(obj.password_hash || ''),
    role: obj.role === 'admin' ? 'admin' : 'staff',
    active: true,
  };
  if (usePg) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, display_name, password_hash, role, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [data.username, data.display_name, data.password_hash, data.role, data.active]);
    return rows[0];
  }
  const m = loadMem();
  const row = { id: ++m.seq.users, created_at: new Date().toISOString(), ...data };
  m.users.push(row);
  saveMem();
  return row;
}
async function updateUser(id, obj) {
  const data = {};
  if (obj.display_name !== undefined) data.display_name = String(obj.display_name || '').trim();
  if (obj.role !== undefined) data.role = obj.role === 'admin' ? 'admin' : 'staff';
  if (obj.active !== undefined) data.active = !!obj.active;
  if (obj.password_hash !== undefined) data.password_hash = String(obj.password_hash || '');
  const cols = Object.keys(data);
  if (!cols.length) return getUserById(id);
  if (usePg) {
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(',');
    const { rows } = await pool.query(
      `UPDATE users SET ${sets} WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map((c) => data[c]), id]);
    return rows[0] || null;
  }
  const m = loadMem();
  const row = m.users.find((r) => r.id === Number(id));
  if (!row) return null;
  Object.assign(row, data);
  saveMem();
  return row;
}
async function countActiveAdmins(excludeId) {
  const all = usePg
    ? (await pool.query('SELECT id, role, active FROM users')).rows
    : loadMem().users;
  return all.filter((r) => r.role === 'admin' && r.active !== false && Number(r.id) !== Number(excludeId)).length;
}

// ---------------- النسخ الاحتياطي ----------------
async function exportAll() {
  const out = {};
  for (const t of Object.keys(TABLES)) out[t] = await list(t);
  out.settings = await getSettings();
  return out;
}

const IMPORT_ORDER = [
  'parties', 'items', 'purchase_invoices', 'purchase_lines', 'serials', 'stock_movements',
  'sales_invoices', 'sales_lines', 'sales_returns', 'sales_return_lines',
  'installment_plans', 'installments', 'installment_payments', 'party_payments',
];

function countersFromData(data) {
  const maxNo = (rows, prefix) => (rows || [])
    .filter((r) => String(r.invoice_no || r.return_no || '').startsWith(prefix))
    .reduce((mx, r) => Math.max(mx, parseInt(String(r.invoice_no || r.return_no).slice(prefix.length), 10) || 0), 0);
  const maxReceipt = [...(data.installment_payments || []), ...(data.party_payments || [])]
    .reduce((mx, r) => Math.max(mx, r.receipt_no || 0), 0);
  return {
    sales: maxNo(data.sales_invoices, 'S-'),
    purchase: maxNo(data.purchase_invoices, 'P-'),
    returns: maxNo(data.sales_returns, 'R-'),
    receipt: maxReceipt,
  };
}

async function importAll(data) {
  if (usePg) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of [...IMPORT_ORDER].reverse()) await client.query(`DELETE FROM ${t}`);
      for (const t of IMPORT_ORDER) {
        for (const row of data[t] || []) {
          const cols = ['id', ...TABLES[t], 'created_at'].filter((c) => row[c] !== undefined);
          const vals = cols.map((c) => row[c]);
          const ph = cols.map((_, i) => `$${i + 1}`).join(',');
          await client.query(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${ph})`, vals);
        }
      }
      for (const t of IMPORT_ORDER) {
        await client.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), COALESCE((SELECT MAX(id) FROM ${t}), 1))`);
      }
      const c = countersFromData(data);
      await client.query(`SELECT setval('sales_seq', ${Math.max(c.sales, 1)}, ${c.sales > 0})`);
      await client.query(`SELECT setval('purchase_seq', ${Math.max(c.purchase, 1)}, ${c.purchase > 0})`);
      await client.query(`SELECT setval('returns_seq', ${Math.max(c.returns, 1)}, ${c.returns > 0})`);
      await client.query(`SELECT setval('receipt_seq', ${Math.max(c.receipt, 1)}, ${c.receipt > 0})`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    if (data.settings) await setSettings(data.settings);
    return true;
  }
  const m = loadMem();
  for (const t of IMPORT_ORDER) {
    m[t] = Array.isArray(data[t]) ? data[t] : [];
    m.seq[t] = m[t].reduce((mx, r) => Math.max(mx, r.id || 0), 0);
  }
  m.counters = countersFromData(data);
  if (data.settings) m.settings = data.settings;
  saveMem();
  return true;
}

// تصفير البيانات التشغيلية (للعرض التجريبي): تبقى حسابات الدخول والإعدادات كما هي.
async function wipeBusinessData() {
  for (const t of [...IMPORT_ORDER].reverse()) await removeWhere(t, () => true);
  await resetSeqs();
  return true;
}

module.exports = {
  usePg, TABLES, SETTING_KEYS, DATA_FILE, init, list, get, insert, insertReceipt, update, remove, removeWhere,
  nextSeq, resetSeqs, getSettings, setSettings,
  publicUser, listUsers, getUserByUsername, getUserById, insertUser, updateUser, countActiveAdmins,
  exportAll, importAll, wipeBusinessData,
};
