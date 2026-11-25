'use strict';
/* برنامج «منزلي» — واجهة التطبيق
   محل أدوات منزلية: أجهزة بالسيريال والضمان، ومفروشات وأدوات مطبخ بالكمية. */

// ---------------- أدوات عامة ----------------
const $ = (sel) => document.querySelector(sel);
const main = () => $('#main');
const token = () => sessionStorage.getItem('manzili_token') || '';
let SETTINGS = { company_name: '', country: 'sa', currency_label: 'ر.س', default_vat_rate: '15', payment_methods: ['نقداً', 'تحويل'], app_name: 'منزلي', timezone: 'Asia/Riyadh' };
let ME = null;
const CUR = () => SETTINGS.currency_label || 'ر.س';
const money = (v) => `${Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${CUR()}`;
// مفتاح الضمان (تحديث 3): عند تعطيله من الإعدادات يختفي من الواجهة والفواتير
const warrantyOn = () => SETTINGS.warranty_enabled !== false;
const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const round2 = (x) => Math.round((num(x) + Number.EPSILON) * 100) / 100;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// «اليوم» بتوقيت بلد المتجر (من الإعدادات) لا بتوقيت جهاز المستخدم — حتى لا
// تُرحَّل فاتورة لليوم التالي لمجرد أن الجهاز مضبوط على بلد آخر (تحديث 6)
const todayStr = () => {
  const tz = (typeof SETTINGS !== 'undefined' && SETTINGS.timezone) || 'Asia/Riyadh';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const g = (t) => (parts.find((x) => x.type === t) || {}).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  } catch (_) { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
};
const monthFirst = () => `${todayStr().slice(0, 7)}-01`;
const fmtDate = (s) => (s ? String(s).slice(0, 10) : '—');
const DEPT_LABELS = { appliances: 'أجهزة', home: 'مفروشات وأدوات مطبخ' };
const isAdmin = () => ME && ME.role === 'admin';

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, ...(options.headers || {}) },
  });
  if (res.status === 401) { logout(); throw new Error('انتهت الجلسة'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}
async function downloadFile(path, fallbackName) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token()}` } });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'تعذّر إنشاء الملف'); }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? decodeURIComponent(m[1]) : fallbackName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------------- التفقيط ----------------
function numberToArabicWords(v) {
  v = Math.floor(Math.abs(v));
  if (v === 0) return 'صفر';
  const ones = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
  const tens = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
  const hundreds = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
  function below1000(x) {
    const parts = [];
    const h = Math.floor(x / 100), r = x % 100;
    if (h) parts.push(hundreds[h]);
    if (r) {
      if (r < 20) parts.push(ones[r]);
      else { const t = Math.floor(r / 10), o = r % 10; parts.push(o ? `${ones[o]} و${tens[t]}` : tens[t]); }
    }
    return parts.join(' و');
  }
  const scales = [
    { v: 1e9, one: 'مليار', two: 'ملياران', few: 'مليارات' },
    { v: 1e6, one: 'مليون', two: 'مليونان', few: 'ملايين' },
    { v: 1e3, one: 'ألف', two: 'ألفان', few: 'آلاف' },
  ];
  const parts = [];
  let rem = v;
  for (const s of scales) {
    const c = Math.floor(rem / s.v);
    if (c) {
      rem %= s.v;
      if (c === 1) parts.push(s.one);
      else if (c === 2) parts.push(s.two);
      else if (c <= 10) parts.push(`${below1000(c)} ${s.few}`);
      else parts.push(`${below1000(c)} ${s.one}`);
    }
  }
  if (rem) parts.push(below1000(rem));
  return parts.join(' و');
}
function currencyWords() {
  const label = CUR();
  if (label.includes('ج.م') || label.includes('جنيه')) return { one: 'جنيه مصري واحد', two: 'جنيهان مصريان', few: 'جنيهات مصرية', other: 'جنيه مصري', sub: 'قرش' };
  return { one: 'ريال سعودي واحد', two: 'ريالان سعوديان', few: 'ريالات سعودية', other: 'ريال سعودي', sub: 'هللة' };
}
function tafqeet(amount) {
  const total = Math.round(num(amount) * 100);
  const units = Math.floor(total / 100);
  const subs = total % 100;
  const w = currencyWords();
  let unitText = '';
  if (units === 1) unitText = w.one;
  else if (units === 2) unitText = w.two;
  else if (units >= 3 && units <= 10) unitText = `${numberToArabicWords(units)} ${w.few}`;
  else if (units > 10) unitText = `${numberToArabicWords(units)} ${w.other}`;
  let text = unitText;
  if (subs > 0) text += `${text ? ' و' : ''}${numberToArabicWords(subs)} ${w.sub}`;
  return `${text || `صفر ${w.other}`} فقط لا غير`;
}

// ---------------- النافذة المنبثقة ----------------
function openModal(title, bodyHtml, wide = false) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalBox').classList.toggle('wide', !!wide);
  $('#modalBackdrop').classList.remove('hidden');
}
function closeModal() {
  $('#modalBackdrop').classList.add('hidden');
  $('#modalBody').innerHTML = '';
}
$('#modalClose').addEventListener('click', closeModal);
function formModal(title, fieldsHtml, onSubmit, submitLabel = 'حفظ', wide = false) {
  openModal(title, `<form id="modalForm">${fieldsHtml}
    <div class="form-actions"><button type="submit" class="btn primary">${submitLabel}</button>
    <button type="button" class="btn" id="modalCancel">إلغاء</button></div>
    <p class="error" id="formError"></p></form>`, wide);
  $('#modalCancel').addEventListener('click', closeModal);
  let submitting = false;
  $('#modalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    const btn = e.target.querySelector('button[type="submit"]');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'جارٍ الحفظ…'; }
    const data = Object.fromEntries(new FormData(e.target).entries());
    try { await onSubmit(data); closeModal(); }
    catch (err) {
      $('#formError').textContent = err.message;
      submitting = false;
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  });
}
function confirmAction(title, text, okLabel, onYes, danger = true) {
  openModal(title, `<p>${text}</p>
    <div class="form-actions"><button class="btn ${danger ? 'danger' : 'primary'}" id="cfYes">${okLabel}</button>
    <button class="btn" id="cfNo">إلغاء</button></div><p class="error" id="cfError"></p>`);
  $('#cfNo').addEventListener('click', closeModal);
  let busy = false;
  $('#cfYes').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    $('#cfYes').disabled = true;
    try { await onYes(); closeModal(); }
    catch (e) { $('#cfError').textContent = e.message; busy = false; $('#cfYes').disabled = false; }
  });
}
const delBtn = (fn, id, label) => (isAdmin() ? `<button class="btn small danger" onclick="${fn}(${id})">حذف</button>` : '');

// ---------------- الدخول والخروج والتنقل ----------------
function logout() {
  sessionStorage.removeItem('manzili_token');
  ME = null;
  $('#app').classList.add('hidden');
  $('#loginScreen').classList.remove('hidden');
}
$('#logoutBtn').addEventListener('click', logout);
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'خطأ');
    sessionStorage.setItem('manzili_token', out.token);
    startApp();
  } catch (err) { $('#loginError').textContent = err.message; }
});
async function loadBranding() {
  try {
    const b = await (await fetch('/api/public-settings')).json();
    if (b.company_name) {
      $('#loginCompany').textContent = b.company_name;
      document.title = `${b.company_name} | منزلي`;
    }
    if (b.company_logo) $('#loginLogo').innerHTML = `<img src="${b.company_logo}" alt="">`;
  } catch (_) { /* تجاهل */ }
}
let CACHE = { items: [], parties: [], settings: SETTINGS };
async function refreshCache() {
  const [items, parties, settings] = await Promise.all([
    api('/api/items'), api('/api/parties'), api('/api/settings').catch(() => SETTINGS),
  ]);
  SETTINGS = settings;
  CACHE = { items, parties, settings };
  applyBranding();
}
function applyBranding() {
  const name = SETTINGS.company_name || SETTINGS.app_name || 'منزلي';
  $('#brandName').textContent = `🏠 ${name}`;
  if (SETTINGS.company_name) document.title = `${SETTINGS.company_name} | منزلي`;
  const logo = $('#brandLogo');
  if (SETTINGS.company_logo) { logo.src = SETTINGS.company_logo; logo.classList.remove('hidden'); }
  else logo.classList.add('hidden');
}
let currentView = 'dashboard';
function go(view) {
  currentView = view;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  render();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => go(b.dataset.view)));
async function render() {
  const views = {
    dashboard: viewDashboard, pos: viewPos, sales: viewSales, purchases: viewPurchases,
    items: viewItems, parties: viewParties, plans: viewPlans, reminders: viewReminders, reports: viewReports,
    warranty: viewWarranty, settings: viewSettings,
  };
  main().innerHTML = '<p class="muted">جارٍ التحميل…</p>';
  try { await views[currentView](); } catch (e) { main().innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
async function startApp() {
  try {
    ME = await api('/api/me');
  } catch (_) { logout(); return; }
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#userChip').textContent = `${ME.display_name} · ${ME.role === 'admin' ? 'مدير' : 'موظف'}`;
  await refreshCache();
  const wBtn = document.querySelector('#tabs button[data-view="warranty"]');
  if (wBtn) wBtn.style.display = warrantyOn() ? '' : 'none';
  render();
}

// ---------------- لوحة التحكم ----------------
async function viewDashboard() {
  await refreshCache();
  const d = await api('/api/dashboard');
  const deptCards = (d.dept_sales_month || []).map((r) =>
    `<div class="card"><div class="lbl">مبيعات ${esc(r.label)} — هذا الشهر</div><div class="num">${money(r.total)}</div></div>`).join('');
  main().innerHTML = `
    <div class="cards">
      <div class="card good"><div class="lbl">مبيعات اليوم</div><div class="num">${money(d.sales_today)}</div></div>
      <div class="card good"><div class="lbl">مبيعات هذا الشهر</div><div class="num">${money(d.sales_month)}</div></div>
      ${isAdmin() ? `<div class="card ${d.profit_month >= 0 ? 'good' : 'warn'}"><div class="lbl">الربح التقديري هذا الشهر</div><div class="num">${money(d.profit_month)}</div></div>` : ''}
      <div class="card"><div class="lbl">قيمة المخزون بالتكلفة</div><div class="num">${money(d.stock_value)}</div></div>
      <div class="card" style="cursor:pointer" onclick="go('items')"><div class="lbl">أصناف منخفضة المخزون</div><div class="num">${d.low_stock_count}</div></div>
      <div class="card"><div class="lbl">أقساط مستحقة هذا الشهر</div><div class="num">${money(d.installments_due_month)}</div></div>
      <div class="card warn" style="cursor:pointer" onclick="go('plans')"><div class="lbl">إجمالي متأخرات الأقساط</div><div class="num">${money(d.overdue_total)}</div></div>
      ${deptCards}
    </div>
    <div class="cols2">
      <div class="section">
        <div class="section-head"><h3>⚠️ أقساط متأخرة</h3><button class="btn small" onclick="go('plans')">كل الخطط</button></div>
        ${d.overdue_plans.length ? `<div class="table-wrap"><table><tr><th>العميل</th><th>الفاتورة</th><th>المتأخر</th><th>المتبقي</th><th></th></tr>
          ${d.overdue_plans.map((p) => `<tr><td>${esc(p.customer_name)}</td><td>${esc(p.invoice_no)}</td>
            <td class="money debit-red">${money(p.arrears)}</td><td class="money">${money(p.remaining)}</td>
            <td><button class="btn small primary" onclick="planPaymentForm(${p.plan_id})">سداد قسط</button></td></tr>`).join('')}</table></div>`
        : '<p class="muted">لا توجد أقساط متأخرة 🎉</p>'}
      </div>
      <div class="section">
        <div class="section-head"><h3>📦 مخزون منخفض</h3><button class="btn small" onclick="go('items')">الأصناف</button></div>
        ${d.low_stock.length ? `<div class="table-wrap"><table><tr><th>الصنف</th><th>القسم</th><th>المتاح</th><th>حد التنبيه</th></tr>
          ${d.low_stock.map((i) => `<tr><td>${esc(i.name)}</td><td>${DEPT_LABELS[i.department] || ''}</td>
            <td class="money debit-red">${i.on_hand}</td><td>${i.min_stock}</td></tr>`).join('')}</table></div>`
        : '<p class="muted">المخزون مطمئن.</p>'}
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h3>أحدث الفواتير</h3><button class="btn small primary" onclick="go('pos')">+ فاتورة بيع</button></div>
      ${d.recent_invoices.length ? `<div class="table-wrap"><table><tr><th>الرقم</th><th>النوع</th><th>التاريخ</th><th>الطرف</th><th>الإجمالي</th><th>الحالة</th></tr>
        ${d.recent_invoices.map((i) => `<tr><td><strong>${esc(i.invoice_no)}</strong></td><td>${i.kind_label}</td><td>${fmtDate(i.date)}</td>
          <td>${esc(i.party_name)}</td><td class="money">${money(i.total)}</td>
          <td>${i.status === 'void' ? '<span class="badge red">ملغاة</span>' : '<span class="badge green">مرحّلة</span>'}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد فواتير بعد — ابدأ من «نقطة بيع» أو «المشتريات».</p>'}
    </div>`;
}

// ---------------- الأصناف والمخزون ----------------
let itemsFilter = { q: '', department: '' };
async function viewItems() {
  await refreshCache();
  const params = new URLSearchParams();
  if (itemsFilter.q) params.set('q', itemsFilter.q);
  if (itemsFilter.department) params.set('department', itemsFilter.department);
  const items = await api(`/api/items?${params}`);
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>الأصناف والمخزون</h3><button class="btn primary" onclick="itemForm()">+ صنف جديد</button></div>
      <div class="search-row">
        <label>بحث بالاسم أو الباركود<input id="itemQ" value="${esc(itemsFilter.q)}" placeholder="اكتب للبحث…"></label>
        <label>القسم<select id="itemDept">
          <option value="">كل الأقسام</option>
          <option value="appliances" ${itemsFilter.department === 'appliances' ? 'selected' : ''}>أجهزة</option>
          <option value="home" ${itemsFilter.department === 'home' ? 'selected' : ''}>مفروشات وأدوات مطبخ</option>
        </select></label>
        <button class="btn" id="itemSearchBtn">بحث</button>
      </div>
      ${items.length ? `<div class="table-wrap"><table><tr><th>الصنف</th><th>الباركود</th><th>القسم</th><th>الوحدة</th><th>التكلفة</th><th>سعر البيع</th><th>المتاح</th>${warrantyOn() ? '<th>الضمان</th>' : ''}<th></th></tr>
        ${items.map((i) => `<tr${i.active === false ? ' style="opacity:.55"' : ''}><td><strong>${esc(i.name)}</strong>${i.category ? `<div class="muted" style="font-size:12px">${esc(i.category)}</div>` : ''}</td>
          <td class="serial-nums">${esc(i.barcode || '')}</td>
          <td><span class="badge ${i.department === 'appliances' ? '' : 'gray'}">${DEPT_LABELS[i.department] || ''}</span></td>
          <td>${esc(i.unit)}</td><td class="money">${money(i.cost_price)}</td><td class="money">${money(i.sale_price)}</td>
          <td class="money ${i.on_hand <= num(i.min_stock) ? 'debit-red' : ''}">${i.on_hand}${i.track_serial ? ' <span class="badge dept-tag">سيريال</span>' : ''}</td>
          ${warrantyOn() ? `<td>${i.warranty_months ? `${i.warranty_months} شهر` : '—'}</td>` : ''}
          <td style="white-space:nowrap">
            <button class="btn small" onclick="itemForm(${i.id})">تعديل</button>
            ${i.track_serial ? `<button class="btn small" onclick="showSerials(${i.id})">السيريالات</button>` : `<button class="btn small" onclick="adjustForm(${i.id})">تسوية مخزون</button>`}
            ${delBtn('deleteItem', i.id)}
          </td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد أصناف مطابقة.</p>'}
    </div>`;
  const runSearch = () => { itemsFilter = { q: $('#itemQ').value.trim(), department: $('#itemDept').value }; render(); };
  $('#itemSearchBtn').addEventListener('click', runSearch);
  $('#itemQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
}
async function itemForm(id) {
  await refreshCache();
  const it = id ? CACHE.items.find((x) => x.id === id) : null;
  formModal(it ? `تعديل صنف — ${it.name}` : 'صنف جديد', `
    <label>اسم الصنف *<input name="name" required value="${it ? esc(it.name) : ''}"></label>
    <div class="grid2">
      <label>القسم *<select name="department" id="itDept">
        <option value="home" ${it && it.department === 'home' ? 'selected' : ''}>مفروشات وأدوات مطبخ</option>
        <option value="appliances" ${it && it.department === 'appliances' ? 'selected' : ''}>أجهزة</option>
      </select></label>
      <label>التصنيف<input name="category" value="${it ? esc(it.category || '') : ''}" placeholder="مثال: تبريد / أدوات مطبخ"></label>
    </div>
    <div class="grid2">
      <label>الباركود<input name="barcode" value="${it ? esc(it.barcode || '') : ''}"></label>
      <label>وحدة البيع<select name="unit">
        ${['قطعة', 'طقم', 'دستة', 'كرتونة', 'جهاز'].map((u) => `<option ${it && it.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
      </select></label>
    </div>
    <div class="grid2">
      <label>سعر التكلفة (${CUR()})<input name="cost_price" type="number" step="0.01" min="0" value="${it ? it.cost_price : ''}"></label>
      <label>سعر البيع (${CUR()})<input name="sale_price" type="number" step="0.01" min="0" value="${it ? it.sale_price : ''}"></label>
    </div>
    <div class="grid2">
      <label>حد تنبيه انخفاض المخزون<input name="min_stock" type="number" step="0.001" min="0" value="${it ? it.min_stock : 0}"></label>
      ${warrantyOn() ? `<label>الضمان الافتراضي (شهر)<input name="warranty_months" type="number" step="1" min="0" value="${it ? it.warranty_months : 0}"></label>` : `<input type="hidden" name="warranty_months" value="${it ? it.warranty_months : 0}">`}
    </div>
    <label id="itSerialWrap"><span style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="track_serial" value="1" style="width:auto" ${it && it.track_serial ? 'checked' : ''}> تتبّع بالسيريال (إلزامي لقسم الأجهزة)</span></label>
    <label><span style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" value="1" style="width:auto" ${!it || it.active !== false ? 'checked' : ''}> الصنف نشط</span></label>`,
    async (data) => {
      const payload = {
        name: data.name, department: data.department, category: data.category, barcode: data.barcode,
        unit: data.unit, cost_price: num(data.cost_price), sale_price: num(data.sale_price),
        min_stock: num(data.min_stock), warranty_months: Math.floor(num(data.warranty_months)),
        track_serial: data.department === 'appliances' ? true : !!data.track_serial,
        active: !!data.active,
      };
      if (it) await api(`/api/items/${it.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/items', { method: 'POST', body: JSON.stringify(payload) });
      render();
    }, it ? 'حفظ التعديل' : 'إضافة الصنف');
  const deptSel = document.getElementById('itDept');
  const syncSerial = () => {
    const cb = document.querySelector('#modalForm input[name="track_serial"]');
    if (deptSel.value === 'appliances') { cb.checked = true; cb.disabled = true; }
    else cb.disabled = false;
  };
  deptSel.addEventListener('change', syncSerial);
  syncSerial();
}
async function deleteItem(id) {
  const it = CACHE.items.find((x) => x.id === id);
  confirmAction('حذف صنف', `حذف «${esc(it ? it.name : '')}» نهائياً؟`, 'حذف', async () => {
    await api(`/api/items/${id}`, { method: 'DELETE' });
    render();
  });
}
async function showSerials(itemId) {
  const item = CACHE.items.find((x) => x.id === itemId);
  const serials = await api(`/api/items/${itemId}/serials`);
  const statusLabel = { in_stock: ['في المخزون', 'green'], sold: ['مباع', ''], returned: ['مرتجع', 'amber'] };
  openModal(`سيريالات — ${item ? esc(item.name) : ''}`, `
    ${serials.length ? `<div class="table-wrap"><table><tr><th>السيريال</th><th>الحالة</th><th>العميل</th>${warrantyOn() ? '<th>نهاية الضمان</th>' : ''}</tr>
      ${serials.map((s) => { const cust = CACHE.parties.find((p) => p.id === s.customer_id); const st = statusLabel[s.status] || [s.status, ''];
        return `<tr><td class="serial-nums">${esc(s.serial_no)}</td><td><span class="badge ${st[1]}">${st[0]}</span></td>
        <td>${cust ? esc(cust.name) : '—'}</td>${warrantyOn() ? `<td>${fmtDate(s.warranty_end)}</td>` : ''}</tr>`; }).join('')}</table></div>`
    : '<p class="muted">لا توجد سيريالات مسجلة لهذا الصنف بعد — تُسجَّل من فواتير الشراء.</p>'}
    <div class="form-actions"><button class="btn" onclick="closeModal()">إغلاق</button></div>`, true);
}
function adjustForm(itemId) {
  const it = CACHE.items.find((x) => x.id === itemId);
  formModal(`تسوية مخزون — ${it ? esc(it.name) : ''}`, `
    <p class="muted">المتاح حالياً: <strong>${it ? it.on_hand : ''}</strong> ${it ? esc(it.unit) : ''}. أدخل كمية التسوية: موجبة للإضافة (جرد زائد) أو سالبة للخصم (عجز/تلف).</p>
    <label>كمية التسوية *<input name="qty" type="number" step="0.001" required></label>
    <label>التاريخ<input name="date" type="date" value="${todayStr()}"></label>
    <label>ملاحظات<input name="notes" value="تسوية جرد"></label>`,
    async (data) => {
      await api(`/api/items/${itemId}/adjust`, { method: 'POST', body: JSON.stringify({ qty: num(data.qty), date: data.date, notes: data.notes }) });
      render();
    }, 'حفظ التسوية');
}

// ---------------- العملاء والموردون ----------------
let partiesFilter = { type: '', q: '' };
async function viewParties() {
  await refreshCache();
  const params = new URLSearchParams();
  if (partiesFilter.type) params.set('type', partiesFilter.type);
  if (partiesFilter.q) params.set('q', partiesFilter.q);
  const parties = await api(`/api/parties?${params}`);
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>العملاء والموردون</h3><button class="btn primary" onclick="partyForm()">+ طرف جديد</button></div>
      <div class="chips">
        ${[['', 'الكل'], ['customer', 'العملاء'], ['supplier', 'الموردون']].map(([v, l]) =>
          `<button class="chip ${partiesFilter.type === v ? 'active' : ''}" onclick="setPartiesType('${v}')">${l}</button>`).join('')}
      </div>
      <div class="search-row">
        <label>بحث بالاسم أو الجوال<input id="partyQ" value="${esc(partiesFilter.q)}" placeholder="اكتب للبحث…"></label>
        <button class="btn" id="partySearchBtn">بحث</button>
      </div>
      ${parties.length ? `<div class="table-wrap"><table><tr><th>الاسم</th><th>النوع</th><th>الجوال</th><th>الرصيد المستحق</th><th></th></tr>
        ${parties.map((p) => `<tr${p.active === false ? ' style="opacity:.55"' : ''}><td><strong>${esc(p.name)}</strong></td>
          <td><span class="badge ${p.type === 'customer' ? '' : 'amber'}">${p.type === 'customer' ? 'عميل' : 'مورد'}</span></td>
          <td>${esc(p.phone || '')}</td>
          <td class="money ${p.balance > 0 ? 'debit-red' : ''}">${money(p.balance)}</td>
          <td style="white-space:nowrap">
            <button class="btn small" onclick="showStatement(${p.id})">كشف حساب</button>
            <button class="btn small" onclick="partyPaymentForm(${p.id})">${p.type === 'customer' ? 'سند قبض' : 'سند صرف'}</button>
            <button class="btn small" onclick="partyForm(${p.id})">تعديل</button>
            ${delBtn('deleteParty', p.id)}
          </td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد أطراف مطابقة.</p>'}
      <p class="kbd-hint">الرصيد الموجب للعميل = مبلغ عليه للمحل · وللمورد = مبلغ له على المحل.</p>
    </div>`;
  $('#partySearchBtn').addEventListener('click', () => { partiesFilter.q = $('#partyQ').value.trim(); render(); });
}
function setPartiesType(v) { partiesFilter.type = v; render(); }
async function partyForm(id) {
  await refreshCache();
  const p = id ? CACHE.parties.find((x) => x.id === id) : null;
  formModal(p ? `تعديل — ${p.name}` : 'طرف جديد', `
    <div class="grid2">
      <label>النوع *<select name="type">
        <option value="customer" ${p && p.type === 'customer' ? 'selected' : ''}>عميل</option>
        <option value="supplier" ${p && p.type === 'supplier' ? 'selected' : ''}>مورد</option>
      </select></label>
      <label>الاسم *<input name="name" required value="${p ? esc(p.name) : ''}"></label>
    </div>
    <div class="grid2">
      <label>الجوال<input name="phone" value="${p ? esc(p.phone || '') : ''}"></label>
      <label>رصيد افتتاحي (${CUR()})<input name="opening_balance" type="number" step="0.01" value="${p ? p.opening_balance : 0}"></label>
    </div>
    <label>العنوان<input name="address" value="${p ? esc(p.address || '') : ''}"></label>
    <label>ملاحظات<input name="notes" value="${p ? esc(p.notes || '') : ''}"></label>
    <label><span style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="active" value="1" style="width:auto" ${!p || p.active !== false ? 'checked' : ''}> نشط</span></label>`,
    async (data) => {
      const payload = {
        type: data.type, name: data.name, phone: data.phone, address: data.address,
        opening_balance: num(data.opening_balance), notes: data.notes, active: !!data.active,
      };
      if (p) await api(`/api/parties/${p.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/api/parties', { method: 'POST', body: JSON.stringify(payload) });
      render();
    });
}
async function deleteParty(id) {
  const p = CACHE.parties.find((x) => x.id === id);
  confirmAction('حذف طرف', `حذف «${esc(p ? p.name : '')}» نهائياً؟`, 'حذف', async () => {
    await api(`/api/parties/${id}`, { method: 'DELETE' });
    render();
  });
}
async function showStatement(partyId) {
  const st = await api(`/api/parties/${partyId}/statement`);
  const p = st.party;
  openModal(`كشف حساب — ${esc(p.name)}`, `
    <p class="muted">${p.type === 'customer' ? 'عميل' : 'مورد'} · ${esc(p.phone || '')} · الرصيد الحالي: <strong>${money(st.closing_balance)}</strong></p>
    <div class="table-wrap"><table><tr><th>التاريخ</th><th>البيان</th><th>المبلغ</th><th>الرصيد</th></tr>
      ${st.entries.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.label)}</td>
        <td class="money">${e.amount ? money(e.amount) : '—'}</td><td class="money">${money(e.balance)}</td></tr>`).join('')}
      <tr class="total-row"><td colspan="3">الرصيد الختامي</td><td class="money">${money(st.closing_balance)}</td></tr>
    </table></div>
    <div class="form-actions"><button class="btn" onclick="printStatement(${partyId})">🖨 طباعة الكشف</button>
    <button class="btn" onclick="closeModal()">إغلاق</button></div>`, true);
}
async function printStatement(partyId) {
  const st = await api(`/api/parties/${partyId}/statement`);
  const p = st.party;
  $('#printArea').innerHTML = `<div class="report-doc">
    <div class="co-head"><div class="co-name">${esc(SETTINGS.company_name || 'منزلي')}</div><div>${esc(SETTINGS.company_phone || '')}</div></div>
    <h2>كشف حساب ${p.type === 'customer' ? 'عميل' : 'مورد'}</h2>
    <div class="r-sub">${esc(p.name)} · ${esc(p.phone || '')} · حتى ${todayStr()}</div>
    <table><tr><th>التاريخ</th><th>البيان</th><th>المبلغ</th><th>الرصيد</th></tr>
    ${st.entries.map((e) => `<tr><td>${fmtDate(e.date)}</td><td>${esc(e.label)}</td><td>${e.amount ? money(e.amount) : '—'}</td><td>${money(e.balance)}</td></tr>`).join('')}
    <tr><td colspan="3"><strong>الرصيد الختامي</strong></td><td><strong>${money(st.closing_balance)}</strong></td></tr></table>
  </div>`;
  window.print();
}
function partyPaymentForm(partyId) {
  const p = CACHE.parties.find((x) => x.id === partyId);
  const isCust = p && p.type === 'customer';
  formModal(`${isCust ? 'سند قبض من عميل' : 'سند صرف لمورد'} — ${p ? esc(p.name) : ''}`, `
    <p class="muted">الرصيد الحالي: <strong>${p ? money(p.balance) : ''}</strong> — السند على الحساب (غير مرتبط بفاتورة معينة).</p>
    <div class="grid2">
      <label>المبلغ (${CUR()}) *<input name="amount" type="number" step="0.01" min="0.01" required></label>
      <label>التاريخ<input name="date" type="date" value="${todayStr()}"></label>
    </div>
    <label>طريقة ${isCust ? 'القبض' : 'الصرف'}<select name="method">${(SETTINGS.payment_methods || []).map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
    <label>ملاحظات<input name="notes"></label>`,
    async (data) => {
      const row = await api('/api/party-payments', {
        method: 'POST',
        body: JSON.stringify({ party_id: partyId, amount: num(data.amount), date: data.date, method: data.method, notes: data.notes }),
      });
      render();
      setTimeout(() => printPartyPayment(row.id), 100);
    }, 'حفظ وطباعة السند');
}
async function printPartyPayment(id) {
  const d = await api(`/api/party-payments/${id}/receipt`);
  const pay = d.payment, p = d.party || {};
  const isCust = p.type === 'customer';
  $('#printArea').innerHTML = `<div class="invoice-doc">
    <div class="inv-head"><div><div class="co-name">${esc(d.settings.company_name || 'منزلي')}</div><div>${esc(d.settings.company_phone || '')}</div></div>
    ${d.settings.company_logo ? `<img class="inv-logo" src="${d.settings.company_logo}">` : ''}</div>
    <h2>${isCust ? 'سند قبض' : 'سند صرف'} رقم ${pay.receipt_no || pay.id}</h2>
    <table class="meta">
      <tr><td class="k">${isCust ? 'استلمنا من' : 'صُرف إلى'}</td><td><strong>${esc(p.name || '')}</strong></td></tr>
      <tr><td class="k">المبلغ</td><td><strong>${money(pay.amount)}</strong></td></tr>
      <tr><td class="k">التاريخ</td><td>${fmtDate(pay.date)}</td></tr>
      <tr><td class="k">الطريقة</td><td>${esc(pay.method || '')}</td></tr>
      ${pay.notes ? `<tr><td class="k">ملاحظات</td><td>${esc(pay.notes)}</td></tr>` : ''}
      <tr><td class="k">الرصيد بعد السند</td><td>${money(d.party_balance)}</td></tr>
    </table>
    <div class="amount-words">${tafqeet(pay.amount)}</div>
    <div class="inv-foot"><div class="inv-sign">المستلم<div class="line">التوقيع</div></div><div class="inv-sign">${isCust ? 'الدافع' : 'المستلم'}<div class="line">التوقيع</div></div></div>
  </div>`;
  window.print();
}

// ---------------- نقطة البيع ----------------
let posState = null;
function posTotals() {
  const subtotal = round2(posState.lines.reduce((s, l) => s + round2(num(l.qty) * num(l.price)), 0));
  const discount = Math.min(round2(num(posState.discount)), subtotal);
  const vat = round2((subtotal - discount) * (num(posState.vat_rate) / 100));
  const total = round2(subtotal - discount + vat);
  return { subtotal, discount, vat, total, remaining: round2(total - num(posState.paid_now)) };
}
async function viewPos() {
  await refreshCache();
  if (!posState) {
    posState = {
      customer_id: '', date: todayStr(), method: (SETTINGS.payment_methods || ['نقداً'])[0],
      discount: 0, vat_rate: num(SETTINGS.default_vat_rate) || 0, paid_now: 0,
      use_plan: false, months: 6, first_due: '', lines: [],
    };
  }
  const customers = CACHE.parties.filter((p) => p.type === 'customer' && p.active !== false);
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>فاتورة بيع جديدة</h3><button class="btn" onclick="resetPos()">فاتورة فارغة</button></div>
      <div class="grid2">
        <label>العميل<select id="posCustomer">
          <option value="">عميل نقدي (بدون حساب)</option>
          ${customers.map((c) => `<option value="${c.id}" ${String(posState.customer_id) === String(c.id) ? 'selected' : ''}>${esc(c.name)}${c.balance ? ` — عليه ${money(c.balance)}` : ''}</option>`).join('')}
        </select></label>
        <label>التاريخ<input id="posDate" type="date" value="${posState.date}"></label>
      </div>
      <div class="table-wrap"><table class="lines-table pos-lines"><tr><th style="min-width:210px">الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th><th>السيريال${warrantyOn() ? ' / الضمان' : ''}</th><th></th></tr>
        <tbody id="posLines"></tbody></table></div>
      <button class="btn" id="posAddLine" style="margin-top:8px">+ إضافة سطر</button>
      <div class="grid2" style="margin-top:14px">
        <label>خصم (${CUR()})<input id="posDiscount" type="number" step="0.01" min="0" value="${posState.discount}"></label>
        <label>ضريبة القيمة المضافة %<input id="posVat" type="number" step="0.01" min="0" value="${posState.vat_rate}"></label>
      </div>
      <div class="grid2">
        <label>المدفوع الآن (${CUR()})<input id="posPaid" type="number" step="0.01" min="0" value="${posState.paid_now}"></label>
        <label>طريقة الدفع<select id="posMethod">${(SETTINGS.payment_methods || []).map((m) => `<option ${posState.method === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      </div>
      <label><span style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="posUsePlan" style="width:auto" ${posState.use_plan ? 'checked' : ''}> بيع بالتقسيط (يحتاج عميلاً مسجلاً وباقياً أكبر من صفر)</span></label>
      <div class="grid2" id="posPlanFields" style="display:${posState.use_plan ? 'grid' : 'none'}">
        <label>عدد الأقساط (شهر)<input id="posMonths" type="number" step="1" min="1" value="${posState.months}"></label>
        <label>تاريخ أول قسط<input id="posFirstDue" type="date" value="${posState.first_due}"></label>
      </div>
      <div class="lines-total" id="posTotals"></div>
      <div class="form-actions"><button class="btn primary big" id="posSubmit">حفظ الفاتورة وطباعتها</button></div>
      <p class="error" id="posError"></p>
    </div>`;
  const syncHead = () => {
    posState.customer_id = $('#posCustomer').value;
    posState.date = $('#posDate').value;
    posState.discount = $('#posDiscount').value;
    posState.vat_rate = $('#posVat').value;
    posState.paid_now = $('#posPaid').value;
    posState.method = $('#posMethod').value;
    posState.use_plan = $('#posUsePlan').checked;
    posState.months = $('#posMonths').value;
    posState.first_due = $('#posFirstDue').value;
    renderPosTotals();
  };
  ['posCustomer', 'posDate', 'posDiscount', 'posVat', 'posPaid', 'posMethod', 'posMonths', 'posFirstDue'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', syncHead);
    if (el && el.type === 'number') el.addEventListener('input', syncHead);
  });
  $('#posUsePlan').addEventListener('change', () => { $('#posPlanFields').style.display = $('#posUsePlan').checked ? 'grid' : 'none'; syncHead(); });
  $('#posAddLine').addEventListener('click', () => { posState.lines.push({ item_id: '', qty: 1, price: 0, serial_ids: [], warranty_months: '' }); renderPosLines(); });
  $('#posSubmit').addEventListener('click', submitPos);
  if (!posState.lines.length) posState.lines.push({ item_id: '', qty: 1, price: 0, serial_ids: [], warranty_months: '' });
  renderPosLines();
}
function resetPos() { posState = null; render(); }
function posItemOptions(selId) {
  return `<option value="">— اختر الصنف —</option>` + CACHE.items.filter((i) => i.active !== false)
    .map((i) => `<option value="${i.id}" ${String(selId) === String(i.id) ? 'selected' : ''}>${esc(i.name)} · متاح ${i.on_hand} · ${money(i.sale_price)}</option>`).join('');
}
function renderPosLines() {
  const tb = $('#posLines');
  if (!tb) return;
  tb.innerHTML = posState.lines.map((l, idx) => {
    const item = CACHE.items.find((i) => i.id === Number(l.item_id));
    const serialCell = item && item.track_serial
      ? `<button type="button" class="btn small" onclick="pickSerials(${idx})">اختيار السيريالات (${l.serial_ids.length})</button>
         ${warrantyOn() ? `<label style="margin:6px 0 0">ضمان (شهر)<input type="number" min="0" step="1" value="${l.warranty_months === '' ? (item.warranty_months || 0) : l.warranty_months}" onchange="posLineSet(${idx},'warranty_months',this.value)"></label>` : ''}`
      : '<span class="muted">—</span>';
    return `<tr>
      <td><select onchange="posLineItem(${idx},this.value)">${posItemOptions(l.item_id)}</select>
        ${item ? `<div class="muted" style="font-size:12px">${DEPT_LABELS[item.department] || ''} · متاح ${item.on_hand} ${esc(item.unit)}</div>` : ''}</td>
      <td><input type="number" step="0.001" min="0" value="${l.qty}" ${item && item.track_serial ? 'disabled' : ''} onchange="posLineSet(${idx},'qty',this.value)"></td>
      <td><input type="number" step="0.01" min="0" value="${l.price}" onchange="posLineSet(${idx},'price',this.value)"></td>
      <td class="money">${money(num(l.qty) * num(l.price))}</td>
      <td>${serialCell}</td>
      <td><button type="button" class="btn small danger" onclick="posLineRemove(${idx})">✕</button></td>
    </tr>`;
  }).join('');
  renderPosTotals();
}
function renderPosTotals() {
  const el = $('#posTotals');
  if (!el || !posState) return;
  const t = posTotals();
  el.innerHTML = `<span>الإجمالي الفرعي: <strong>${money(t.subtotal)}</strong></span>
    <span>الضريبة: <strong>${money(t.vat)}</strong></span>
    <span>الإجمالي: <strong>${money(t.total)}</strong></span>
    <span class="${t.remaining > 0 ? 'bad' : 'ok'}">المتبقي: ${money(t.remaining)}</span>`;
}
async function posLineItem(idx, val) {
  const l = posState.lines[idx];
  l.item_id = val;
  const item = CACHE.items.find((i) => i.id === Number(val));
  if (item) { l.price = item.sale_price; l.serial_ids = []; l.qty = item.track_serial ? 0 : 1; l.warranty_months = item.warranty_months || 0; }
  renderPosLines();
  // اختيار تلقائي للسيريال (بطلب عبده): لو الجهاز المتاح منه قطعة واحدة
  // فقط، اختر سيريالها تلقائياً بدل خطوة الاختيار اليدوي
  if (item && item.track_serial && Number(item.on_hand) === 1) {
    try {
      const serials = await api(`/api/items/${item.id}/serials`);
      const avail = serials.filter((s) => s.status === 'in_stock');
      if (avail.length === 1 && posState.lines[idx] && Number(posState.lines[idx].item_id) === item.id) {
        posState.lines[idx].serial_ids = [avail[0].id];
        posState.lines[idx].qty = 1;
        renderPosLines();
      }
    } catch (_) { /* عند أي فشل يبقى الاختيار اليدوي كما هو */ }
  }
}
function posLineSet(idx, field, val) { posState.lines[idx][field] = val; renderPosLines(); }
function posLineRemove(idx) { posState.lines.splice(idx, 1); renderPosLines(); }
async function pickSerials(idx) {
  const l = posState.lines[idx];
  const item = CACHE.items.find((i) => i.id === Number(l.item_id));
  if (!item) return;
  const serials = await api(`/api/items/${item.id}/serials`);
  const avail = serials.filter((s) => s.status === 'in_stock');
  openModal(`اختيار سيريالات — ${esc(item.name)}`, `
    ${avail.length ? `<div class="serial-picker">${avail.map((s) => `
      <label><input type="checkbox" class="serPick" value="${s.id}" ${l.serial_ids.includes(s.id) ? 'checked' : ''}> <span class="serial-nums">${esc(s.serial_no)}</span></label>`).join('')}</div>`
    : '<p class="muted">لا توجد سيريالات متاحة في المخزون لهذا الجهاز.</p>'}
    <div class="form-actions"><button class="btn primary" id="serOk">تأكيد الاختيار</button><button class="btn" onclick="closeModal()">إلغاء</button></div>`);
  $('#serOk').addEventListener('click', () => {
    l.serial_ids = [...document.querySelectorAll('.serPick:checked')].map((c) => Number(c.value));
    l.qty = l.serial_ids.length;
    closeModal();
    renderPosLines();
  });
}
async function submitPos() {
  const errEl = $('#posError');
  errEl.textContent = '';
  const lines = posState.lines.filter((l) => l.item_id);
  if (!lines.length) { errEl.textContent = 'أضف صنفاً واحداً على الأقل'; return; }
  const payload = {
    customer_id: posState.customer_id ? Number(posState.customer_id) : null,
    date: posState.date, method: posState.method,
    discount: num(posState.discount), vat_rate: num(posState.vat_rate), paid_now: num(posState.paid_now),
    lines: lines.map((l) => {
      const item = CACHE.items.find((i) => i.id === Number(l.item_id));
      return {
        item_id: Number(l.item_id), qty: num(l.qty), price: num(l.price),
        serial_ids: item && item.track_serial ? l.serial_ids : undefined,
        warranty_months: item && item.track_serial ? num(l.warranty_months) : undefined,
      };
    }),
  };
  if (posState.use_plan) payload.installments = { months: Math.floor(num(posState.months)), first_due: posState.first_due };
  const btn = $('#posSubmit');
  btn.disabled = true;
  try {
    const inv = await api('/api/sales', { method: 'POST', body: JSON.stringify(payload) });
    posState = null;
    go('sales');
    setTimeout(() => printSaleInvoice(inv.id), 150);
  } catch (e) {
    errEl.textContent = e.message;
    btn.disabled = false;
  }
}

// ---------------- المبيعات ----------------
async function viewSales() {
  await refreshCache();
  const sales = await api('/api/sales');
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>فواتير المبيعات</h3><button class="btn primary" onclick="go('pos')">+ فاتورة بيع جديدة</button></div>
      ${sales.length ? `<div class="table-wrap"><table><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th></th></tr>
        ${sales.map((s) => `<tr><td><strong>${esc(s.invoice_no)}</strong>${s.has_plan ? ' <span class="badge amber">تقسيط</span>' : ''}</td>
          <td>${fmtDate(s.date)}</td><td>${esc(s.customer_name)}</td>
          <td class="money">${money(s.total)}</td><td class="money">${money(s.paid_now)}</td>
          <td class="money ${num(s.total) - num(s.paid_now) > 0 ? 'debit-red' : ''}">${money(num(s.total) - num(s.paid_now))}</td>
          <td style="white-space:nowrap">
            <button class="btn small" onclick="showSale(${s.id})">عرض</button>
            <button class="btn small" onclick="printSaleInvoice(${s.id})">🖨 طباعة</button>
            <button class="btn small" onclick="returnForm(${s.id})">مرتجع</button>
          </td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد فواتير بيع بعد.</p>'}
    </div>
    <div class="section">
      <div class="section-head"><h3>مرتجعات المبيعات</h3></div>
      <div id="returnsList"><p class="muted">جارٍ التحميل…</p></div>
    </div>`;
  const returns = await api('/api/returns');
  $('#returnsList').innerHTML = returns.length
    ? `<div class="table-wrap"><table><tr><th>رقم المرتجع</th><th>التاريخ</th><th>الفاتورة</th><th>العميل</th><th>القيمة</th><th>التسوية</th></tr>
      ${returns.map((r) => `<tr><td><strong>${esc(r.return_no)}</strong></td><td>${fmtDate(r.date)}</td><td>${esc(r.sale_invoice_no)}</td>
        <td>${esc(r.customer_name)}</td><td class="money">${money(r.total)}</td>
        <td>${r.settlement === 'cash' ? `استرداد نقدي (${esc(r.refund_method || 'نقداً')})` : 'على الحساب'}</td></tr>`).join('')}</table></div>`
    : '<p class="muted">لا توجد مرتجعات.</p>';
}
async function showSale(id) {
  const inv = await api(`/api/sales/${id}`);
  const planHtml = inv.plan ? `<div class="warranty-note">
      <strong>خطة تقسيط:</strong> الإجمالي ${money(inv.plan.total)} · دفعة أولى ${money(inv.plan.down_payment)} ·
      المسدد ${money(inv.plan.summary.paid)} · المتبقي <strong>${money(inv.plan.summary.remaining)}</strong> ·
      المتأخر <span class="debit-red">${money(inv.plan.summary.arrears)}</span>
      <button class="btn small primary" style="margin-inline-start:8px" onclick="closeModal();go('plans');setTimeout(()=>planDetail(${inv.plan.id}),150)">فتح الخطة</button>
    </div>` : '';
  const returnsHtml = inv.returns && inv.returns.length ? `<h4 style="margin:14px 0 6px">مرتجعات على هذه الفاتورة</h4>
    ${inv.returns.map((r) => `<div class="muted" style="font-size:13.5px">${esc(r.return_no)} · ${fmtDate(r.date)} · ${money(r.total)} · ${r.settlement === 'cash' ? 'استرداد نقدي' : 'على الحساب'}</div>`).join('')}` : '';
  openModal(`فاتورة بيع ${esc(inv.invoice_no)}`, `
    <table class="meta" style="width:100%;font-size:14px">
      <tr><td class="muted" style="width:110px">العميل</td><td><strong>${esc(inv.customer_name)}</strong></td>
      <td class="muted" style="width:80px">التاريخ</td><td>${fmtDate(inv.date)}</td></tr>
      <tr><td class="muted">طريقة الدفع</td><td>${esc(inv.method || '')}</td>
      <td class="muted">المتبقي</td><td class="money ${inv.owed > 0 ? 'debit-red' : ''}">${money(inv.owed)}</td></tr>
    </table>
    <div class="table-wrap"><table><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr>
      ${inv.lines.map((l) => `<tr><td>${esc(l.item_name)}${l.serials && l.serials.length ? `<div class="serial-nums">${l.serials.map((s) => esc(s.serial_no)).join(' · ')}</div>
        ${warrantyOn() ? l.serials.map((s) => s.warranty_end ? `<div class="muted" style="font-size:12px">ضمان ${esc(s.serial_no)} حتى ${fmtDate(s.warranty_end)}</div>` : '').join('') : ''}` : ''}</td>
        <td>${l.qty}</td><td class="money">${money(l.price)}</td><td class="money">${money(l.line_total)}</td></tr>`).join('')}
    </table></div>
    <div class="lines-total">
      <span>الفرعي: <strong>${money(inv.subtotal)}</strong></span>
      ${num(inv.discount) ? `<span>خصم: <strong>${money(inv.discount)}</strong></span>` : ''}
      <span>الضريبة (${inv.vat_rate}%): <strong>${money(inv.vat_total)}</strong></span>
      <span>الإجمالي: <strong>${money(inv.total)}</strong></span>
      <span>المدفوع: <strong>${money(inv.paid_total)}</strong></span>
    </div>
    ${planHtml}${returnsHtml}
    <div class="form-actions">
      <button class="btn primary" onclick="printSaleInvoice(${inv.id})">🖨 طباعة الفاتورة</button>
      <button class="btn" onclick="closeModal();returnForm(${inv.id})">إنشاء مرتجع</button>
      <button class="btn" onclick="closeModal()">إغلاق</button>
    </div>`, true);
}
async function printSaleInvoice(id) {
  const d = await api(`/api/sales/${id}/print`);
  const inv = d.invoice, s = d.settings;
  const warrantyLines = [];
  for (const l of inv.lines) {
    for (const ser of l.serials || []) {
      if (warrantyOn() && ser.warranty_end) warrantyLines.push(`الجهاز ${esc(l.item_name)} — سيريال <span class="serial-nums">${esc(ser.serial_no)}</span> — الضمان حتى ${fmtDate(ser.warranty_end)}`);
    }
  }
  $('#printArea').innerHTML = `<div class="invoice-doc">
    <div class="inv-head"><div><div class="co-name">${esc(s.company_name || 'منزلي')}</div>
      <div>${esc(s.company_address || '')}</div><div>${esc(s.company_phone || '')}</div></div>
      ${s.company_logo ? `<img class="inv-logo" src="${s.company_logo}">` : ''}</div>
    <h2>فاتورة مبيعات</h2>
    <table class="meta">
      <tr><td class="k">رقم الفاتورة</td><td><strong>${esc(inv.invoice_no)}</strong></td><td class="k">التاريخ</td><td>${fmtDate(inv.date)}</td></tr>
      <tr><td class="k">العميل</td><td>${esc(inv.customer_name)}</td><td class="k">طريقة الدفع</td><td>${esc(inv.method || '')}</td></tr>
    </table>
    <table class="lines"><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr>
      ${inv.lines.map((l) => `<tr><td>${esc(l.item_name)}${l.serials && l.serials.length ? `<div class="serial-nums">${l.serials.map((x) => esc(x.serial_no)).join(' · ')}</div>` : ''}</td>
        <td>${l.qty} ${esc(l.unit || '')}</td><td>${money(l.price)}</td><td>${money(l.line_total)}</td></tr>`).join('')}
    </table>
    <table class="totals">
      <tr><td>الإجمالي الفرعي</td><td>${money(inv.subtotal)}</td></tr>
      ${num(inv.discount) ? `<tr><td>الخصم</td><td>− ${money(inv.discount)}</td></tr>` : ''}
      <tr><td>ضريبة القيمة المضافة (${inv.vat_rate}%)</td><td>${money(inv.vat_total)}</td></tr>
      <tr class="grand"><td>الإجمالي المستحق</td><td>${money(inv.total)}</td></tr>
      <tr><td>المدفوع</td><td>${money(inv.paid_total)}</td></tr>
      <tr><td>المتبقي</td><td>${money(inv.owed)}</td></tr>
    </table>
    <div class="amount-words">${tafqeet(inv.total)}</div>
    ${inv.plan ? `<div class="warranty-note">بيع بالتقسيط: ${inv.plan.months} قسطاً شهرياً — أول قسط ${fmtDate(inv.plan.first_due)} — المتبقي على الخطة ${money(inv.plan.summary.remaining)}.</div>` : ''}
    ${warrantyLines.length ? `<div class="warranty-note"><strong>بيانات الضمان:</strong><br>${warrantyLines.join('<br>')}</div>` : ''}
    <div class="inv-foot"><div class="inv-sign">البائع<div class="line">التوقيع</div></div><div class="inv-sign">المستلم<div class="line">التوقيع</div></div></div>
  </div>`;
  window.print();
}
async function returnForm(saleId) {
  const inv = await api(`/api/sales/${saleId}`);
  const returnedByLine = {};
  for (const r of inv.returns || []) {
    for (const rl of r.lines || []) returnedByLine[rl.sale_line_id] = (returnedByLine[rl.sale_line_id] || 0) + num(rl.qty);
  }
  const hasPlan = !!inv.plan;
  openModal(`مرتجع على فاتورة ${esc(inv.invoice_no)}`, `
    <form id="retForm">
    <p class="muted">حدد كمية الإرجاع لكل سطر${hasPlan ? ' — الفاتورة عليها خطة تقسيط: التسوية على الحساب فقط وتُخفَّض الخطة تلقائياً' : ''}.</p>
    ${inv.lines.map((l) => {
      const returned = returnedByLine[l.id] || 0;
      const avail = round2(num(l.qty) - returned);
      const serials = (l.serials || []).filter((s) => s.status === 'sold');
      return `<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px">
        <strong>${esc(l.item_name)}</strong> <span class="muted">— مباع ${l.qty} · مرتجع ${returned} · قابل للإرجاع ${avail}</span>
        ${serials.length ? `<div class="serial-picker" style="margin-top:6px">${serials.map((s) => `<label><input type="checkbox" class="retSer" data-line="${l.id}" value="${s.id}"> <span class="serial-nums">${esc(s.serial_no)}</span></label>`).join('')}</div>`
        : `<label style="margin-top:6px">كمية الإرجاع<input type="number" class="retQty" data-line="${l.id}" step="0.001" min="0" max="${avail}" value="0"></label>`}
      </div>`;
    }).join('')}
    <div class="grid2">
      <label>تاريخ المرتجع<input name="date" type="date" value="${todayStr()}"></label>
      <label>تسوية المرتجع<select name="settlement" ${hasPlan ? 'disabled' : ''}>
        <option value="account">على الحساب (تخفيض رصيد العميل)</option>
        <option value="cash" ${hasPlan ? 'disabled' : ''}>استرداد نقدي للعميل</option>
      </select></label>
    </div>
    <label>ملاحظات<input name="notes"></label>
    <div class="form-actions"><button type="submit" class="btn primary">حفظ المرتجع</button>
    <button type="button" class="btn" onclick="closeModal()">إلغاء</button></div>
    <p class="error" id="retError"></p></form>`, true);
  $('#retForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const lines = [];
    document.querySelectorAll('.retQty').forEach((inp) => {
      const qty = num(inp.value);
      if (qty > 0) lines.push({ sale_line_id: Number(inp.dataset.line), qty });
    });
    const serByLine = {};
    document.querySelectorAll('.retSer:checked').forEach((c) => {
      (serByLine[c.dataset.line] = serByLine[c.dataset.line] || []).push(Number(c.value));
    });
    for (const [lineId, ids] of Object.entries(serByLine)) {
      lines.push({ sale_line_id: Number(lineId), qty: ids.length, serial_ids: ids });
    }
    if (!lines.length) { $('#retError').textContent = 'حدد كمية أو سيريالات للإرجاع'; return; }
    const fd = Object.fromEntries(new FormData(e.target).entries());
    try {
      await api('/api/returns', {
        method: 'POST',
        body: JSON.stringify({ sale_invoice_id: saleId, date: fd.date, settlement: hasPlan ? 'account' : fd.settlement, notes: fd.notes, lines }),
      });
      closeModal();
      render();
    } catch (err) { $('#retError').textContent = err.message; }
  });
}

// ---------------- المشتريات ----------------
async function viewPurchases() {
  await refreshCache();
  const purchases = await api('/api/purchases');
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>فواتير المشتريات</h3><button class="btn primary" onclick="purchaseForm()">+ فاتورة شراء جديدة</button></div>
      ${purchases.length ? `<div class="table-wrap"><table><tr><th>الرقم</th><th>التاريخ</th><th>المورد</th><th>الإجمالي</th><th>المسدد</th><th>المتبقي</th><th>الحالة</th><th></th></tr>
        ${purchases.map((p) => `<tr><td><strong>${esc(p.invoice_no)}</strong></td><td>${fmtDate(p.date)}</td><td>${esc(p.supplier_name)}</td>
          <td class="money">${money(p.total)}</td><td class="money">${money(p.paid)}</td>
          <td class="money ${num(p.total) - num(p.paid) > 0 && p.status === 'posted' ? 'debit-red' : ''}">${money(num(p.total) - num(p.paid))}</td>
          <td>${p.status === 'void' ? '<span class="badge red">ملغاة</span>' : '<span class="badge green">مرحّلة</span>'}</td>
          <td style="white-space:nowrap"><button class="btn small" onclick="showPurchase(${p.id})">عرض</button>
          ${p.status === 'posted' ? `<button class="btn small danger" onclick="voidPurchase(${p.id},'${esc(p.invoice_no)}')">إلغاء الفاتورة</button>` : ''}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد فواتير شراء بعد.</p>'}
    </div>`;
}
let purLines = [];
function purchaseForm() {
  purLines = [{ item_id: '', qty: 1, cost: 0, serial_nos: '' }];
  const suppliers = CACHE.parties.filter((p) => p.type === 'supplier' && p.active !== false);
  openModal('فاتورة شراء جديدة', `
    <form id="purForm">
    <div class="grid2">
      <label>المورد *<select name="supplier_id" required>
        <option value="">— اختر المورد —</option>
        ${suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
      </select></label>
      <label>التاريخ<input name="date" type="date" value="${todayStr()}"></label>
    </div>
    <div id="purLinesWrap"></div>
    <button type="button" class="btn small" id="purAddLine">+ إضافة سطر</button>
    <div class="grid2" style="margin-top:12px">
      <label>خصم (${CUR()})<input name="discount" type="number" step="0.01" min="0" value="0"></label>
      <label>ضريبة القيمة المضافة %<input name="vat_rate" type="number" step="0.01" min="0" value="${esc(SETTINGS.default_vat_rate || 15)}"></label>
    </div>
    <div class="grid2">
      <label>المسدد للمورد الآن (${CUR()})<input name="paid" type="number" step="0.01" min="0" value="0"></label>
      <label>طريقة السداد<select name="method">${(SETTINGS.payment_methods || []).map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
    </div>
    <label>ملاحظات<input name="notes"></label>
    <div class="form-actions"><button type="submit" class="btn primary">حفظ فاتورة الشراء</button>
    <button type="button" class="btn" onclick="closeModal()">إلغاء</button></div>
    <p class="error" id="purError"></p></form>`, true);
  const renderLines = () => {
    $('#purLinesWrap').innerHTML = purLines.map((l, idx) => {
      const item = CACHE.items.find((i) => i.id === Number(l.item_id));
      return `<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px">
        <div class="grid2">
          <label>الصنف<select onchange="purLineItem(${idx},this.value)">${posItemOptions(l.item_id)}</select></label>
          <label>الكمية<input type="number" step="0.001" min="0" value="${l.qty}" onchange="purLineSet(${idx},'qty',this.value)"></label>
        </div>
        <div class="grid2">
          <label>تكلفة الوحدة (${CUR()})<input type="number" step="0.01" min="0" value="${l.cost}" onchange="purLineSet(${idx},'cost',this.value)"></label>
          <div class="money" style="align-self:end;padding-bottom:10px">سطر: ${money(num(l.qty) * num(l.cost))}</div>
        </div>
        ${item && item.track_serial ? `<label>سيريالات الأجهزة (سيريال في كل سطر — العدد يجب أن يساوي الكمية)<textarea class="serials-input" rows="3" onchange="purLineSet(${idx},'serial_nos',this.value)">${esc(l.serial_nos)}</textarea></label>` : ''}
        <button type="button" class="btn small danger" onclick="purLineRemove(${idx})">حذف السطر</button>
      </div>`;
    }).join('');
  };
  window.__purRender = renderLines;
  renderLines();
  $('#purAddLine').addEventListener('click', () => { purLines.push({ item_id: '', qty: 1, cost: 0, serial_nos: '' }); renderLines(); });
  $('#purForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const lines = purLines.filter((l) => l.item_id).map((l) => ({
      item_id: Number(l.item_id), qty: num(l.qty), cost: num(l.cost),
      serial_nos: String(l.serial_nos || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    }));
    try {
      await api('/api/purchases', {
        method: 'POST',
        body: JSON.stringify({
          supplier_id: Number(fd.supplier_id), date: fd.date, discount: num(fd.discount),
          vat_rate: num(fd.vat_rate), paid: num(fd.paid), method: fd.method, notes: fd.notes, lines,
        }),
      });
      closeModal();
      render();
    } catch (err) { $('#purError').textContent = err.message; }
  });
}
function purLineItem(idx, val) {
  purLines[idx].item_id = val;
  const item = CACHE.items.find((i) => i.id === Number(val));
  if (item) purLines[idx].cost = item.cost_price;
  window.__purRender();
}
function purLineSet(idx, field, val) { purLines[idx][field] = val; if (field !== 'serial_nos') window.__purRender(); }
function purLineRemove(idx) { purLines.splice(idx, 1); window.__purRender(); }
async function showPurchase(id) {
  const p = await api(`/api/purchases/${id}`);
  openModal(`فاتورة شراء ${esc(p.invoice_no)}${p.status === 'void' ? ' — ملغاة' : ''}`, `
    <table style="width:100%;font-size:14px"><tr><td class="muted" style="width:110px">المورد</td><td><strong>${esc(p.supplier_name)}</strong></td>
    <td class="muted" style="width:80px">التاريخ</td><td>${fmtDate(p.date)}</td></tr></table>
    <div class="table-wrap"><table><tr><th>الصنف</th><th>الكمية</th><th>التكلفة</th><th>الإجمالي</th></tr>
      ${p.lines.map((l) => `<tr><td>${esc(l.item_name)}${l.serial_nos && l.serial_nos.length ? `<div class="serial-nums">${l.serial_nos.map(esc).join(' · ')}</div>` : ''}</td>
      <td>${l.qty}</td><td class="money">${money(l.cost)}</td><td class="money">${money(l.line_total)}</td></tr>`).join('')}
    </table></div>
    <div class="lines-total"><span>الفرعي: <strong>${money(p.subtotal)}</strong></span>
      ${num(p.discount) ? `<span>خصم: <strong>${money(p.discount)}</strong></span>` : ''}
      <span>الضريبة (${p.vat_rate}%): <strong>${money(p.vat_total)}</strong></span>
      <span>الإجمالي: <strong>${money(p.total)}</strong></span>
      <span>المسدد: <strong>${money(p.paid)}</strong></span></div>
    <div class="form-actions"><button class="btn" onclick="closeModal()">إغلاق</button></div>`, true);
}
function voidPurchase(id, no) {
  confirmAction('إلغاء فاتورة شراء', `إلغاء فاتورة الشراء ${esc(no)}؟ ستُعكس حركات مخزونها وتُحذف سيريالاتها غير المباعة، ويُحتسب المسدد رصيداً دائناً عند المورد. لا يمكن الإلغاء إن بِيع أي جهاز منها.`, 'إلغاء الفاتورة', async () => {
    await api(`/api/purchases/${id}/void`, { method: 'POST', body: '{}' });
    render();
  });
}

// ---------------- التقسيط ----------------
async function viewPlans() {
  await refreshCache();
  const plans = await api('/api/plans');
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>خطط التقسيط</h3></div>
      ${plans.length ? `<div class="table-wrap"><table><tr><th>العميل</th><th>الفاتورة</th><th>الإجمالي</th><th>دفعة أولى</th><th>المسدد</th><th>المتبقي</th><th>المتأخر</th><th>القسط التالي</th><th>الحالة</th><th></th></tr>
        ${plans.map((p) => `<tr><td><strong>${esc(p.customer_name)}</strong><div class="muted" style="font-size:12px">${esc(p.customer_phone || '')}</div></td>
          <td>${esc(p.invoice_no)}</td><td class="money">${money(p.total)}</td><td class="money">${money(p.down_payment)}</td>
          <td class="money">${money(p.summary.paid)}</td><td class="money">${money(p.summary.remaining)}</td>
          <td class="money ${p.summary.arrears > 0 ? 'debit-red' : ''}">${money(p.summary.arrears)}</td>
          <td>${p.summary.next_due ? `${fmtDate(p.summary.next_due.due_date)} · ${money(p.summary.next_due.remaining)}` : '—'}</td>
          <td>${p.summary.status === 'done' ? '<span class="badge green">مكتملة</span>' : '<span class="badge amber">جارية</span>'}</td>
          <td style="white-space:nowrap"><button class="btn small" onclick="planDetail(${p.id})">عرض</button>
          ${p.summary.remaining > 0 ? `<button class="btn small primary" onclick="planPaymentForm(${p.id})">سداد قسط</button>` : ''}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا توجد خطط تقسيط بعد — تُنشأ تلقائياً من فاتورة بيع بخيار «بيع بالتقسيط».</p>'}
    </div>`;
}
async function planDetail(id) {
  const p = await api(`/api/plans/${id}`);
  openModal(`خطة تقسيط — ${esc(p.customer_name)} (فاتورة ${esc(p.invoice_no)})`, `
    <div class="lines-total">
      <span>الإجمالي: <strong>${money(p.total)}</strong></span>
      <span>دفعة أولى: <strong>${money(p.down_payment)}</strong></span>
      <span>المسدد: <strong>${money(p.summary.paid)}</strong></span>
      <span>المتبقي: <strong>${money(p.summary.remaining)}</strong></span>
      <span class="${p.summary.arrears > 0 ? 'bad' : 'ok'}">المتأخر: ${money(p.summary.arrears)}</span>
    </div>
    <h4 style="margin:12px 0 6px">جدول الأقساط</h4>
    <div class="table-wrap"><table><tr><th>#</th><th>الاستحقاق</th><th>القسط</th><th>المسدد منه</th><th>المتبقي</th></tr>
      ${p.summary.installments.map((i) => `<tr><td>${i.seq}</td><td>${fmtDate(i.due_date)}</td><td class="money">${money(i.amount)}</td>
        <td class="money">${money(i.paid_alloc)}</td><td class="money ${i.remaining > 0 ? 'debit-red' : ''}">${money(i.remaining)}</td></tr>`).join('')}
    </table></div>
    <h4 style="margin:12px 0 6px">سدادات الأقساط</h4>
    ${p.payments && p.payments.length ? `<div class="table-wrap"><table><tr><th>رقم السند</th><th>التاريخ</th><th>المبلغ</th><th>الطريقة</th><th></th></tr>
      ${p.payments.map((pay) => `<tr><td>${pay.receipt_no || pay.id}</td><td>${fmtDate(pay.date)}</td><td class="money">${money(pay.amount)}</td>
        <td>${esc(pay.method || '')}</td><td><button class="btn small" onclick="printInstallmentReceipt(${pay.id})">🖨</button></td></tr>`).join('')}</table></div>`
    : '<p class="muted">لا توجد سدادات بعد.</p>'}
    <div class="form-actions">
      ${p.summary.remaining > 0 ? `<button class="btn primary" onclick="closeModal();planPaymentForm(${p.id})">سداد قسط</button>` : ''}
      <button class="btn" onclick="closeModal()">إغلاق</button>
    </div>`, true);
}
function planPaymentForm(planId) {
  formModal('سداد قسط', `
    <div class="grid2">
      <label>المبلغ (${CUR()}) *<input name="amount" type="number" step="0.01" min="0.01" required></label>
      <label>التاريخ<input name="date" type="date" value="${todayStr()}"></label>
    </div>
    <label>طريقة الدفع<select name="method">${(SETTINGS.payment_methods || []).map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
    <label>ملاحظات<input name="notes"></label>`,
    async (data) => {
      const out = await api(`/api/plans/${planId}/payments`, {
        method: 'POST',
        body: JSON.stringify({ amount: num(data.amount), date: data.date, method: data.method, notes: data.notes }),
      });
      if (currentView === 'plans' || currentView === 'dashboard') render();
      setTimeout(() => printInstallmentReceipt(out.payment.id), 100);
    }, 'حفظ وطباعة السند');
}
async function printInstallmentReceipt(id) {
  const d = await api(`/api/installment-payments/${id}/receipt`);
  const pay = d.payment, s = d.settings;
  $('#printArea').innerHTML = `<div class="invoice-doc">
    <div class="inv-head"><div><div class="co-name">${esc(s.company_name || 'منزلي')}</div><div>${esc(s.company_phone || '')}</div></div>
    ${s.company_logo ? `<img class="inv-logo" src="${s.company_logo}">` : ''}</div>
    <h2>سند قبض قسط — رقم ${pay.receipt_no || pay.id}</h2>
    <table class="meta">
      <tr><td class="k">استلمنا من</td><td><strong>${esc(d.customer ? d.customer.name : '')}</strong></td></tr>
      <tr><td class="k">عن فاتورة</td><td>${esc(d.invoice_no || '')} — خطة تقسيط</td></tr>
      <tr><td class="k">المبلغ</td><td><strong>${money(pay.amount)}</strong></td></tr>
      <tr><td class="k">التاريخ</td><td>${fmtDate(pay.date)}</td></tr>
      <tr><td class="k">الطريقة</td><td>${esc(pay.method || '')}</td></tr>
      <tr><td class="k">المتبقي على الخطة</td><td>${d.summary ? money(d.summary.remaining) : ''}</td></tr>
    </table>
    <div class="amount-words">${tafqeet(pay.amount)}</div>
    <div class="inv-foot"><div class="inv-sign">المستلم<div class="line">التوقيع</div></div><div class="inv-sign">الدافع<div class="line">التوقيع</div></div></div>
  </div>`;
  window.print();
}

// ---------------- تذكيرات واتساب (تحديث 2 — بطلب عبده) ----------------
// تطبيع رقم الجوال لصيغة واتساب الدولية حسب بلد الإعدادات: أرقام محلية تبدأ
// بـ 0 تُستبدل بمقدمة الدولة، وما كان دولياً يبقى كما هو.
function waPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  const cc = SETTINGS.country === 'eg' ? '20' : '966';
  if (d.startsWith('0')) d = cc + d.slice(1);
  else if (!d.startsWith(cc) && d.length <= 11) d = cc + d;
  return d;
}
function daysDiff(a, b) { // أيام من a إلى b (تواريخ YYYY-MM-DD)
  const pa = Date.parse(String(a).slice(0, 10) + 'T00:00:00');
  const pb = Date.parse(String(b).slice(0, 10) + 'T00:00:00');
  return Math.round((pb - pa) / 86400000);
}
function waReminderLink(p, kind, amount, dueDate) {
  const phone = waPhone(p.customer_phone);
  if (!phone) return '';
  const shop = SETTINGS.company_name || SETTINGS.app_name || 'منزلي';
  const msg = kind === 'overdue'
    ? `السلام عليكم ${p.customer_name}، معك ${shop}.\nنذكّرك بأن لديك قسطاً متأخراً بقيمة ${money(amount)} مستحقاً منذ ${dueDate} عن فاتورة رقم ${p.invoice_no || ''}.\nنرجو التكرم بالسداد في أقرب وقت — وشكراً لتعاونك.`
    : `السلام عليكم ${p.customer_name}، معك ${shop}.\nنذكّرك بأن قسطك القادم بقيمة ${money(amount)} يستحق بتاريخ ${dueDate} عن فاتورة رقم ${p.invoice_no || ''}.\nشكراً لالتزامك، ونتشرف بخدمتك دائماً.`;
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}
async function viewReminders() {
  await refreshCache();
  const plans = (await api('/api/plans')).filter((p) => p.summary && p.summary.status === 'active' && p.summary.remaining > 0.009);
  const today = todayStr();
  const overdue = [], upcoming = [];
  for (const p of plans) {
    const s = p.summary;
    if (s.arrears > 0.009) {
      const firstLate = (s.installments || []).find((i) => i.remaining > 0.009 && String(i.due_date).slice(0, 10) <= today);
      overdue.push({ p, amount: s.arrears, date: firstLate ? String(firstLate.due_date).slice(0, 10) : (s.next_due ? s.next_due.due_date : ''), days: firstLate ? daysDiff(firstLate.due_date, today) : 0 });
    } else if (s.next_due && daysDiff(today, s.next_due.due_date) >= 0 && daysDiff(today, s.next_due.due_date) <= 10) {
      upcoming.push({ p, amount: s.next_due.remaining, date: s.next_due.due_date, days: daysDiff(today, s.next_due.due_date) });
    }
  }
  overdue.sort((a, b) => b.days - a.days || b.amount - a.amount);
  upcoming.sort((a, b) => a.days - b.days);
  const row = (r, kind) => {
    const link = waReminderLink(r.p, kind, r.amount, r.date);
    return `<tr><td><strong>${esc(r.p.customer_name)}</strong><div class="muted" style="font-size:11px">${esc(r.p.customer_phone || 'لا يوجد رقم جوال')}</div></td>
      <td>${esc(r.p.invoice_no || '')}</td><td class="money">${money(r.amount)}</td><td>${esc(r.date)}</td>
      <td>${kind === 'overdue' ? `<span class="badge red">متأخر ${r.days} يوم</span>` : (r.days === 0 ? '<span class="badge">يستحق اليوم</span>' : `<span class="badge">بعد ${r.days} يوم</span>`)}</td>
      <td>${link ? `<a class="btn small" style="background:#25d366;color:#fff;border-color:#25d366" href="${link}" target="_blank" rel="noopener">واتساب</a>` : '<span class="muted">—</span>'}</td></tr>`;
  };
  const table = (rows, kind) => `<div class="table-wrap"><table><tr><th>العميل</th><th>الفاتورة</th><th>المبلغ المستحق</th><th>تاريخ الاستحقاق</th><th>الحالة</th><th></th></tr>${rows.map((r) => row(r, kind)).join('')}</table></div>`;
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>تذكيرات واتساب — أقساط العملاء</h3></div>
      <p class="muted">دوس «واتساب» جنب أي عميل هتفتح محادثته برسالة تذكير جاهزة باسمه والمبلغ المستحق وتاريخه — الإرسال بيتم من رقمك أنت. المتأخرون أولاً، وبعدهم من قسطهم يستحق خلال ١٠ أيام.</p>
      <h4 style="margin:14px 0 6px">متأخرون (${overdue.length})</h4>
      ${overdue.length ? table(overdue, 'overdue') : '<p class="muted">لا توجد أقساط متأخرة — ممتاز 🎉</p>'}
      <h4 style="margin:18px 0 6px">أقساط تستحق خلال ١٠ أيام (${upcoming.length})</h4>
      ${upcoming.length ? table(upcoming, 'upcoming') : '<p class="muted">لا أقساط قادمة خلال ١٠ أيام.</p>'}
    </div>`;
}

// ---------------- التقارير ----------------
async function viewReports() {
  await refreshCache();
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>تقرير المبيعات</h3></div>
      <div class="search-row">
        <label>من<input type="date" id="repFrom" value="${monthFirst()}"></label>
        <label>إلى<input type="date" id="repTo" value="${todayStr()}"></label>
        <label>القسم<select id="repDept"><option value="">كل الأقسام</option><option value="appliances">أجهزة</option><option value="home">مفروشات وأدوات مطبخ</option></select></label>
        <button class="btn primary" id="repSalesBtn">عرض</button>
      </div>
      <div id="repSalesOut"><p class="muted">اختر الفترة ثم اضغط «عرض».</p></div>
    </div>
    <div class="cols2">
      <div class="section"><div class="section-head"><h3>تقرير المخزون</h3><button class="btn small" id="repStockBtn">تحديث</button></div><div id="repStockOut"></div></div>
      <div class="section"><div class="section-head"><h3>أرصدة العملاء والموردين</h3><button class="btn small" id="repBalBtn">تحديث</button></div><div id="repBalOut"></div></div>
    </div>
    <div class="section"><div class="section-head"><h3>تقرير التقسيط</h3><button class="btn small" id="repInstBtn">تحديث</button></div><div id="repInstOut"></div></div>`;
  const loadStock = async () => {
    const r = await api('/api/reports/stock');
    $('#repStockOut').innerHTML = `<p>إجمالي قيمة المخزون بالتكلفة: <strong>${money(r.total_value)}</strong></p>
      <div class="table-wrap"><table><tr><th>الصنف</th><th>القسم</th><th>المتاح</th><th>القيمة</th></tr>
      ${r.rows.map((i) => `<tr><td>${esc(i.name)}</td><td>${DEPT_LABELS[i.department] || ''}</td><td>${i.on_hand}</td><td class="money">${money(i.value)}</td></tr>`).join('')}</table></div>`;
  };
  const loadBal = async () => {
    const r = await api('/api/reports/balances');
    const list = (rows, empty) => rows.length ? `<table>${rows.map((p) => `<tr><td>${esc(p.name)}</td><td class="money ${p.balance > 0 ? 'debit-red' : ''}">${money(p.balance)}</td></tr>`).join('')}</table>` : `<p class="muted">${empty}</p>`;
    $('#repBalOut').innerHTML = `<p>مستحقات عند العملاء: <strong>${money(r.receivables)}</strong> · مستحقات للموردين: <strong>${money(r.payables)}</strong></p>
      <h4 style="margin:10px 0 4px">العملاء</h4>${list(r.customers, 'لا عملاء.')}
      <h4 style="margin:10px 0 4px">الموردون</h4>${list(r.suppliers, 'لا موردين.')}`;
  };
  const loadInst = async () => {
    const r = await api('/api/reports/installments');
    $('#repInstOut').innerHTML = `<div class="lines-total">
        <span>عدد الخطط: <strong>${r.totals.plans}</strong></span>
        <span>المموَّل: <strong>${money(r.totals.financed)}</strong></span>
        <span>المسدد: <strong>${money(r.totals.paid)}</strong></span>
        <span>المتبقي: <strong>${money(r.totals.remaining)}</strong></span>
        <span class="${r.totals.arrears > 0 ? 'bad' : 'ok'}">المتأخر: ${money(r.totals.arrears)}</span></div>
      ${r.plans.length ? `<div class="table-wrap"><table><tr><th>العميل</th><th>الفاتورة</th><th>المتبقي</th><th>المتأخر</th><th>الحالة</th></tr>
        ${r.plans.map((p) => `<tr><td>${esc(p.customer_name)}</td><td>${esc(p.invoice_no)}</td><td class="money">${money(p.summary.remaining)}</td>
          <td class="money ${p.summary.arrears > 0 ? 'debit-red' : ''}">${money(p.summary.arrears)}</td>
          <td>${p.summary.status === 'done' ? 'مكتملة' : 'جارية'}</td></tr>`).join('')}</table></div>` : '<p class="muted">لا خطط.</p>'}`;
  };
  $('#repSalesBtn').addEventListener('click', async () => {
    const from = $('#repFrom').value, to = $('#repTo').value, dept = $('#repDept').value;
    const r = await api(`/api/reports/sales?from=${from}&to=${to}${dept ? `&department=${dept}` : ''}`);
    $('#repSalesOut').innerHTML = `<div class="lines-total">
        <span>المبيعات: <strong>${money(r.sales_total)}</strong></span>
        <span>المرتجعات: <strong>${money(r.returns_total)}</strong></span>
        <span>الصافي: <strong>${money(r.net)}</strong></span>
        ${isAdmin() ? `<span class="ok">الربح التقديري: ${money(r.profit)}</span>` : ''}</div>
      ${r.by_department.length ? `<p class="muted">${r.by_department.map((x) => `${esc(x.label)}: ${money(x.total)}${isAdmin() ? ` (ربح ${money(x.profit)})` : ''}`).join(' · ')}</p>` : ''}
      ${r.invoices.length ? `<div class="table-wrap"><table><tr><th>الرقم</th><th>التاريخ</th><th>العميل</th><th>الإجمالي</th></tr>
        ${r.invoices.map((i) => `<tr><td><strong>${esc(i.invoice_no)}</strong>${i.has_plan ? ' <span class="badge amber">تقسيط</span>' : ''}</td><td>${fmtDate(i.date)}</td><td>${esc(i.customer_name)}</td><td class="money">${money(i.total)}</td></tr>`).join('')}</table></div>`
      : '<p class="muted">لا مبيعات في الفترة.</p>'}`;
  });
  $('#repStockBtn').addEventListener('click', loadStock);
  $('#repBalBtn').addEventListener('click', loadBal);
  $('#repInstBtn').addEventListener('click', loadInst);
  loadStock(); loadBal(); loadInst();
}

// ---------------- بحث الضمان ----------------
async function viewWarranty() {
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>بحث الضمان</h3></div>
      <p class="muted">ابحث برقم السيريال المطبوع على الجهاز أو برقم جوال العميل لعرض حالة الضمان فوراً.</p>
      <div class="search-row">
        <label>السيريال أو جوال العميل<input id="warQ" placeholder="مثال: FR-1001 أو 0501…"></label>
        <button class="btn primary" id="warBtn">بحث</button>
      </div>
      <div id="warOut"></div>
    </div>`;
  const run = async () => {
    const q = $('#warQ').value.trim();
    if (!q) { $('#warOut').innerHTML = '<p class="muted">اكتب السيريال أو الجوال أولاً.</p>'; return; }
    const rows = await api(`/api/warranty?q=${encodeURIComponent(q)}`);
    $('#warOut').innerHTML = rows.length ? `<div class="table-wrap"><table><tr><th>الجهاز</th><th>السيريال</th><th>العميل</th><th>الجوال</th><th>تاريخ الشراء</th><th>الفاتورة</th><th>نهاية الضمان</th><th>حالة الضمان</th></tr>
      ${rows.map((r) => `<tr><td><strong>${esc(r.item_name)}</strong></td><td class="serial-nums">${esc(r.serial_no)}</td>
        <td>${esc(r.customer_name)}</td><td>${esc(r.customer_phone)}</td><td>${fmtDate(r.sale_date)}</td><td>${esc(r.invoice_no)}</td>
        <td>${fmtDate(r.warranty_end)}</td>
        <td><span class="badge ${r.status_text === 'ساري' ? 'green' : r.status_text === 'منتهٍ' ? 'red' : 'gray'}">${esc(r.status_text)}</span></td></tr>`).join('')}</table></div>`
    : '<p class="muted">لا توجد نتائج مطابقة.</p>';
  };
  $('#warBtn').addEventListener('click', run);
  $('#warQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

// ---------------- الإعدادات ----------------
async function viewSettings() {
  await refreshCache();
  const s = SETTINGS;
  main().innerHTML = `
    <div class="section">
      <div class="section-head"><h3>بيانات المحل</h3></div>
      <form id="settingsForm">
        <div class="grid2">
          <label>اسم المحل/المعرض<input name="company_name" value="${esc(s.company_name || '')}" placeholder="منزلي"></label>
          <label>الهاتف<input name="company_phone" value="${esc(s.company_phone || '')}"></label>
        </div>
        <label>العنوان<input name="company_address" value="${esc(s.company_address || '')}"></label>
        <div class="grid2">
          <label>البلد (العملة والمنطقة الزمنية وطرق الدفع)<select name="country">
            <option value="sa" ${s.country !== 'eg' ? 'selected' : ''}>السعودية — ريال (ر.س)</option>
            <option value="eg" ${s.country === 'eg' ? 'selected' : ''}>مصر — جنيه (ج.م)</option>
          </select></label>
          <label>ضريبة القيمة المضافة الافتراضية %<input name="default_vat_rate" type="number" step="0.01" min="0" value="${esc(s.default_vat_rate || '15')}"></label>
        </div>
        <label>الضمان<select name="warranty_enabled">
          <option value="1" ${s.warranty_enabled !== false ? 'selected' : ''}>مفعّل — يظهر في الأصناف والفواتير مع خانة بحث الضمان</option>
          <option value="0" ${s.warranty_enabled === false ? 'selected' : ''}>معطّل — مخفي من الواجهة والفواتير (التتبع بالسيريال يبقى كما هو)</option>
        </select></label>
        <label>شعار المحل (اختياري)<input type="file" id="logoFile" accept="image/png,image/jpeg,image/webp"></label>
        ${s.company_logo ? `<img class="logo-preview" src="${s.company_logo}" alt="">` : ''}
        <div class="form-actions"><button type="submit" class="btn primary" ${isAdmin() ? '' : 'disabled'}>حفظ الإعدادات</button></div>
        ${isAdmin() ? '' : '<p class="muted">تعديل الإعدادات للمدير فقط.</p>'}
        <p class="error" id="setError"></p><p class="muted" id="setOk"></p>
      </form>
    </div>
    <div class="section">
      <div class="section-head"><h3>بيانات تجريبية للعرض</h3></div>
      <p class="muted">تعبئة بيانات جاهزة (موردون وعملاء وأجهزة ومفروشات وفواتير وبيع بالتقسيط) لتجربة البرنامج وعرضه — تعمل فقط على قاعدة فارغة.</p>
      <div class="form-actions">
        <button class="btn primary" id="seedBtn" ${isAdmin() ? '' : 'disabled'}>تعبئة بيانات تجريبية</button>
        <button class="btn danger" id="wipeBtn" ${isAdmin() ? '' : 'disabled'}>مسح كل البيانات التشغيلية</button>
      </div>
      <p class="error" id="demoError"></p>
    </div>
    <div class="section">
      <div class="section-head"><h3>النسخ الاحتياطي</h3></div>
      <p class="muted">تنزيل نسخة كاملة من البيانات (JSON) أو استعادتها. قبل أي استعادة تُحفظ نسخة أمان من الحالة الحالية تلقائياً على الخادم.</p>
      <div class="form-actions">
        <button class="btn" id="backupBtn" ${isAdmin() ? '' : 'disabled'}>تنزيل نسخة احتياطية</button>
        <button class="btn" id="safetyBtn" ${isAdmin() ? '' : 'disabled'}>تنزيل آخر نسخة أمان</button>
      </div>
      <label style="margin-top:10px">استعادة من ملف نسخة<input type="file" id="restoreFile" accept=".json" ${isAdmin() ? '' : 'disabled'}></label>
      <p class="error" id="backupError"></p>
    </div>
    <div class="section" id="usersSection">
      <div class="section-head"><h3>مستخدمو النظام</h3>${isAdmin() ? '<button class="btn primary" onclick="userForm()">+ مستخدم</button>' : ''}</div>
      <div id="usersList"><p class="muted">جارٍ التحميل…</p></div>
    </div>
    <div class="section">
      <div class="section-head"><h3>حسابي</h3></div>
      <p class="muted">المستخدم: <strong>${esc(ME ? ME.display_name : '')}</strong> (${esc(ME ? ME.username : '')}) — ${ME && ME.role === 'admin' ? 'مدير' : 'موظف'}</p>
      ${ME && !ME.bootstrap ? '<button class="btn" onclick="changeMyPassword()">تغيير كلمة مروري</button>' : '<p class="muted">حساب المدير الرئيسي تُغيَّر كلمة سره من إعدادات الخادم.</p>'}
    </div>`;
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    const file = $('#logoFile').files[0];
    try {
      if (file) {
        data.company_logo = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
      }
      SETTINGS = await api('/api/settings', { method: 'PUT', body: JSON.stringify(data) });
      $('#setOk').textContent = 'تم حفظ الإعدادات ✓';
      applyBranding();
    } catch (err) { $('#setError').textContent = err.message; }
  });
  $('#seedBtn').addEventListener('click', async () => {
    try { await api('/api/demo/seed', { method: 'POST', body: '{}' }); go('dashboard'); }
    catch (err) { $('#demoError').textContent = err.message; }
  });
  $('#wipeBtn').addEventListener('click', () => {
    confirmAction('مسح البيانات', 'سيتم حذف كل الأصناف والفواتير والسيريالات والأطراف والخطط نهائياً (تبقى حسابات الدخول والإعدادات). متأكد؟', 'مسح الكل', async () => {
      await api('/api/demo/wipe', { method: 'POST', body: '{}' });
      posState = null;
      go('dashboard');
    });
  });
  $('#backupBtn').addEventListener('click', async () => {
    try { await downloadFile('/api/backup', 'backup.json'); } catch (err) { $('#backupError').textContent = err.message; }
  });
  $('#safetyBtn').addEventListener('click', async () => {
    try { await downloadFile('/api/backup/safety', 'safety.json'); } catch (err) { $('#backupError').textContent = err.message; }
  });
  $('#restoreFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await api('/api/restore', { method: 'POST', body: JSON.stringify(data) });
      alert('تمت الاستعادة بنجاح');
      go('dashboard');
    } catch (err) { $('#backupError').textContent = err.message; }
  });
  loadUsersList();
}
async function loadUsersList() {
  const el = $('#usersList');
  if (!el) return;
  if (!isAdmin()) { el.innerHTML = '<p class="muted">إدارة المستخدمين للمدير فقط.</p>'; return; }
  const d = await api('/api/users');
  el.innerHTML = `<table><tr><th>المستخدم</th><th>الاسم</th><th>الدور</th><th>الحالة</th><th></th></tr>
    <tr><td><strong>${esc(d.bootstrap.username)}</strong></td><td>${esc(d.bootstrap.display_name)} (من إعدادات الخادم)</td><td>مدير</td><td><span class="badge green">نشط دائماً</span></td><td></td></tr>
    ${d.users.map((u) => `<tr><td><strong>${esc(u.username)}</strong></td><td>${esc(u.display_name)}</td>
      <td>${u.role === 'admin' ? 'مدير' : 'موظف'}</td>
      <td>${u.active ? '<span class="badge green">نشط</span>' : '<span class="badge red">موقوف</span>'}</td>
      <td><button class="btn small" onclick="userForm(${u.id})">تعديل</button></td></tr>`).join('')}</table>
    <p class="kbd-hint">الموظف لا يستطيع الحذف ولا تعديل الإعدادات ولا النسخ الاحتياطي.</p>`;
}
function userForm(id) {
  formModal(id ? 'تعديل مستخدم' : 'مستخدم جديد', `
    ${id ? '' : '<label>اسم المستخدم *<input name="username" required autocomplete="off"></label>'}
    <label>الاسم الظاهر<input name="display_name"></label>
    <label>${id ? 'كلمة مرور جديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور *'}<input name="password" type="password" ${id ? '' : 'required'} autocomplete="new-password"></label>
    <div class="grid2">
      <label>الدور<select name="role"><option value="staff">موظف</option><option value="admin">مدير</option></select></label>
      <label>الحالة<select name="active"><option value="1">نشط</option><option value="0">موقوف</option></select></label>
    </div>`,
    async (data) => {
      if (id) {
        const payload = { display_name: data.display_name, role: data.role, active: data.active === '1' };
        if (data.password) payload.password = data.password;
        await api(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/api/users', { method: 'POST', body: JSON.stringify(data) });
      }
      loadUsersList();
    });
  if (id) {
    api('/api/users').then((d) => {
      const u = d.users.find((x) => x.id === id);
      if (!u) return;
      const f = $('#modalForm');
      f.display_name.value = u.display_name || '';
      f.role.value = u.role;
      f.active.value = u.active ? '1' : '0';
    });
  }
}
function changeMyPassword() {
  formModal('تغيير كلمة المرور', `
    <label>كلمة المرور الحالية *<input name="current_password" type="password" required></label>
    <label>كلمة المرور الجديدة *<input name="new_password" type="password" required></label>`,
    async (data) => { await api('/api/me/password', { method: 'POST', body: JSON.stringify(data) }); });
}

// ---------------- الإقلاع ----------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* تجاهل */ });
}
loadBranding();
if (token()) startApp();
