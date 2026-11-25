'use strict';
// منطق حسابات برنامج «منزلي» — إدارة محل أدوات منزلية (أجهزة + مفروشات ومطبخ)
// كل المبالغ تُقرَّب بـ round2، والكمية بـ round3. إشارات الأرصدة:
// - رصيد العميل موجب = العميل مدين للمحل (عليه مبلغ).
// - رصيد المورد موجب = المحل مدين للمورد (عليه مبلغ).
// رصيد فاتورة بيع بخطة تقسيط يُمثَّل بالخطة فقط: (إجمالي الخطة − الدفعة الأولى
// − سدادات الأقساط) — فلا يُحتسب باقي الفاتورة مرتين.

const EPS = 0.005;

function n(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }
function round2(x) { return Math.round((n(x) + Number.EPSILON) * 100) / 100; }
function round3(x) { return Math.round((n(x) + Number.EPSILON) * 1000) / 1000; }

// ---------------- التواريخ ----------------
function toDate(d) {
  if (!d) return null;
  if (d instanceof Date) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const s = String(d).slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, day || 1);
}
function fmtDate(d) {
  const x = toDate(d);
  if (!x) return '';
  const p = (v) => String(v).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}
function addMonths(date, months) {
  const d = toDate(date);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
}
function addDays(date, days) {
  const d = toDate(date);
  d.setDate(d.getDate() + days);
  return d;
}
// المنطقة الزمنية لحساب «اليوم» — تُضبط من إعداد البلد (الافتراضي: الرياض)
let TIMEZONE = 'Asia/Riyadh';
function setTimezone(tz) { if (tz) TIMEZONE = tz; }
function today() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return new Date(g('year'), g('month') - 1, g('day'));
}
function todayStr() { return fmtDate(today()); }

// ---------------- البلد والعملة وطرق الدفع ----------------
const COUNTRY_PRESETS = {
  sa: { label: 'ر.س', tz: 'Asia/Riyadh', methods: ['نقداً', 'تحويل', 'شبكة/مدى', 'STC Pay', 'Apple Pay'] },
  eg: { label: 'ج.م', tz: 'Africa/Cairo', methods: ['نقداً', 'تحويل', 'فودافون كاش', 'إنستاباي', 'محفظة إلكترونية'] },
};
function countryPreset(country) { return COUNTRY_PRESETS[country] || COUNTRY_PRESETS.sa; }

// قوائم السيريال تُخزَّن كنص JSON في قاعدة البيانات — هذه تقرأها بأمان
function parseSerialList(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x !== null ? x : x)).filter((x) => x !== null && x !== undefined && x !== '');
  if (typeof v === 'string' && v.trim()) {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  return [];
}

// ---------------- إجماليات فاتورة (بيع أو شراء) ----------------
// lines: [{qty, price}] — الخصم مبلغ ثابت بعد الإجمالي الفرعي، والضريبة على (الفرعي − الخصم)
function invoiceTotals(rawLines, discount, vatRate) {
  const lines = (rawLines || []).map((l) => {
    const qty = n(l.qty);
    const price = round2(l.price);
    return { ...l, qty, price, line_total: round2(qty * price) };
  });
  const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
  const disc = Math.min(Math.max(round2(discount), 0), subtotal);
  const vatBase = round2(subtotal - disc);
  const vat_total = round2(vatBase * (n(vatRate) / 100));
  const total = round2(vatBase + vat_total);
  return { lines, subtotal, discount: disc, vat_total, total };
}

// ---------------- المخزون ----------------
function isSerialItem(item) { return !!(item && item.track_serial); }
function onHand(item, movements, serials) {
  if (!item) return 0;
  if (isSerialItem(item)) {
    return (serials || []).filter((s) => s.item_id === item.id && s.status === 'in_stock').length;
  }
  return round3((movements || []).filter((m) => m.item_id === item.id)
    .reduce((s, m) => s + n(m.qty), 0));
}
function stockValue(items, movements, serials) {
  return round2((items || []).reduce((s, it) => s + onHand(it, movements, serials) * n(it.cost_price), 0));
}

// ---------------- التقسيط ----------------
// جدول الأقساط: الباقي بعد الدفعة الأولى يُقسَّم بالتساوي، والقرش الأخير في القسط الأخير
function buildSchedule(total, downPayment, months, firstDue) {
  const remaining = round2(n(total) - n(downPayment));
  const count = Math.floor(n(months));
  if (count < 1 || remaining <= 0) return [];
  const each = round2(remaining / count);
  const out = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const amount = i === count - 1 ? round2(remaining - acc) : each;
    acc = round2(acc + amount);
    out.push({ seq: i + 1, due_date: fmtDate(addMonths(firstDue, i)), amount });
  }
  return out;
}
// توزيع السدادات على الأقساط بالترتيب (الأقدم أولاً) — يعيد خريطة installment_id → المسدد منه
function allocateInstallments(installments, paymentsTotal) {
  const alloc = new Map();
  let left = round2(paymentsTotal);
  const sorted = [...(installments || [])].sort((a, b) => a.seq - b.seq);
  for (const inst of sorted) {
    const take = Math.max(0, Math.min(n(inst.amount), left));
    alloc.set(inst.id, round2(take));
    left = round2(left - take);
  }
  return alloc;
}
function planSummary(plan, installments, payments, asOf) {
  const paid = round2((payments || []).reduce((s, p) => s + n(p.amount), 0));
  const sched = [...(installments || [])].sort((a, b) => a.seq - b.seq);
  const alloc = allocateInstallments(sched, paid);
  const asOfStr = fmtDate(asOf || today());
  const dueToDate = round2(sched.filter((i) => fmtDate(i.due_date) <= asOfStr)
    .reduce((s, i) => s + n(i.amount), 0));
  const arrears = round2(Math.max(0, dueToDate - paid));
  const remaining = round2(n(plan.total) - n(plan.down_payment) - paid);
  let nextDue = null;
  for (const inst of sched) {
    const rest = round2(n(inst.amount) - (alloc.get(inst.id) || 0));
    if (rest > EPS) { nextDue = { seq: inst.seq, due_date: fmtDate(inst.due_date), amount: n(inst.amount), remaining: rest }; break; }
  }
  return {
    total: round2(plan.total), down_payment: round2(plan.down_payment), paid,
    schedule_total: round2(sched.reduce((s, i) => s + n(i.amount), 0)),
    due_to_date: dueToDate, arrears, remaining,
    next_due: nextDue,
    status: remaining <= EPS ? 'done' : 'active',
    installments: sched.map((i) => ({
      ...i, due_date: fmtDate(i.due_date),
      paid_alloc: alloc.get(i.id) || 0,
      remaining: round2(n(i.amount) - (alloc.get(i.id) || 0)),
    })),
  };
}
// نهاية الضمان: تاريخ البيع + شهور الضمان − يوم (الضمان شامل يوم الانتهاء)
function warrantyEndDate(start, months) {
  if (!start || !n(months)) return null;
  return fmtDate(addDays(addMonths(start, Math.floor(n(months))), -1));
}

// ---------------- أرصدة الأطراف وكشوفهم ----------------
// data: { sales, purchases, returns, partyPayments, plans, planPayments }
function planPaymentsBySale(data) {
  const planBySale = new Map((data.plans || []).map((p) => [p.sale_invoice_id, p]));
  const paidBySale = new Map();
  for (const pay of data.planPayments || []) {
    const plan = (data.plans || []).find((p) => p.id === pay.plan_id);
    if (!plan) continue;
    paidBySale.set(plan.sale_invoice_id, round2((paidBySale.get(plan.sale_invoice_id) || 0) + n(pay.amount)));
  }
  return { planBySale, paidBySale };
}
function partyBalance(party, data) {
  if (!party) return 0;
  let bal = n(party.opening_balance);
  const { paidBySale } = planPaymentsBySale(data);
  if (party.type === 'customer') {
    for (const s of data.sales || []) {
      if (s.customer_id !== party.id || s.status !== 'posted') continue;
      bal += n(s.total) - n(s.paid_now);
      bal -= paidBySale.get(s.id) || 0;
      for (const r of data.returns || []) {
        if (r.sale_invoice_id === s.id && r.settlement === 'account') bal -= n(r.total);
      }
    }
    for (const p of data.partyPayments || []) if (p.party_id === party.id) bal -= n(p.amount);
  } else {
    for (const p of data.purchases || []) {
      if (p.supplier_id !== party.id) continue;
      if (p.status === 'posted') bal += n(p.total) - n(p.paid);
      else if (p.status === 'void') bal -= n(p.paid);
    }
    for (const p of data.partyPayments || []) if (p.party_id === party.id) bal -= n(p.amount);
  }
  return round2(bal);
}

function partyStatement(party, data) {
  const entries = [];
  const push = (date, label, amount, ref) => entries.push({ date: date ? fmtDate(date) : '', label, amount: round2(amount), ref: ref || '' });
  push(null, 'الرصيد الافتتاحي', n(party.opening_balance));
  const planById = new Map((data.plans || []).map((p) => [p.id, p]));
  const saleById = new Map((data.sales || []).map((s) => [s.id, s]));
  if (party.type === 'customer') {
    for (const s of data.sales || []) {
      if (s.customer_id !== party.id || s.status !== 'posted') continue;
      push(s.date, `فاتورة بيع ${s.invoice_no}`, n(s.total), s.invoice_no);
      if (n(s.paid_now) > 0) push(s.date, `دفعة عند البيع — ${s.invoice_no}`, -n(s.paid_now), s.invoice_no);
    }
    for (const pay of data.planPayments || []) {
      const plan = planById.get(pay.plan_id);
      if (!plan || plan.customer_id !== party.id) continue;
      const sale = saleById.get(plan.sale_invoice_id);
      push(pay.date, `سداد قسط — ${sale ? sale.invoice_no : ''} (سند ${pay.receipt_no || ''})`, -n(pay.amount));
    }
    for (const r of data.returns || []) {
      if (r.customer_id !== party.id) continue;
      if (r.settlement === 'account') push(r.date, `مرتجع مبيعات ${r.return_no}`, -n(r.total), r.return_no);
      else push(r.date, `مرتجع مبيعات ${r.return_no} — استرداد نقدي (لا يؤثر في الرصيد)`, 0, r.return_no);
    }
    for (const p of data.partyPayments || []) {
      if (p.party_id === party.id) push(p.date, `سند قبض على الحساب (رقم ${p.receipt_no || ''})`, -n(p.amount));
    }
  } else {
    for (const p of data.purchases || []) {
      if (p.supplier_id !== party.id) continue;
      if (p.status === 'posted') {
        push(p.date, `فاتورة شراء ${p.invoice_no}`, n(p.total), p.invoice_no);
        if (n(p.paid) > 0) push(p.date, `مسدد عند الشراء — ${p.invoice_no}`, -n(p.paid), p.invoice_no);
      } else if (p.status === 'void') {
        push(p.void_date || p.date, `إلغاء فاتورة شراء ${p.invoice_no}`, -(n(p.total) - n(p.paid)), p.invoice_no);
      }
    }
    for (const p of data.partyPayments || []) {
      if (p.party_id === party.id) push(p.date, `سند صرف على الحساب (رقم ${p.receipt_no || ''})`, -n(p.amount));
    }
  }
  entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let bal = 0;
  for (const e of entries) { bal = round2(bal + e.amount); e.balance = bal; }
  return { party, opening_balance: round2(party.opening_balance), entries, closing_balance: bal };
}

// ربح فترة: مجموع (سعر − تكلفة) × كمية على سطور بيع الفترة − سطور مرتجعات الفترة
function periodProfit(sales, salesLines, returns, returnLines, from, to) {
  const inRange = (d) => { const s = fmtDate(d); return (!from || s >= from) && (!to || s <= to); };
  let profit = 0;
  const saleIds = new Set((sales || []).filter((s) => s.status === 'posted' && inRange(s.date)).map((s) => s.id));
  for (const l of salesLines || []) {
    if (saleIds.has(l.invoice_id)) profit += (n(l.price) - n(l.cost)) * n(l.qty);
  }
  const retIds = new Set((returns || []).filter((r) => inRange(r.date)).map((r) => r.id));
  for (const l of returnLines || []) {
    if (retIds.has(l.return_id)) profit -= (n(l.price) - n(l.cost)) * n(l.qty);
  }
  return round2(profit);
}

module.exports = {
  EPS, n, round2, round3,
  toDate, fmtDate, addMonths, addDays, today, todayStr, setTimezone,
  COUNTRY_PRESETS, countryPreset, parseSerialList,
  invoiceTotals, isSerialItem, onHand, stockValue,
  buildSchedule, allocateInstallments, planSummary, warrantyEndDate,
  partyBalance, partyStatement, periodProfit,
};
