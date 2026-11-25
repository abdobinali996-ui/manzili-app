'use strict';
/* برنامج «منزلي» — خادم API
   إدارة محل أدوات منزلية بقسمين: أجهزة (سيريال + ضمان + تقسيط) ومفروشات
   وأدوات مطبخ (كمية/باركود). مخزون بحركات وسيريالات، مبيعات ومشتريات
   ومرتجعات، أقساط بمتأخرات، كشوف أطراف، وضمانات. */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const calc = require('./calc');

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(__dirname));

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const AUTH_SECRET = process.env.AUTH_SECRET || 'manzili-dev-secret-change-me';
const APP_NAME = 'منزلي';

// ---------- كلمات المرور: تجزئة scrypt مع ملح عشوائي (نفس نمط برنامج الأملاك) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const computed = crypto.scryptSync(String(password), salt, 64);
    const orig = Buffer.from(hash, 'hex');
    return computed.length === orig.length && crypto.timingSafeEqual(computed, orig);
  } catch (_) { return false; }
}

// ---------- مصادقة برمز موقّع يحمل اسم المستخدم والدور ----------
function makeToken(username, role) {
  const payload = Buffer.from(JSON.stringify({ u: username, r: role || 'admin', t: Date.now() })).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
function validToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect)); } catch (_) { return false; }
}
function tokenOf(req) {
  const header = req.headers.authorization || '';
  return header.replace('Bearer ', '') || req.query.token || '';
}
function tokenPayload(token) {
  if (!validToken(token)) return null;
  try {
    const [payload] = token.split('.');
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch (_) { return null; }
}
// الدور المعتمد يأتي من قاعدة البيانات وقت كل طلب — إيقاف الحساب يسري فوراً
async function auth(req, res, next) {
  try {
    const payload = tokenPayload(tokenOf(req));
    if (!payload || !payload.u) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    if (payload.u === ADMIN_USER) {
      req.user = { id: null, username: ADMIN_USER, display_name: 'المدير', role: 'admin', bootstrap: true };
      return next();
    }
    const user = await db.getUserByUsername(payload.u);
    if (!user || user.active === false) return res.status(401).json({ error: 'يجب تسجيل الدخول' });
    req.user = {
      id: user.id, username: user.username,
      display_name: user.display_name || user.username,
      role: user.role === 'admin' ? 'admin' : 'staff', bootstrap: false,
    };
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'هذه العملية متاحة للمدير فقط' });
  }
  next();
}
// الحذف للمدير فقط — الموظف يضيف ويعدّل ويعرض، لكن لا يحذف شيئاً
function adminOnlyDelete(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'الحذف متاح للمدير فقط' });
  }
  next();
}

// ---------- أدوات ----------
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const route = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
const isDateStr = (s) => /^\d{4}-\d{2}-(\d{2})$/.test(String(s || '')) && String(s).length === 10;
const todayStr = () => calc.todayStr();

// تحميل كل البيانات دفعة واحدة (أحجام v1 صغيرة، والحسابات تتم في الذاكرة عبر calc)
async function loadAll() {
  const [items, parties, serials, movements, purchases, purchaseLines, sales, salesLines,
    returns, returnLines, plans, installments, planPayments, partyPayments, settings] = await Promise.all([
    db.list('items'), db.list('parties'), db.list('serials'), db.list('stock_movements'),
    db.list('purchase_invoices'), db.list('purchase_lines'),
    db.list('sales_invoices'), db.list('sales_lines'),
    db.list('sales_returns'), db.list('sales_return_lines'),
    db.list('installment_plans'), db.list('installments'),
    db.list('installment_payments'), db.list('party_payments'),
    db.getSettings(),
  ]);
  calc.setTimezone(calc.countryPreset(settings.country).tz);
  return {
    items, parties, serials, movements, purchases, purchaseLines, sales, salesLines,
    returns, returnLines, plans, installments, planPayments, partyPayments, settings,
  };
}
const balanceData = (d) => ({
  sales: d.sales, purchases: d.purchases, returns: d.returns,
  partyPayments: d.partyPayments, plans: d.plans, planPayments: d.planPayments,
});
function settingsOut(settings) {
  const preset = calc.countryPreset(settings.country);
  return {
    ...settings,
    app_name: APP_NAME,
    currency_label: preset.label,
    timezone: preset.tz,
    payment_methods: preset.methods,
    // مفتاح الضمان (تحديث 3 — بطلب عبده): مفعّل افتراضياً، ويُعطَّل من
    // الإعدادات (النسخة المصرية) فيختفي من الواجهة والفواتير دون حذف بياناته
    warranty_enabled: settings.warranty_enabled !== '0',
  };
}
const itemById = (d, id) => d.items.find((i) => i.id === Number(id)) || null;
const partyById = (d, id) => d.parties.find((p) => p.id === Number(id)) || null;
const decorateItem = (d, item) => ({ ...item, on_hand: calc.onHand(item, d.movements, d.serials) });

// ---------- الدخول والصحة والهوية العامة ----------
app.post('/api/login', route(async (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim();
  if (uname === ADMIN_USER && password === ADMIN_PASSWORD) {
    return res.json({
      token: makeToken(ADMIN_USER, 'admin'),
      user: { id: null, username: ADMIN_USER, display_name: 'المدير', role: 'admin', bootstrap: true },
    });
  }
  const user = await db.getUserByUsername(uname);
  if (!user || !verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
  }
  if (user.active === false) {
    return res.status(403).json({ error: 'هذا الحساب موقوف — تواصل مع المدير' });
  }
  res.json({ token: makeToken(user.username, user.role), user: db.publicUser(user) });
}));
app.get('/api/health', (req, res) => res.json({ ok: true, database: db.usePg ? 'postgresql' : 'local-json' }));
app.get('/api/public-settings', route(async (req, res) => {
  const s = settingsOut(await db.getSettings());
  res.json({ company_name: s.company_name, company_logo: s.company_logo, currency_label: s.currency_label, app_name: APP_NAME });
}));
app.get('/api/me', auth, (req, res) => {
  res.json({
    id: req.user.id, username: req.user.username, display_name: req.user.display_name,
    role: req.user.role, bootstrap: !!req.user.bootstrap,
  });
});
app.post('/api/me/password', auth, route(async (req, res) => {
  if (req.user.bootstrap) {
    throw bad('كلمة سر المدير الرئيسي تُغيَّر من إعدادات الخادم (متغير ADMIN_PASSWORD) وليس من داخل التطبيق');
  }
  const { current_password, new_password } = req.body || {};
  if (!new_password || String(new_password).length < 6) throw bad('كلمة المرور الجديدة قصيرة — 6 أحرف على الأقل');
  const user = await db.getUserById(req.user.id);
  if (!user || !verifyPassword(current_password || '', user.password_hash)) {
    throw bad('كلمة المرور الحالية غير صحيحة');
  }
  await db.updateUser(user.id, { password_hash: hashPassword(new_password) });
  res.json({ ok: true });
}));

// ---------- إدارة المستخدمين (للمدير فقط — لا حذف، إيقاف فقط) ----------
app.get('/api/users', auth, adminOnly, route(async (req, res) => {
  res.json({ users: await db.listUsers(), bootstrap: { username: ADMIN_USER, display_name: 'المدير الرئيسي', role: 'admin' } });
}));
app.post('/api/users', auth, adminOnly, route(async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  if (username.length < 3 || /\s/.test(username)) throw bad('اسم المستخدم يجب أن يكون 3 أحرف على الأقل وبدون مسافات');
  if (username.toLowerCase() === String(ADMIN_USER).toLowerCase()) throw bad('اسم المستخدم محجوز للمدير الرئيسي');
  if (!b.password || String(b.password).length < 6) throw bad('كلمة المرور قصيرة — 6 أحرف على الأقل');
  if (await db.getUserByUsername(username)) throw bad('اسم المستخدم مستخدم من قبل');
  const row = await db.insertUser({
    username,
    display_name: String(b.display_name || '').trim() || username,
    password_hash: hashPassword(b.password),
    role: b.role === 'admin' ? 'admin' : 'staff',
  });
  res.status(201).json(db.publicUser(row));
}));
app.put('/api/users/:id', auth, adminOnly, route(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.getUserById(id);
  if (!existing) return res.status(404).json({ error: 'المستخدم غير موجود' });
  const b = req.body || {};
  const patch = {};
  if (b.display_name !== undefined) patch.display_name = String(b.display_name || '').trim();
  if (b.role !== undefined) patch.role = b.role === 'admin' ? 'admin' : 'staff';
  if (b.active !== undefined) patch.active = !!b.active;
  if (b.password) {
    if (String(b.password).length < 6) throw bad('كلمة المرور قصيرة — 6 أحرف على الأقل');
    patch.password_hash = hashPassword(b.password);
  }
  // منع إيقاف آخر مدير نشط أو تخفيض دوره
  const demotes = (patch.active === false && existing.active !== false)
    || (patch.role === 'staff' && existing.role === 'admin');
  if (demotes && existing.role === 'admin' && (await db.countActiveAdmins(id)) === 0) {
    throw bad('لا يمكن إيقاف أو تخفيض دور آخر مدير نشط');
  }
  res.json(db.publicUser(await db.updateUser(id, patch)));
}));

// ---------- الإعدادات ----------
app.get('/api/settings', auth, route(async (req, res) => res.json(settingsOut(await db.getSettings()))));
app.put('/api/settings', auth, adminOnly, route(async (req, res) => {
  const body = { ...(req.body || {}) };
  if (body.country !== undefined && !['sa', 'eg'].includes(body.country)) throw bad('البلد غير صحيح');
  if (body.default_vat_rate !== undefined && body.default_vat_rate !== '') {
    const r = Number(body.default_vat_rate);
    if (!Number.isFinite(r) || r < 0 || r > 100) throw bad('نسبة الضريبة الافتراضية غير صحيحة');
  }
  if (body.company_logo) {
    const logo = String(body.company_logo).trim();
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(logo) || logo.length > 3_000_000) {
      throw bad('الشعار يجب أن يكون صورة (PNG أو JPG أو WebP) بحجم معقول');
    }
    body.company_logo = logo.replace(/\s/g, '');
  }
  res.json(settingsOut(await db.setSettings(body)));
}));

// ---------- الأصناف ----------
const DEPARTMENTS = { appliances: 'أجهزة', home: 'مفروشات وأدوات مطبخ' };
function validateItemBody(body, existing) {
  const merged = { ...(existing || {}), ...(body || {}) };
  const name = String(merged.name || '').trim();
  if (!name) throw bad('اسم الصنف مطلوب');
  const department = merged.department === 'appliances' ? 'appliances' : 'home';
  // قسم الأجهزة يُتتبَّع بالسيريال دائماً
  const track_serial = department === 'appliances' ? true : !!merged.track_serial;
  const cost_price = calc.round2(merged.cost_price);
  const sale_price = calc.round2(merged.sale_price);
  if (cost_price < 0 || sale_price < 0) throw bad('الأسعار لا تكون سالبة');
  const min_stock = calc.round3(merged.min_stock);
  if (min_stock < 0) throw bad('حد التنبيه لا يكون سالباً');
  const warranty_months = Math.max(0, Math.floor(calc.n(merged.warranty_months)));
  return {
    name, barcode: String(merged.barcode || '').trim(), department,
    category: String(merged.category || '').trim(),
    unit: String(merged.unit || '').trim() || 'قطعة',
    cost_price, sale_price, min_stock, warranty_months, track_serial,
    active: merged.active !== false,
  };
}
app.get('/api/items', auth, route(async (req, res) => {
  const d = await loadAll();
  let items = d.items.map((i) => decorateItem(d, i));
  if (req.query.department) items = items.filter((i) => i.department === req.query.department);
  if (req.query.q) {
    const q = String(req.query.q).trim().toLowerCase();
    items = items.filter((i) => i.name.toLowerCase().includes(q) || String(i.barcode || '').toLowerCase().includes(q));
  }
  res.json(items);
}));
app.get('/api/items/:id', auth, route(async (req, res) => {
  const d = await loadAll();
  const item = itemById(d, req.params.id);
  if (!item) return res.status(404).json({ error: 'الصنف غير موجود' });
  res.json({
    ...decorateItem(d, item),
    serials: d.serials.filter((s) => s.item_id === item.id),
    movements: d.movements.filter((m) => m.item_id === item.id).slice(-50).reverse(),
  });
}));
app.post('/api/items', auth, route(async (req, res) => {
  const data = validateItemBody(req.body || {}, null);
  res.status(201).json(await db.insert('items', data));
}));
app.put('/api/items/:id', auth, route(async (req, res) => {
  const existing = await db.get('items', req.params.id);
  if (!existing) return res.status(404).json({ error: 'الصنف غير موجود' });
  const data = validateItemBody(req.body || {}, existing);
  res.json(await db.update('items', existing.id, data));
}));
app.delete('/api/items/:id', auth, adminOnlyDelete, route(async (req, res) => {
  const d = await loadAll();
  const item = itemById(d, req.params.id);
  if (!item) return res.status(404).json({ error: 'الصنف غير موجود' });
  const used = d.purchaseLines.some((l) => l.item_id === item.id)
    || d.salesLines.some((l) => l.item_id === item.id)
    || d.serials.some((s) => s.item_id === item.id)
    || d.movements.some((m) => m.item_id === item.id);
  if (used) throw bad('الصنف مستخدم في فواتير أو حركات مخزون — أوقفه بدلاً من حذفه');
  await db.remove('items', item.id);
  res.json({ ok: true });
}));
// تعديل مخزون يدوي (جرد) — للأصناف الكمية فقط؛ سيريال الأجهزة يتحرك بالفواتير فقط
app.post('/api/items/:id/adjust', auth, route(async (req, res) => {
  const d = await loadAll();
  const item = itemById(d, req.params.id);
  if (!item) return res.status(404).json({ error: 'الصنف غير موجود' });
  if (calc.isSerialItem(item)) throw bad('أصناف السيريال لا تُعدَّل يدوياً — حركتها من فواتير الشراء والبيع والمرتجعات');
  const delta = calc.round3((req.body || {}).qty);
  if (!delta) throw bad('أدخل كمية التعديل (موجبة للإضافة أو سالبة للخصم)');
  const current = calc.onHand(item, d.movements, d.serials);
  if (current + delta < 0) throw bad(`المتاح حالياً ${current} فقط — لا يمكن خصم ${Math.abs(delta)}`);
  const date = isDateStr((req.body || {}).date) ? req.body.date : todayStr();
  const mv = await db.insert('stock_movements', {
    item_id: item.id, kind: 'adjust', qty: delta, date,
    ref_type: 'adjust', ref_id: null, notes: (req.body || {}).notes || 'تسوية جرد',
  });
  res.status(201).json({ movement: mv, on_hand: calc.round3(current + delta) });
}));
app.get('/api/items/:id/serials', auth, route(async (req, res) => {
  const d = await loadAll();
  const item = itemById(d, req.params.id);
  if (!item) return res.status(404).json({ error: 'الصنف غير موجود' });
  res.json(d.serials.filter((s) => s.item_id === item.id));
}));

// ---------- الأطراف (عملاء وموردون) ----------
function validatePartyBody(body, existing) {
  const merged = { ...(existing || {}), ...(body || {}) };
  const name = String(merged.name || '').trim();
  if (!name) throw bad('اسم الطرف مطلوب');
  if (!['customer', 'supplier'].includes(merged.type)) throw bad('نوع الطرف غير صحيح (عميل/مورد)');
  return {
    type: merged.type, name,
    phone: String(merged.phone || '').trim(), address: String(merged.address || '').trim(),
    opening_balance: calc.round2(merged.opening_balance),
    notes: String(merged.notes || ''), active: merged.active !== false,
  };
}
app.get('/api/parties', auth, route(async (req, res) => {
  const d = await loadAll();
  let parties = d.parties.map((p) => ({ ...p, balance: calc.partyBalance(p, balanceData(d)) }));
  if (req.query.type) parties = parties.filter((p) => p.type === req.query.type);
  if (req.query.q) {
    const q = String(req.query.q).trim().toLowerCase();
    parties = parties.filter((p) => p.name.toLowerCase().includes(q) || String(p.phone || '').includes(q));
  }
  res.json(parties);
}));
app.post('/api/parties', auth, route(async (req, res) => {
  res.status(201).json(await db.insert('parties', validatePartyBody(req.body || {}, null)));
}));
app.put('/api/parties/:id', auth, route(async (req, res) => {
  const existing = await db.get('parties', req.params.id);
  if (!existing) return res.status(404).json({ error: 'الطرف غير موجود' });
  res.json(await db.update('parties', existing.id, validatePartyBody(req.body || {}, existing)));
}));
app.delete('/api/parties/:id', auth, adminOnlyDelete, route(async (req, res) => {
  const d = await loadAll();
  const party = partyById(d, req.params.id);
  if (!party) return res.status(404).json({ error: 'الطرف غير موجود' });
  const used = d.sales.some((s) => s.customer_id === party.id)
    || d.purchases.some((p) => p.supplier_id === party.id)
    || d.partyPayments.some((p) => p.party_id === party.id)
    || d.plans.some((p) => p.customer_id === party.id);
  if (used) throw bad('الطرف له فواتير أو سندات مسجلة — أوقفه بدلاً من حذفه');
  await db.remove('parties', party.id);
  res.json({ ok: true });
}));
app.get('/api/parties/:id/statement', auth, route(async (req, res) => {
  const d = await loadAll();
  const party = partyById(d, req.params.id);
  if (!party) return res.status(404).json({ error: 'الطرف غير موجود' });
  res.json(calc.partyStatement(party, balanceData(d)));
}));

// ---------- سندات الأطراف (قبض من عميل / صرف لمورد — على الحساب) ----------
app.get('/api/party-payments', auth, route(async (req, res) => {
  const d = await loadAll();
  let rows = [...d.partyPayments].sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id);
  if (req.query.party_id) rows = rows.filter((p) => p.party_id === Number(req.query.party_id));
  res.json(rows.map((p) => ({ ...p, party_name: (partyById(d, p.party_id) || {}).name || '' })));
}));
app.post('/api/party-payments', auth, route(async (req, res) => {
  const b = req.body || {};
  const d = await loadAll();
  const party = partyById(d, b.party_id);
  if (!party) throw bad('اختر العميل/المورد');
  const amount = calc.round2(b.amount);
  if (!(amount > 0)) throw bad('مبلغ السند يجب أن يكون أكبر من صفر');
  const date = isDateStr(b.date) ? b.date : todayStr();
  const row = await db.insertReceipt('party_payments', {
    party_id: party.id, date, amount,
    method: String(b.method || 'نقداً'), notes: String(b.notes || ''),
  });
  const d2 = await loadAll();
  res.status(201).json({ ...row, party_name: party.name, party_balance: calc.partyBalance(party, balanceData(d2)) });
}));
app.delete('/api/party-payments/:id', auth, adminOnlyDelete, route(async (req, res) => {
  const row = await db.get('party_payments', req.params.id);
  if (!row) return res.status(404).json({ error: 'السند غير موجود' });
  await db.remove('party_payments', row.id);
  res.json({ ok: true });
}));
app.get('/api/party-payments/:id/receipt', auth, route(async (req, res) => {
  const d = await loadAll();
  const row = d.partyPayments.find((p) => p.id === Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'السند غير موجود' });
  const party = partyById(d, row.party_id);
  res.json({
    payment: row, party,
    party_balance: party ? calc.partyBalance(party, balanceData(d)) : 0,
    settings: settingsOut(d.settings),
  });
}));

// ---------- فواتير الشراء ----------
async function createPurchase(d, body) {
  const supplier = partyById(d, body.supplier_id);
  if (!supplier || supplier.type !== 'supplier') throw bad('اختر المورد');
  if (supplier.active === false) throw bad('المورد موقوف');
  const date = isDateStr(body.date) ? body.date : todayStr();
  const vatRate = body.vat_rate === undefined || body.vat_rate === '' ? calc.n(d.settings.default_vat_rate) : calc.n(body.vat_rate);
  if (vatRate < 0 || vatRate > 100) throw bad('نسبة الضريبة غير صحيحة');
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (!rawLines.length) throw bad('أضف سطراً واحداً على الأقل للفاتورة');
  const seenSerials = new Map(); // item_id → Set(serial_no)
  const prepared = [];
  for (const l of rawLines) {
    const item = itemById(d, l.item_id);
    if (!item) throw bad('صنف غير موجود في أحد السطور');
    const qty = calc.round3(l.qty);
    if (!(qty > 0)) throw bad(`كمية «${item.name}» يجب أن تكون أكبر من صفر`);
    const cost = l.cost === undefined || l.cost === '' ? calc.round2(item.cost_price) : calc.round2(l.cost);
    if (cost < 0) throw bad('تكلفة الشراء لا تكون سالبة');
    let serialNos = [];
    if (calc.isSerialItem(item)) {
      if (!Number.isInteger(qty)) throw bad(`«${item.name}» جهاز بسيريال — الكمية يجب أن تكون عدداً صحيحاً`);
      serialNos = (Array.isArray(l.serial_nos) ? l.serial_nos : []).map((s) => String(s).trim()).filter(Boolean);
      if (serialNos.length !== qty) throw bad(`«${item.name}»: عدد السيريالات (${serialNos.length}) يجب أن يساوي الكمية (${qty})`);
      if (!seenSerials.has(item.id)) seenSerials.set(item.id, new Set());
      const seen = seenSerials.get(item.id);
      for (const sn of serialNos) {
        if (seen.has(sn)) throw bad(`السيريال ${sn} مكرر في نفس الفاتورة`);
        seen.add(sn);
        if (d.serials.some((s) => s.item_id === item.id && s.serial_no === sn)) {
          throw bad(`السيريال ${sn} مسجل من قبل لصنف «${item.name}»`);
        }
      }
    }
    prepared.push({ item, qty, cost, serialNos });
  }
  const totals = calc.invoiceTotals(prepared.map((p) => ({ qty: p.qty, price: p.cost })), body.discount, vatRate);
  const paid = calc.round2(body.paid || 0);
  if (paid < 0 || paid - totals.total > calc.EPS) throw bad('المبلغ المسدد للمورد أكبر من إجمالي الفاتورة');
  const seq = await db.nextSeq('purchase');
  const inv = await db.insert('purchase_invoices', {
    invoice_no: `P-${String(seq).padStart(4, '0')}`, supplier_id: supplier.id, date,
    discount: totals.discount, vat_rate: vatRate, subtotal: totals.subtotal,
    vat_total: totals.vat_total, total: totals.total, paid,
    method: String(body.method || ''), status: 'posted', void_date: null,
    notes: String(body.notes || ''),
  });
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    await db.insert('purchase_lines', {
      invoice_id: inv.id, item_id: p.item.id, qty: p.qty, cost: p.cost,
      line_total: totals.lines[i].line_total, serial_nos: JSON.stringify(p.serialNos),
    });
    await db.insert('stock_movements', {
      item_id: p.item.id, kind: 'in', qty: p.qty, date,
      ref_type: 'purchase', ref_id: inv.id, notes: `شراء ${inv.invoice_no}`,
    });
    for (const sn of p.serialNos) {
      await db.insert('serials', {
        item_id: p.item.id, serial_no: sn, status: 'in_stock',
        purchase_invoice_id: inv.id, sale_invoice_id: null, sale_line_id: null,
        customer_id: null, warranty_months: p.item.warranty_months || 0,
        warranty_start: null, warranty_end: null,
      });
    }
  }
  return inv;
}
function getPurchaseFull(id, d) {
  const inv = d.purchases.find((p) => p.id === Number(id));
  if (!inv) return null;
  const supplier = partyById(d, inv.supplier_id);
  const lines = d.purchaseLines.filter((l) => l.invoice_id === inv.id).map((l) => {
    const item = itemById(d, l.item_id);
    return {
      ...l, item_name: item ? item.name : '', department: item ? item.department : '',
      unit: item ? item.unit : '', serial_nos: calc.parseSerialList(l.serial_nos),
    };
  });
  return { ...inv, supplier, supplier_name: supplier ? supplier.name : '', lines };
}
app.get('/api/purchases', auth, route(async (req, res) => {
  const d = await loadAll();
  const rows = [...d.purchases].sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id)
    .map((p) => ({ ...p, supplier_name: (partyById(d, p.supplier_id) || {}).name || '' }));
  res.json(rows);
}));
app.get('/api/purchases/:id', auth, route(async (req, res) => {
  const d = await loadAll();
  const full = getPurchaseFull(req.params.id, d);
  if (!full) return res.status(404).json({ error: 'فاتورة الشراء غير موجودة' });
  res.json(full);
}));
app.post('/api/purchases', auth, route(async (req, res) => {
  const d = await loadAll();
  const inv = await createPurchase(d, req.body || {});
  const d2 = await loadAll();
  res.status(201).json(getPurchaseFull(inv.id, d2));
}));
// إلغاء فاتورة شراء: فقط إن لم يُبع أي سيريال منها وبقيت الكميات بالمخزون
app.post('/api/purchases/:id/void', auth, route(async (req, res) => {
  const d = await loadAll();
  const inv = d.purchases.find((p) => p.id === Number(req.params.id));
  if (!inv) return res.status(404).json({ error: 'فاتورة الشراء غير موجودة' });
  if (inv.status !== 'posted') throw bad('الفاتورة ملغاة بالفعل');
  const lines = d.purchaseLines.filter((l) => l.invoice_id === inv.id);
  for (const l of lines) {
    const item = itemById(d, l.item_id);
    if (item && calc.isSerialItem(item)) {
      const serials = d.serials.filter((s) => s.purchase_invoice_id === inv.id && s.item_id === item.id);
      if (serials.some((s) => s.status !== 'in_stock')) {
        throw bad(`لا يمكن إلغاء الفاتورة: أحد أجهزة «${item.name}» تم بيعه أو إخراجه من المخزون`);
      }
    } else if (item) {
      if (calc.onHand(item, d.movements, d.serials) < calc.n(l.qty)) {
        throw bad(`لا يمكن إلغاء الفاتورة: كمية «${item.name}» المتبقية بالمخزون أقل من كمية الشراء`);
      }
    }
  }
  for (const l of lines) {
    await db.insert('stock_movements', {
      item_id: l.item_id, kind: 'out', qty: -calc.n(l.qty), date: todayStr(),
      ref_type: 'purchase_void', ref_id: inv.id, notes: `إلغاء شراء ${inv.invoice_no}`,
    });
  }
  await db.removeWhere('serials', (s) => s.purchase_invoice_id === inv.id);
  await db.update('purchase_invoices', inv.id, { status: 'void', void_date: todayStr() });
  const d2 = await loadAll();
  res.json(getPurchaseFull(inv.id, d2));
}));

// ---------- فواتير البيع / نقطة البيع ----------
async function createSale(d, body) {
  let customer = null;
  if (body.customer_id) {
    customer = partyById(d, body.customer_id);
    if (!customer || customer.type !== 'customer') throw bad('اختر عميلاً صحيحاً');
  }
  const date = isDateStr(body.date) ? body.date : todayStr();
  const vatRate = body.vat_rate === undefined || body.vat_rate === '' ? calc.n(d.settings.default_vat_rate) : calc.n(body.vat_rate);
  if (vatRate < 0 || vatRate > 100) throw bad('نسبة الضريبة غير صحيحة');
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (!rawLines.length) throw bad('أضف سطراً واحداً على الأقل للفاتورة');
  // الطلب الكلي لكل صنف كمي (قد يتكرر الصنف في أكثر من سطر)
  const demand = new Map();
  const prepared = [];
  for (const l of rawLines) {
    const item = itemById(d, l.item_id);
    if (!item) throw bad('صنف غير موجود في أحد السطور');
    if (item.active === false) throw bad(`الصنف «${item.name}» موقوف`);
    const qty = calc.round3(l.qty);
    if (!(qty > 0)) throw bad(`كمية «${item.name}» يجب أن تكون أكبر من صفر`);
    const price = l.price === undefined || l.price === '' ? calc.round2(item.sale_price) : calc.round2(l.price);
    if (price < 0) throw bad('سعر البيع لا يكون سالباً');
    let serialIds = [];
    let warrantyMonths = 0;
    if (calc.isSerialItem(item)) {
      if (!Number.isInteger(qty)) throw bad(`«${item.name}» جهاز بسيريال — الكمية يجب أن تكون عدداً صحيحاً`);
      serialIds = [...new Set((Array.isArray(l.serial_ids) ? l.serial_ids : []).map(Number).filter((x) => x > 0))];
      if (serialIds.length !== qty) throw bad(`«${item.name}»: اختر ${qty} سيريال للبيع`);
      for (const sid of serialIds) {
        const s = d.serials.find((x) => x.id === sid);
        if (!s || s.item_id !== item.id) throw bad(`سيريال غير صحيح لصنف «${item.name}»`);
        if (s.status !== 'in_stock') throw bad(`السيريال ${s.serial_no} غير متاح للبيع (حالته: ${s.status})`);
      }
      warrantyMonths = l.warranty_months === undefined || l.warranty_months === ''
        ? Math.floor(calc.n(item.warranty_months)) : Math.max(0, Math.floor(calc.n(l.warranty_months)));
    } else {
      demand.set(item.id, calc.round3((demand.get(item.id) || 0) + qty));
    }
    prepared.push({ item, qty, price, cost: calc.round2(item.cost_price), serialIds, warrantyMonths });
  }
  for (const [itemId, need] of demand) {
    const item = itemById(d, itemId);
    const have = calc.onHand(item, d.movements, d.serials);
    if (need - have > 0.0005) throw bad(`المتاح من «${item.name}» هو ${have} فقط — لا يمكن بيع ${need}`);
  }
  const totals = calc.invoiceTotals(prepared.map((p) => ({ qty: p.qty, price: p.price })), body.discount, vatRate);
  const paidNow = calc.round2(body.paid_now || 0);
  if (paidNow < 0 || paidNow - totals.total > calc.EPS) throw bad('المبلغ المدفوع أكبر من إجمالي الفاتورة');
  const remaining = calc.round2(totals.total - paidNow);
  // خطة التقسيط اختيارية عند وجود باقٍ
  let planSpec = null;
  if (body.installments && calc.n(body.installments.months) > 0) {
    if (!customer) throw bad('البيع بالتقسيط يحتاج عميلاً مسجلاً — اختر العميل أولاً');
    if (remaining <= 0) throw bad('الفاتورة مسددة بالكامل — لا حاجة لخطة تقسيط');
    const months = Math.floor(calc.n(body.installments.months));
    const firstDue = body.installments.first_due;
    if (!isDateStr(firstDue)) throw bad('تاريخ أول قسط مطلوب وبصيغة صحيحة');
    planSpec = { months, first_due: firstDue };
  }
  const seq = await db.nextSeq('sales');
  const inv = await db.insert('sales_invoices', {
    invoice_no: `S-${String(seq).padStart(4, '0')}`,
    customer_id: customer ? customer.id : null,
    customer_name: customer ? customer.name : String(body.customer_name || 'عميل نقدي'),
    date, discount: totals.discount, vat_rate: vatRate, subtotal: totals.subtotal,
    vat_total: totals.vat_total, total: totals.total, paid_now: paidNow,
    method: String(body.method || ''), status: 'posted', notes: String(body.notes || ''),
  });
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    const line = await db.insert('sales_lines', {
      invoice_id: inv.id, item_id: p.item.id, qty: p.qty, price: p.price, cost: p.cost,
      line_total: totals.lines[i].line_total, serial_ids: JSON.stringify(p.serialIds),
      warranty_months: p.warrantyMonths,
    });
    await db.insert('stock_movements', {
      item_id: p.item.id, kind: 'out', qty: -p.qty, date,
      ref_type: 'sale', ref_id: inv.id, notes: `بيع ${inv.invoice_no}`,
    });
    for (const sid of p.serialIds) {
      await db.update('serials', sid, {
        status: 'sold', sale_invoice_id: inv.id, sale_line_id: line.id,
        customer_id: customer ? customer.id : null,
        warranty_months: p.warrantyMonths, warranty_start: date,
        warranty_end: calc.warrantyEndDate(date, p.warrantyMonths),
      });
    }
  }
  if (planSpec) {
    const plan = await db.insert('installment_plans', {
      sale_invoice_id: inv.id, customer_id: customer.id, total: totals.total,
      down_payment: paidNow, months: planSpec.months, first_due: planSpec.first_due, status: 'active',
    });
    for (const inst of calc.buildSchedule(totals.total, paidNow, planSpec.months, planSpec.first_due)) {
      await db.insert('installments', { plan_id: plan.id, seq: inst.seq, due_date: inst.due_date, amount: inst.amount });
    }
  }
  return inv;
}
function planForSale(d, saleId) {
  const plan = d.plans.find((p) => p.sale_invoice_id === Number(saleId));
  if (!plan) return null;
  const installments = d.installments.filter((i) => i.plan_id === plan.id);
  const payments = d.planPayments.filter((p) => p.plan_id === plan.id);
  return { ...plan, summary: calc.planSummary(plan, installments, payments, calc.today()), payments };
}
function getSaleFull(id, d) {
  const inv = d.sales.find((s) => s.id === Number(id));
  if (!inv) return null;
  const lines = d.salesLines.filter((l) => l.invoice_id === inv.id).map((l) => {
    const item = itemById(d, l.item_id);
    const serials = calc.parseSerialList(l.serial_ids).map((sid) => {
      const s = d.serials.find((x) => x.id === Number(sid));
      return s ? { id: s.id, serial_no: s.serial_no, warranty_end: s.warranty_end, status: s.status } : { id: sid, serial_no: '', warranty_end: null, status: '' };
    });
    return {
      ...l, item_name: item ? item.name : '', department: item ? item.department : '',
      unit: item ? item.unit : '', serials,
    };
  });
  const plan = planForSale(d, inv.id);
  const returns = d.returns.filter((r) => r.sale_invoice_id === inv.id).map((r) => ({
    ...r, lines: d.returnLines.filter((l) => l.return_id === r.id),
  }));
  const planPaid = plan ? plan.summary.paid : 0;
  const accountReturns = returns.filter((r) => r.settlement === 'account').reduce((s, r) => s + calc.n(r.total), 0);
  const cashRefunds = returns.filter((r) => r.settlement === 'cash').reduce((s, r) => s + calc.n(r.total), 0);
  const owed = calc.round2(calc.n(inv.total) - calc.n(inv.paid_now) - planPaid - accountReturns);
  return {
    ...inv, lines, plan, returns,
    paid_total: calc.round2(calc.n(inv.paid_now) + planPaid),
    account_returns: calc.round2(accountReturns), cash_refunds: calc.round2(cashRefunds),
    owed,
  };
}
app.get('/api/sales', auth, route(async (req, res) => {
  const d = await loadAll();
  let rows = [...d.sales].sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id);
  if (req.query.customer_id) rows = rows.filter((s) => s.customer_id === Number(req.query.customer_id));
  res.json(rows.map((s) => {
    const plan = d.plans.find((p) => p.sale_invoice_id === s.id);
    return { ...s, has_plan: !!plan, plan_id: plan ? plan.id : null };
  }));
}));
app.get('/api/sales/:id', auth, route(async (req, res) => {
  const d = await loadAll();
  const full = getSaleFull(req.params.id, d);
  if (!full) return res.status(404).json({ error: 'فاتورة البيع غير موجودة' });
  res.json(full);
}));
app.post('/api/sales', auth, route(async (req, res) => {
  const d = await loadAll();
  const inv = await createSale(d, req.body || {});
  const d2 = await loadAll();
  res.status(201).json(getSaleFull(inv.id, d2));
}));
app.get('/api/sales/:id/print', auth, route(async (req, res) => {
  const d = await loadAll();
  const full = getSaleFull(req.params.id, d);
  if (!full) return res.status(404).json({ error: 'فاتورة البيع غير موجودة' });
  res.json({ invoice: full, settings: settingsOut(d.settings) });
}));

// ---------- مرتجعات المبيعات ----------
app.get('/api/returns', auth, route(async (req, res) => {
  const d = await loadAll();
  const rows = [...d.returns].sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id)
    .map((r) => {
      const sale = d.sales.find((s) => s.id === r.sale_invoice_id);
      return { ...r, sale_invoice_no: sale ? sale.invoice_no : '', customer_name: sale ? sale.customer_name : '' };
    });
  res.json(rows);
}));
app.get('/api/returns/:id', auth, route(async (req, res) => {
  const d = await loadAll();
  const r = d.returns.find((x) => x.id === Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'المرتجع غير موجود' });
  res.json({ ...r, lines: d.returnLines.filter((l) => l.return_id === r.id) });
}));
app.post('/api/returns', auth, route(async (req, res) => {
  const body = req.body || {};
  const d = await loadAll();
  const sale = d.sales.find((s) => s.id === Number(body.sale_invoice_id));
  if (!sale || sale.status !== 'posted') throw bad('فاتورة البيع غير موجودة');
  const date = isDateStr(body.date) ? body.date : todayStr();
  const settlement = body.settlement === 'cash' ? 'cash' : 'account';
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (!rawLines.length) throw bad('أضف سطراً واحداً على الأقل للمرتجع');
  const returnedQtyByLine = new Map();
  for (const r of d.returns.filter((x) => x.sale_invoice_id === sale.id)) {
    for (const rl of d.returnLines.filter((x) => x.return_id === r.id)) {
      returnedQtyByLine.set(rl.sale_line_id, calc.round3((returnedQtyByLine.get(rl.sale_line_id) || 0) + calc.n(rl.qty)));
    }
  }
  const prepared = [];
  let returnTotal = 0;
  for (const l of rawLines) {
    const saleLine = d.salesLines.find((x) => x.id === Number(l.sale_line_id) && x.invoice_id === sale.id);
    if (!saleLine) throw bad('سطر فاتورة غير صحيح في المرتجع');
    const item = itemById(d, saleLine.item_id);
    const qty = calc.round3(l.qty);
    if (!(qty > 0)) throw bad('كمية المرتجع يجب أن تكون أكبر من صفر');
    const already = returnedQtyByLine.get(saleLine.id) || 0;
    if (already + qty - calc.n(saleLine.qty) > 0.0005) {
      throw bad(`«${item ? item.name : ''}»: الكمية المباعة ${saleLine.qty} والمرتجع منها سابقاً ${already} — لا يمكن إرجاع ${qty}`);
    }
    let serialIds = [];
    if (item && calc.isSerialItem(item)) {
      if (!Number.isInteger(qty)) throw bad('كمية مرتجع الأجهزة يجب أن تكون عدداً صحيحاً');
      serialIds = [...new Set((Array.isArray(l.serial_ids) ? l.serial_ids : []).map(Number).filter((x) => x > 0))];
      if (serialIds.length !== qty) throw bad(`اختر ${qty} سيريال للإرجاع`);
      const soldIds = calc.parseSerialList(saleLine.serial_ids).map(Number);
      for (const sid of serialIds) {
        if (!soldIds.includes(sid)) throw bad('سيريال لم يُبع في هذا السطر');
        const s = d.serials.find((x) => x.id === sid);
        if (!s || s.status !== 'sold' || s.sale_line_id !== saleLine.id) throw bad(`السيريال ${s ? s.serial_no : sid} ليس في حالة مباع على هذا السطر`);
      }
    }
    const lineTotal = calc.round2(qty * calc.n(saleLine.price));
    returnTotal = calc.round2(returnTotal + lineTotal);
    prepared.push({ saleLine, item, qty, serialIds, lineTotal });
  }
  if (!(returnTotal > 0)) throw bad('قيمة المرتجع صفر');
  // قواعد التسوية مع خطة التقسيط والاسترداد النقدي
  const plan = d.plans.find((p) => p.sale_invoice_id === sale.id) || null;
  let planSummaryNow = null;
  if (plan) {
    if (settlement === 'cash') throw bad('الفاتورة عليها خطة تقسيط — المرتجع يُسوّى على الحساب (تخفيض الخطة) فقط');
    planSummaryNow = calc.planSummary(plan, d.installments.filter((i) => i.plan_id === plan.id), d.planPayments.filter((p) => p.plan_id === plan.id), calc.today());
    if (returnTotal - planSummaryNow.remaining > calc.EPS) {
      throw bad(`قيمة المرتجع (${returnTotal}) أكبر من المتبقي على خطة التقسيط (${planSummaryNow.remaining})`);
    }
  } else if (settlement === 'cash') {
    const priorCash = d.returns.filter((r) => r.sale_invoice_id === sale.id && r.settlement === 'cash')
      .reduce((s, r) => s + calc.n(r.total), 0);
    if (returnTotal - (calc.n(sale.paid_now) - priorCash) > calc.EPS) {
      throw bad('الاسترداد النقدي لا يتجاوز ما دفعه العميل فعلياً عند البيع');
    }
  }
  const seq = await db.nextSeq('returns');
  const ret = await db.insert('sales_returns', {
    return_no: `R-${String(seq).padStart(4, '0')}`, sale_invoice_id: sale.id,
    customer_id: sale.customer_id, date, total: returnTotal, settlement,
    refund_method: settlement === 'cash' ? String(body.refund_method || 'نقداً') : '',
    notes: String(body.notes || ''),
  });
  for (const p of prepared) {
    await db.insert('sales_return_lines', {
      return_id: ret.id, sale_line_id: p.saleLine.id, item_id: p.saleLine.item_id,
      qty: p.qty, price: calc.n(p.saleLine.price), cost: calc.n(p.saleLine.cost),
      line_total: p.lineTotal, serial_ids: JSON.stringify(p.serialIds),
    });
    await db.insert('stock_movements', {
      item_id: p.saleLine.item_id, kind: 'in', qty: p.qty, date,
      ref_type: 'return', ref_id: ret.id, notes: `مرتجع ${ret.return_no} على ${sale.invoice_no}`,
    });
    for (const sid of p.serialIds) {
      await db.update('serials', sid, {
        status: 'in_stock', sale_invoice_id: null, sale_line_id: null, customer_id: null,
        warranty_start: null, warranty_end: null,
      });
    }
  }
  // تخفيض خطة التقسيط: يُخصم المرتجع من ذيل الجدول (الأقساط الأخيرة غير المسددة)
  if (plan) {
    const installments = d.installments.filter((i) => i.plan_id === plan.id).sort((a, b) => a.seq - b.seq);
    const alloc = calc.allocateInstallments(installments, planSummaryNow.paid);
    let excess = returnTotal;
    for (const inst of [...installments].reverse()) {
      if (excess <= 0) break;
      const reducible = calc.round2(calc.n(inst.amount) - (alloc.get(inst.id) || 0));
      const cut = Math.min(reducible, excess);
      if (cut > 0) {
        await db.update('installments', inst.id, { amount: calc.round2(calc.n(inst.amount) - cut) });
        excess = calc.round2(excess - cut);
      }
    }
    const newTotal = calc.round2(calc.n(plan.total) - returnTotal);
    const newRemaining = calc.round2(newTotal - calc.n(plan.down_payment) - planSummaryNow.paid);
    await db.update('installment_plans', plan.id, {
      total: newTotal, status: newRemaining <= calc.EPS ? 'done' : 'active',
    });
  }
  const d2 = await loadAll();
  const saved = d2.returns.find((x) => x.id === ret.id);
  res.status(201).json({ ...saved, lines: d2.returnLines.filter((l) => l.return_id === ret.id) });
}));

// ---------- خطط التقسيط وسداداتها ----------
function decoratePlan(d, plan) {
  const installments = d.installments.filter((i) => i.plan_id === plan.id);
  const payments = d.planPayments.filter((p) => p.plan_id === plan.id);
  const summary = calc.planSummary(plan, installments, payments, calc.today());
  const sale = d.sales.find((s) => s.id === plan.sale_invoice_id);
  const customer = partyById(d, plan.customer_id);
  return {
    ...plan, status: summary.status, summary,
    invoice_no: sale ? sale.invoice_no : '', sale_date: sale ? sale.date : '',
    customer_name: customer ? customer.name : (sale ? sale.customer_name : ''),
    customer_phone: customer ? customer.phone : '',
  };
}
app.get('/api/plans', auth, route(async (req, res) => {
  const d = await loadAll();
  let plans = d.plans.map((p) => decoratePlan(d, p));
  if (req.query.customer_id) plans = plans.filter((p) => p.customer_id === Number(req.query.customer_id));
  if (req.query.overdue) plans = plans.filter((p) => p.summary.arrears > calc.EPS);
  plans.sort((a, b) => (b.summary.arrears - a.summary.arrears) || String(a.summary.next_due ? a.summary.next_due.due_date : '9999').localeCompare(String(b.summary.next_due ? b.summary.next_due.due_date : '9999')));
  res.json(plans);
}));
app.get('/api/plans/:id', auth, route(async (req, res) => {
  const d = await loadAll();
  const plan = d.plans.find((p) => p.id === Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'خطة التقسيط غير موجودة' });
  const payments = d.planPayments.filter((p) => p.plan_id === plan.id)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);
  res.json({ ...decoratePlan(d, plan), payments });
}));
app.post('/api/plans/:id/payments', auth, route(async (req, res) => {
  const b = req.body || {};
  const d = await loadAll();
  const plan = d.plans.find((p) => p.id === Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'خطة التقسيط غير موجودة' });
  const summary = calc.planSummary(plan, d.installments.filter((i) => i.plan_id === plan.id), d.planPayments.filter((p) => p.plan_id === plan.id), calc.today());
  const amount = calc.round2(b.amount);
  if (!(amount > 0)) throw bad('مبلغ القسط يجب أن يكون أكبر من صفر');
  if (amount - summary.remaining > calc.EPS) throw bad(`مبلغ السداد أكبر من المتبقي على الخطة (${summary.remaining})`);
  const date = isDateStr(b.date) ? b.date : todayStr();
  const row = await db.insertReceipt('installment_payments', {
    plan_id: plan.id, date, amount,
    method: String(b.method || 'نقداً'), notes: String(b.notes || ''),
  });
  const d2 = await loadAll();
  const plan2 = d2.plans.find((p) => p.id === plan.id);
  const summary2 = calc.planSummary(plan2, d2.installments.filter((i) => i.plan_id === plan.id), d2.planPayments.filter((p) => p.plan_id === plan.id), calc.today());
  if (summary2.status !== plan2.status) await db.update('installment_plans', plan.id, { status: summary2.status });
  res.status(201).json({ payment: row, summary: summary2 });
}));
app.get('/api/installment-payments/:id/receipt', auth, route(async (req, res) => {
  const d = await loadAll();
  const payment = d.planPayments.find((p) => p.id === Number(req.params.id));
  if (!payment) return res.status(404).json({ error: 'سند القسط غير موجود' });
  const plan = d.plans.find((p) => p.id === payment.plan_id);
  const customer = plan ? partyById(d, plan.customer_id) : null;
  const sale = plan ? d.sales.find((s) => s.id === plan.sale_invoice_id) : null;
  const summary = plan ? calc.planSummary(plan, d.installments.filter((i) => i.plan_id === plan.id), d.planPayments.filter((p) => p.plan_id === plan.id), calc.today()) : null;
  res.json({ payment, plan, summary, customer, invoice_no: sale ? sale.invoice_no : '', settings: settingsOut(d.settings) });
}));

// ---------- بحث الضمان ----------
app.get('/api/warranty', auth, route(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const d = await loadAll();
  const today = todayStr();
  const matches = d.serials.filter((s) => {
    if (String(s.serial_no).toLowerCase().includes(q)) return true;
    const cust = s.customer_id ? partyById(d, s.customer_id) : null;
    return !!(cust && String(cust.phone || '').includes(q));
  }).slice(0, 50);
  res.json(matches.map((s) => {
    const item = itemById(d, s.item_id);
    const cust = s.customer_id ? partyById(d, s.customer_id) : null;
    const sale = s.sale_invoice_id ? d.sales.find((x) => x.id === s.sale_invoice_id) : null;
    let status_text;
    if (s.status === 'in_stock') status_text = 'في المخزون — لم يُبع';
    else if (s.status === 'returned') status_text = 'مرتجع';
    else status_text = s.warranty_end && String(s.warranty_end) >= today ? 'ساري' : 'منتهٍ';
    return {
      serial_id: s.id, serial_no: s.serial_no, status: s.status, status_text,
      item_name: item ? item.name : '', department: item ? item.department : '',
      customer_name: cust ? cust.name : (sale ? sale.customer_name : ''),
      customer_phone: cust ? cust.phone : '',
      sale_date: sale ? sale.date : null, invoice_no: sale ? sale.invoice_no : '',
      warranty_months: s.warranty_months, warranty_start: s.warranty_start, warranty_end: s.warranty_end,
    };
  }));
}));

// ---------- لوحة التحكم ----------
app.get('/api/dashboard', auth, route(async (req, res) => {
  const d = await loadAll();
  const today = todayStr();
  const monthPrefix = today.slice(0, 7);
  const monthFrom = `${monthPrefix}-01`;
  const postedSales = d.sales.filter((s) => s.status === 'posted');
  const sumDay = (rows, dateField) => calc.round2(rows.filter((r) => calc.fmtDate(r[dateField]) === today).reduce((s, r) => s + calc.n(r.total), 0));
  const sumMonth = (rows) => calc.round2(rows.filter((r) => calc.fmtDate(r.date).startsWith(monthPrefix)).reduce((s, r) => s + calc.n(r.total), 0));
  const salesToday = calc.round2(sumDay(postedSales, 'date') - sumDay(d.returns, 'date'));
  const salesMonth = calc.round2(sumMonth(postedSales) - sumMonth(d.returns));
  const profitMonth = calc.periodProfit(d.sales, d.salesLines, d.returns, d.returnLines, monthFrom, today);
  const lowStock = d.items.filter((i) => i.active !== false)
    .map((i) => decorateItem(d, i))
    .filter((i) => i.on_hand <= calc.n(i.min_stock))
    .sort((a, b) => a.on_hand - b.on_hand);
  // الأقساط: المستحق هذا الشهر والمتأخرات
  let dueThisMonth = 0;
  let overdueTotal = 0;
  const overduePlans = [];
  for (const plan of d.plans) {
    const summary = calc.planSummary(plan, d.installments.filter((i) => i.plan_id === plan.id), d.planPayments.filter((p) => p.plan_id === plan.id), calc.today());
    for (const inst of summary.installments) {
      if (String(inst.due_date).startsWith(monthPrefix)) dueThisMonth = calc.round2(dueThisMonth + calc.n(inst.remaining));
    }
    if (summary.arrears > calc.EPS) {
      overdueTotal = calc.round2(overdueTotal + summary.arrears);
      const customer = partyById(d, plan.customer_id);
      const sale = d.sales.find((s) => s.id === plan.sale_invoice_id);
      overduePlans.push({
        plan_id: plan.id, customer_id: plan.customer_id,
        customer_name: customer ? customer.name : '', invoice_no: sale ? sale.invoice_no : '',
        arrears: summary.arrears, remaining: summary.remaining,
        next_due_date: summary.next_due ? summary.next_due.due_date : null,
      });
    }
  }
  overduePlans.sort((a, b) => b.arrears - a.arrears);
  // مبيعات الشهر حسب القسم (صافي بعد المرتجعات)
  const deptTotals = new Map();
  const itemDept = (id) => (itemById(d, id) || {}).department || 'home';
  for (const s of postedSales.filter((x) => calc.fmtDate(x.date).startsWith(monthPrefix))) {
    for (const l of d.salesLines.filter((x) => x.invoice_id === s.id)) {
      deptTotals.set(itemDept(l.item_id), calc.round2((deptTotals.get(itemDept(l.item_id)) || 0) + calc.n(l.line_total)));
    }
  }
  for (const r of d.returns.filter((x) => calc.fmtDate(x.date).startsWith(monthPrefix))) {
    for (const l of d.returnLines.filter((x) => x.return_id === r.id)) {
      deptTotals.set(itemDept(l.item_id), calc.round2((deptTotals.get(itemDept(l.item_id)) || 0) - calc.n(l.line_total)));
    }
  }
  const recent = [
    ...postedSales.map((s) => ({ kind: 'sale', kind_label: 'بيع', id: s.id, invoice_no: s.invoice_no, date: s.date, party_name: s.customer_name, total: s.total, status: s.status })),
    ...d.purchases.map((p) => ({ kind: 'purchase', kind_label: 'شراء', id: p.id, invoice_no: p.invoice_no, date: p.date, party_name: (partyById(d, p.supplier_id) || {}).name || '', total: p.total, status: p.status })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id).slice(0, 8);
  res.json({
    today, sales_today: salesToday, sales_month: salesMonth,
    // الربح للمدير فقط (تحديث 4 — بطلب عبده): لا يصل رقم الربح لحساب الموظف أصلاً
    profit_month: req.user && req.user.role === 'admin' ? profitMonth : null,
    low_stock_count: lowStock.length, low_stock: lowStock.slice(0, 10),
    installments_due_month: calc.round2(dueThisMonth), overdue_total: overdueTotal,
    overdue_plans: overduePlans.slice(0, 10),
    stock_value: calc.stockValue(d.items, d.movements, d.serials),
    dept_sales_month: [...deptTotals.entries()].map(([department, total]) => ({ department, label: DEPARTMENTS[department] || department, total })),
    recent_invoices: recent,
  });
}));

// ---------- التقارير ----------
app.get('/api/reports/stock', auth, route(async (req, res) => {
  const d = await loadAll();
  let items = d.items.map((i) => {
    const onHand = calc.onHand(i, d.movements, d.serials);
    return { ...i, on_hand: onHand, value: calc.round2(onHand * calc.n(i.cost_price)) };
  });
  if (req.query.department) items = items.filter((i) => i.department === req.query.department);
  res.json({ rows: items, total_value: calc.round2(items.reduce((s, i) => s + i.value, 0)) });
}));
app.get('/api/reports/sales', auth, route(async (req, res) => {
  const d = await loadAll();
  const from = isDateStr(req.query.from) ? req.query.from : `${todayStr().slice(0, 7)}-01`;
  const to = isDateStr(req.query.to) ? req.query.to : todayStr();
  const inRange = (date) => { const s = calc.fmtDate(date); return s >= from && s <= to; };
  const dept = req.query.department || '';
  const invoices = d.sales.filter((s) => s.status === 'posted' && inRange(s.date))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id);
  const returns = d.returns.filter((r) => inRange(r.date));
  const itemDept = (id) => (itemById(d, id) || {}).department || 'home';
  const byDept = new Map();
  let salesTotal = 0;
  for (const s of invoices) {
    for (const l of d.salesLines.filter((x) => x.invoice_id === s.id)) {
      if (dept && itemDept(l.item_id) !== dept) continue;
      salesTotal = calc.round2(salesTotal + calc.n(l.line_total));
      const row = byDept.get(itemDept(l.item_id)) || { department: itemDept(l.item_id), total: 0, profit: 0 };
      row.total = calc.round2(row.total + calc.n(l.line_total));
      row.profit = calc.round2(row.profit + (calc.n(l.price) - calc.n(l.cost)) * calc.n(l.qty));
      byDept.set(itemDept(l.item_id), row);
    }
  }
  let returnsTotal = 0;
  for (const r of returns) {
    for (const l of d.returnLines.filter((x) => x.return_id === r.id)) {
      if (dept && itemDept(l.item_id) !== dept) continue;
      returnsTotal = calc.round2(returnsTotal + calc.n(l.line_total));
      const row = byDept.get(itemDept(l.item_id)) || { department: itemDept(l.item_id), total: 0, profit: 0 };
      row.total = calc.round2(row.total - calc.n(l.line_total));
      row.profit = calc.round2(row.profit - (calc.n(l.price) - calc.n(l.cost)) * calc.n(l.qty));
      byDept.set(itemDept(l.item_id), row);
    }
  }
  const isAdm = req.user && req.user.role === 'admin'; // الربح للمدير فقط (تحديث 4)
  res.json({
    from, to,
    invoices: invoices.map((s) => ({ ...s, has_plan: d.plans.some((p) => p.sale_invoice_id === s.id) })),
    sales_total: salesTotal, returns_total: returnsTotal,
    net: calc.round2(salesTotal - returnsTotal),
    profit: isAdm ? calc.round2([...byDept.values()].reduce((s, r) => s + r.profit, 0)) : null,
    by_department: [...byDept.values()].map((r) => ({ ...r, profit: isAdm ? r.profit : null, label: DEPARTMENTS[r.department] || r.department })),
  });
}));
app.get('/api/reports/installments', auth, route(async (req, res) => {
  const d = await loadAll();
  const plans = d.plans.map((p) => decoratePlan(d, p));
  const totals = {
    plans: plans.length,
    financed: calc.round2(plans.reduce((s, p) => s + (calc.n(p.total) - calc.n(p.down_payment)), 0)),
    paid: calc.round2(plans.reduce((s, p) => s + p.summary.paid, 0)),
    remaining: calc.round2(plans.reduce((s, p) => s + p.summary.remaining, 0)),
    arrears: calc.round2(plans.reduce((s, p) => s + p.summary.arrears, 0)),
  };
  res.json({ plans, totals });
}));
app.get('/api/reports/balances', auth, route(async (req, res) => {
  const d = await loadAll();
  const rows = d.parties.map((p) => ({ ...p, balance: calc.partyBalance(p, balanceData(d)) }));
  const customers = rows.filter((p) => p.type === 'customer').sort((a, b) => b.balance - a.balance);
  const suppliers = rows.filter((p) => p.type === 'supplier').sort((a, b) => b.balance - a.balance);
  res.json({
    customers, suppliers,
    receivables: calc.round2(customers.reduce((s, p) => s + Math.max(p.balance, 0), 0)),
    payables: calc.round2(suppliers.reduce((s, p) => s + Math.max(p.balance, 0), 0)),
  });
}));

// ---------- النسخ الاحتياطي ----------
app.get('/api/backup', auth, adminOnly, route(async (req, res) => {
  const data = await db.exportAll();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`نسخة-احتياطية-منزلي-${todayStr()}.json`)}`);
  res.send(JSON.stringify(data, null, 1));
}));
app.post('/api/restore', auth, adminOnly, route(async (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.parties) || !Array.isArray(body.items) || !Array.isArray(body.sales_invoices)) {
    throw bad('ملف نسخة غير صالح');
  }
  // نسخة أمان من الحالة الحالية قبل الاستيراد — تبقى أحدث نسخة أمان واحدة فقط
  const dir = path.dirname(db.DATA_FILE);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyName = `safety-before-restore-${stamp}.json`;
  try {
    const current = await db.exportAll();
    fs.writeFileSync(path.join(dir, safetyName), JSON.stringify(current, null, 1), 'utf8');
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('safety-before-restore-') && f !== safetyName) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) { /* تجاهل */ }
      }
    }
  } catch (e) { throw bad(`تعذّر حفظ نسخة الأمان قبل الاستعادة: ${e.message}`); }
  await db.importAll(body);
  res.json({ ok: true, safety_file: safetyName });
}));
app.get('/api/backup/safety', auth, adminOnly, route(async (req, res) => {
  const dir = path.dirname(db.DATA_FILE);
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('safety-before-restore-')).sort();
  if (!files.length) return res.status(404).json({ error: 'لا توجد نسخة أمان محفوظة' });
  const latest = files[files.length - 1];
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(latest)}`);
  res.send(fs.readFileSync(path.join(dir, latest), 'utf8'));
}));

// ---------- البيانات التجريبية (للعرض على العملاء) ----------
const fmtD = (dt) => calc.fmtDate(dt);
const daysAgo = (k) => fmtD(calc.addDays(calc.today(), -k));
const monthsAhead = (k) => fmtD(calc.addMonths(calc.today(), k));

app.post('/api/demo/seed', auth, adminOnly, route(async (req, res) => {
  const d0 = await loadAll();
  if (d0.items.length || d0.parties.length || d0.sales.length || d0.purchases.length) {
    throw bad('توجد بيانات حالية — استخدم «مسح البيانات» أولاً ثم أعد التعبئة');
  }
  if (!d0.settings.company_name) await db.setSettings({ company_name: 'معرض منزلي التجريبي' });

  const suppliers = [];
  for (const s of [
    { name: 'شركة التوريدات المنزلية', phone: '0112345678', address: 'الرياض — المنطقة الصناعية الثانية' },
    { name: 'مؤسسة الخليج للأجهزة', phone: '0509876543', address: 'جدة — حي البلد' },
  ]) suppliers.push(await db.insert('parties', validatePartyBody({ type: 'supplier', ...s }, null)));
  const customers = [];
  for (const c of [
    { name: 'أحمد الشمري', phone: '0501112233', address: 'الرياض — حي النرجس' },
    { name: 'سارة العتيبي', phone: '0554443322', address: 'الرياض — حي الياسمين' },
    { name: 'محمد الحربي', phone: '0533334455', address: 'الخرج — حي الخالدية' },
  ]) customers.push(await db.insert('parties', validatePartyBody({ type: 'customer', ...c }, null)));

  const items = {};
  for (const it of [
    { key: 'fridge', name: 'ثلاجة 18 قدم', barcode: '1001', department: 'appliances', category: 'تبريد', unit: 'جهاز', cost_price: 18000, sale_price: 22500, min_stock: 1, warranty_months: 24 },
    { key: 'washer', name: 'غسالة 10 كجم', barcode: '1002', department: 'appliances', category: 'غسيل', unit: 'جهاز', cost_price: 14000, sale_price: 17500, min_stock: 1, warranty_months: 24 },
    { key: 'tv', name: 'شاشة 55 بوصة', barcode: '1003', department: 'appliances', category: 'شاشات', unit: 'جهاز', cost_price: 9000, sale_price: 11900, min_stock: 1, warranty_months: 12 },
    { key: 'ac', name: 'تكييف سبليت 18 ألف', barcode: '1004', department: 'appliances', category: 'تكييف', unit: 'جهاز', cost_price: 20000, sale_price: 25000, min_stock: 1, warranty_months: 36 },
    { key: 'pots', name: 'طقم حلل 12 قطعة', barcode: '2001', department: 'home', category: 'أدوات مطبخ', unit: 'طقم', cost_price: 1800, sale_price: 2400, min_stock: 3, warranty_months: 0 },
    { key: 'plates', name: 'طقم أطباق 24 قطعة', barcode: '2002', department: 'home', category: 'أدوات مطبخ', unit: 'طقم', cost_price: 950, sale_price: 1350, min_stock: 3, warranty_months: 0 },
    { key: 'trays', name: 'طقم صواني فرن', barcode: '2003', department: 'home', category: 'أدوات مطبخ', unit: 'طقم', cost_price: 300, sale_price: 450, min_stock: 5, warranty_months: 0 },
    { key: 'bedding', name: 'طقم مفروشات سرير', barcode: '2004', department: 'home', category: 'مفروشات', unit: 'طقم', cost_price: 700, sale_price: 1050, min_stock: 3, warranty_months: 0 },
  ]) items[it.key] = await db.insert('items', validateItemBody(it, null));

  // فاتورة شراء افتتاحية من المورد الأول (مسدد منها جزء)
  let d = await loadAll();
  const purchase = await createPurchase(d, {
    supplier_id: suppliers[0].id, date: daysAgo(6), paid: 20000, method: 'تحويل',
    lines: [
      { item_id: items.fridge.id, qty: 2, serial_nos: ['FR-1001', 'FR-1002'] },
      { item_id: items.washer.id, qty: 2, serial_nos: ['WM-2001', 'WM-2002'] },
      { item_id: items.tv.id, qty: 2, serial_nos: ['TV-3001', 'TV-3002'] },
      { item_id: items.ac.id, qty: 1, serial_nos: ['AC-4001'] },
      { item_id: items.pots.id, qty: 10 },
      { item_id: items.plates.id, qty: 10 },
      { item_id: items.trays.id, qty: 15 },
      { item_id: items.bedding.id, qty: 8 },
    ],
  });

  // بيع نقدي كامل: ثلاجة + طقمي حلل (الإجمالي يُحسب أولاً ليكون paid_now مساوياً له)
  d = await loadAll();
  const fridgeSerial = d.serials.find((s) => s.item_id === items.fridge.id && s.status === 'in_stock');
  const cashLines = [
    { item_id: items.fridge.id, qty: 1, price: calc.n(items.fridge.sale_price), serial_ids: [fridgeSerial.id] },
    { item_id: items.pots.id, qty: 2, price: calc.n(items.pots.sale_price) },
  ];
  const cashTotals = calc.invoiceTotals(cashLines, 0, calc.n(d.settings.default_vat_rate));
  const saleCash = await createSale(d, {
    customer_id: customers[0].id, date: daysAgo(2), method: 'نقداً',
    lines: cashLines, paid_now: cashTotals.total,
  });
  // بيع بالتقسيط: غسالة، دفعة أولى و6 أقساط
  d = await loadAll();
  const washerSerial = d.serials.find((s) => s.item_id === items.washer.id && s.status === 'in_stock');
  const salePlan = await createSale(d, {
    customer_id: customers[1].id, date: daysAgo(1), method: 'تحويل', paid_now: 2500,
    lines: [{ item_id: items.washer.id, qty: 1, serial_ids: [washerSerial.id] }],
    installments: { months: 6, first_due: monthsAhead(1) },
  });

  res.status(201).json({
    ok: true, parties: suppliers.length + customers.length, items: Object.keys(items).length,
    purchases: 1, sales: 2, purchase_no: purchase.invoice_no,
    sale_cash_no: saleCash.invoice_no, sale_plan_no: salePlan.invoice_no,
  });
}));

app.post('/api/demo/wipe', auth, adminOnly, route(async (req, res) => {
  await db.wipeBusinessData();
  res.json({ ok: true });
}));

// ---------- التشغيل ----------
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'غير موجود' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = Number(process.env.PORT) || 3000;
db.init()
  .then(() => app.listen(PORT, () => console.log(`Manzili app listening on :${PORT} (${db.usePg ? 'PostgreSQL' : 'local JSON'})`)))
  .catch((e) => { console.error('DB init failed:', e); process.exit(1); });
