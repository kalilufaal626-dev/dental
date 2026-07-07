// =====================================================================
// DENTCARE PRO — server.js
// Express API backed by Supabase (Postgres), matching public/index.html
// =====================================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  JWT_SECRET,
  PORT,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in your environment (.env).');
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error('Missing JWT_SECRET in your environment (.env).');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function ok(res, data, status = 200) { return res.status(status).json(data); }
function fail(res, status, message) { return res.status(status).json({ error: message }); }

async function staffMap() {
  const { data, error } = await supabase.from('staff').select('id, full_name, role, specialization');
  if (error) throw error;
  const map = {};
  (data || []).forEach(s => { map[s.id] = s; });
  return map;
}
async function patientMap() {
  const { data, error } = await supabase.from('patients').select('id, full_name, patient_id');
  if (error) throw error;
  const map = {};
  (data || []).forEach(p => { map[p.id] = p; });
  return map;
}

async function comparePassword(plain, stored) {
  // Supports bcrypt-hashed passwords (new staff/accounts created via this API)
  // and falls back to a plain-text comparison for rows added by hand in the
  // Supabase table editor (e.g. a manually-created admin row).
  if (!stored) return false;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    try { return await bcrypt.compare(plain, stored); } catch { return false; }
  }
  return plain === stored;
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return fail(res, 401, 'Missing token');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return fail(res, 401, 'Invalid or expired token');
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return fail(res, 403, `This action requires one of these roles: ${roles.join(', ')}`);
    }
    next();
  };
}

// Any logged-in staff member (i.e. not the patient portal)
const STAFF_ROLES = ['admin', 'dentist', 'receptionist', 'pharmacist', 'nurse'];
function requireStaff(req, res, next) {
  if (!req.user || !STAFF_ROLES.includes(req.user.role)) {
    return fail(res, 403, 'Staff access only');
  }
  next();
}

// =====================================================================
// HEALTH CHECK  (Railway / Render ping this)
// =====================================================================
app.get('/health', (req, res) => ok(res, { status: 'ok' }));
app.get('/', (req, res) => ok(res, { name: 'DentCare Pro API', status: 'live' }));
// =====================================================================
// AUTH
// =====================================================================
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return fail(res, 400, 'Email and password are required');

    // 1. Check staff
    const { data: staffRow } = await supabase
      .from('staff').select('*').eq('email', email).maybeSingle();

    if (staffRow) {
      if (staffRow.status && staffRow.status !== 'active') {
        return fail(res, 403, 'This account has been deactivated');
      }
      const match = await comparePassword(password, staffRow.password);
      if (!match) return fail(res, 401, 'Invalid email or password');
      const user = {
        id: staffRow.id,
        email: staffRow.email,
        full_name: staffRow.full_name,
        role: staffRow.role,
      };
      return ok(res, { token: signToken(user), user });
    }

    // 2. Check patient portal accounts
    const { data: accountRow } = await supabase
      .from('patient_accounts').select('*').eq('email', email).maybeSingle();

    if (accountRow) {
      const match = await comparePassword(password, accountRow.password);
      if (!match) return fail(res, 401, 'Invalid email or password');
      const user = {
        id: accountRow.id,
        email: accountRow.email,
        full_name: accountRow.full_name,
        role: 'patient',
        patient_id: accountRow.patient_id,
      };
      return ok(res, { token: signToken(user), user });
    }

    return fail(res, 401, 'Invalid email or password');
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Login failed');
  }
});

// Everything below requires a valid token
app.use(authenticate);

// =====================================================================
// STATS (admin dashboard)
// =====================================================================
app.get('/stats', requireRole('admin'), async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data: todayAppts, error: apptErr } = await supabase
      .from('appointments').select('status').eq('date', today);
    if (apptErr) throw apptErr;
    const completed = todayAppts.filter(a => a.status === 'completed').length;
    const cancelled = todayAppts.filter(a => ['cancelled', 'no_show'].includes(a.status)).length;
    const pending = todayAppts.length - completed - cancelled;

    const { data: invoices, error: invErr } = await supabase
      .from('invoices').select('total, amount_paid, created_at');
    if (invErr) throw invErr;
    const outstanding = invoices.reduce((s, i) => s + (Number(i.total) - Number(i.amount_paid)), 0);
    const collectedToday = invoices
      .filter(i => (i.created_at || '').slice(0, 10) === today)
      .reduce((s, i) => s + Number(i.amount_paid), 0);

    const { count: totalPatients } = await supabase
      .from('patients').select('id', { count: 'exact', head: true });

    const { data: drugs, error: drugErr } = await supabase
      .from('drugs').select('stock, min_stock');
    if (drugErr) throw drugErr;
    const lowStock = drugs.filter(d => d.stock <= d.min_stock).length;

    const { count: pendingRx } = await supabase
      .from('prescriptions').select('id', { count: 'exact', head: true }).eq('status', 'pending');

    return ok(res, {
      today_appointments: { total: todayAppts.length, completed, pending, cancelled },
      revenue: { collected_today: collectedToday, outstanding },
      low_stock_drugs: lowStock,
      total_patients: totalPatients || 0,
      pending_prescriptions: pendingRx || 0,
    });
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load stats');
  }
});

// =====================================================================
// APPOINTMENTS
// =====================================================================
app.get('/appointments', async (req, res) => {
  try {
    let query = supabase.from('appointments').select('*').order('date', { ascending: true }).order('time', { ascending: true });

    if (req.user.role === 'patient') {
      query = query.eq('patient_id', req.user.patient_id);
    } else if (req.query.patient_id) {
      query = query.eq('patient_id', req.query.patient_id);
    }
    if (req.query.date) query = query.eq('date', req.query.date);
    if (req.query.status) query = query.eq('status', req.query.status);

    const { data, error } = await query;
    if (error) throw error;

    const [pMap, sMap] = await Promise.all([patientMap(), staffMap()]);
    const rows = data.map(a => ({
      ...a,
      patient_name: pMap[a.patient_id]?.full_name || null,
      doctor_name: sMap[a.doctor_id]?.full_name || null,
    }));
    return ok(res, rows);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load appointments');
  }
});

app.post('/appointments', requireRole('admin', 'dentist', 'receptionist', 'patient'), async (req, res) => {
  try {
    const body = req.body || {};
    const patient_id = req.user.role === 'patient' ? req.user.patient_id : body.patient_id;
    if (!patient_id || !body.doctor_id || !body.date || !body.time || !body.treatment) {
      return fail(res, 400, 'patient_id, doctor_id, date, time and treatment are required');
    }
    const insert = {
      patient_id,
      doctor_id: body.doctor_id,
      date: body.date,
      time: body.time,
      treatment: body.treatment,
      notes: body.notes || null,
      status: 'scheduled',
      created_by: req.user.role === 'patient' ? null : req.user.id,
    };
    const { data, error } = await supabase.from('appointments').insert(insert).select().single();
    if (error) throw error;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not book appointment');
  }
});

app.patch('/appointments/:id', requireRole('admin', 'dentist', 'receptionist'), async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!status) return fail(res, 400, 'status is required');
    const { data, error } = await supabase
      .from('appointments').update({ status }).eq('id', req.params.id).select().single();
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not update appointment');
  }
});

// =====================================================================
// PATIENTS
// =====================================================================
app.get('/patients', requireStaff, async (req, res) => {
  try {
    let query = supabase.from('patients').select('*').order('created_at', { ascending: false });
    if (req.query.search) {
      const s = req.query.search;
      query = query.or(`full_name.ilike.%${s}%,patient_id.ilike.%${s}%,phone.ilike.%${s}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load patients');
  }
});

app.post('/patients', requireRole('admin', 'dentist', 'receptionist'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.full_name) return fail(res, 400, 'full_name is required');
    const insert = {
      full_name: b.full_name,
      date_of_birth: b.date_of_birth || null,
      gender: b.gender || null,
      blood_type: b.blood_type || null,
      allergies: b.allergies || null,
      phone: b.phone || null,
      email: b.email || null,
      address: b.address || null,
      emergency_name: b.emergency_name || null,
      emergency_phone: b.emergency_phone || null,
    };
    const { data, error } = await supabase.from('patients').insert(insert).select().single();
    if (error) throw error;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not register patient');
  }
});

app.get('/patients/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (req.user.role === 'patient' && String(req.user.patient_id) !== String(id)) {
      return fail(res, 403, 'You can only view your own record');
    }
    if (req.user.role !== 'patient' && !STAFF_ROLES.includes(req.user.role)) {
      return fail(res, 403, 'Not allowed');
    }
    const { data, error } = await supabase.from('patients').select('*').eq('id', id).single();
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 404, 'Patient not found');
  }
});

function assertPatientAccess(req, res, id) {
  if (req.user.role === 'patient' && String(req.user.patient_id) !== String(id)) {
    fail(res, 403, 'You can only view your own record');
    return false;
  }
  if (req.user.role !== 'patient' && !STAFF_ROLES.includes(req.user.role)) {
    fail(res, 403, 'Not allowed');
    return false;
  }
  return true;
}

// --- Dental chart -----------------------------------------------------
app.get('/patients/:id/chart', async (req, res) => {
  try {
    if (!assertPatientAccess(req, res, req.params.id)) return;
    const { data, error } = await supabase
      .from('dental_chart').select('*').eq('patient_id', req.params.id);
    if (error) throw error;
    const sMap = await staffMap();
    const rows = data.map(r => ({ ...r, doctor_name: sMap[r.doctor_id]?.full_name || null }));
    return ok(res, rows);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load dental chart');
  }
});

app.post('/patients/:id/chart', requireRole('admin', 'dentist'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.tooth_number || !b.condition) return fail(res, 400, 'tooth_number and condition are required');
    const upsert = {
      patient_id: req.params.id,
      tooth_number: b.tooth_number,
      condition: b.condition,
      treatment_date: b.treatment_date || null,
      notes: b.notes || null,
      doctor_id: req.user.id,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('dental_chart').upsert(upsert, { onConflict: 'patient_id,tooth_number' }).select().single();
    if (error) throw error;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not update tooth');
  }
});

// --- Medical records ----------------------------------------------------
app.get('/patients/:id/records', async (req, res) => {
  try {
    if (!assertPatientAccess(req, res, req.params.id)) return;
    const { data, error } = await supabase
      .from('medical_records').select('*').eq('patient_id', req.params.id).order('created_at', { ascending: false });
    if (error) throw error;
    const sMap = await staffMap();
    const rows = data.map(r => ({ ...r, doctor_name: sMap[r.doctor_id]?.full_name || null }));
    return ok(res, rows);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load records');
  }
});

app.post('/patients/:id/records', requireRole('admin', 'dentist', 'nurse'), async (req, res) => {
  try {
    const b = req.body || {};
    const insert = {
      patient_id: req.params.id,
      doctor_id: req.user.id,
      diagnosis: b.diagnosis || null,
      treatment_done: b.treatment_done || null,
      treatment_plan: b.treatment_plan || null,
      notes: b.notes || null,
      bp: b.bp || null,
      temperature: b.temperature || null,
      pulse: b.pulse || null,
      weight: b.weight || null,
      oxygen: b.oxygen || null,
    };
    const { data, error } = await supabase.from('medical_records').insert(insert).select().single();
    if (error) throw error;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not save record');
  }
});

// --- X-rays / lab results ----------------------------------------------
app.get('/patients/:id/xrays', async (req, res) => {
  try {
    if (!assertPatientAccess(req, res, req.params.id)) return;
    const { data, error } = await supabase
      .from('xrays').select('*').eq('patient_id', req.params.id).order('created_at', { ascending: false });
    if (error) throw error;
    const sMap = await staffMap();
    const rows = data.map(x => ({ ...x, doctor_name: sMap[x.doctor_id]?.full_name || null }));
    return ok(res, rows);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load x-rays');
  }
});

app.post('/patients/:id/xrays', requireRole('admin', 'dentist'), async (req, res) => {
  try {
    const b = req.body || {};
    const insert = {
      patient_id: req.params.id,
      tooth_number: b.tooth_number || null,
      type: b.type || 'other',
      file_url: b.file_url || null,
      findings: b.findings || null,
      doctor_id: req.user.id,
      status: 'pending',
    };
    const { data, error } = await supabase.from('xrays').insert(insert).select().single();
    if (error) throw error;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not save x-ray');
  }
});

// =====================================================================
// PRESCRIPTIONS
// =====================================================================
app.get('/prescriptions', async (req, res) => {
  try {
    let query = supabase.from('prescriptions').select('*').order('created_at', { ascending: false });
    if (req.user.role === 'patient') {
      query = query.eq('patient_id', req.user.patient_id);
    } else if (req.query.patient_id) {
      query = query.eq('patient_id', req.query.patient_id);
    }
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) throw error;

    const [pMap, sMap] = await Promise.all([patientMap(), staffMap()]);
    const rows = data.map(r => ({
      ...r,
      patient_name: pMap[r.patient_id]?.full_name || null,
      doctor_name: sMap[r.doctor_id]?.full_name || null,
    }));
    return ok(res, rows);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load prescriptions');
  }
});

app.post('/prescriptions', requireRole('admin', 'dentist'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.patient_id || !b.drug_name || !b.dosage || !b.frequency || !b.duration) {
      return fail(res, 400, 'patient_id, drug_name, dosage, frequency and duration are required');
    }
    const insert = {
      patient_id: b.patient_id,
      doctor_id: req.user.id,
      appointment_id: b.appointment_id || null,
      drug_name: b.drug_name,
      dosage: b.dosage,
      frequency: b.frequency,
      duration: b.duration,
      notes: b.notes || null,
      status: 'pending',
    };
    const { data, error } = await supabase.from('prescriptions').insert(insert).select().single();
    if (error) throw error;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not save prescription');
  }
});

app.patch('/prescriptions/:id/dispense', requireRole('admin', 'pharmacist'), async (req, res) => {
  try {
    const update = {
      status: 'dispensed',
      dispensed_by: req.user.id,
      dispensed_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('prescriptions').update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not dispense prescription');
  }
});

// =====================================================================
// DRUGS / PHARMACY
// =====================================================================
app.get('/drugs', requireStaff, async (req, res) => {
  try {
    let query = supabase.from('drugs').select('*').order('name', { ascending: true });
    const { data, error } = await query;
    if (error) throw error;
    let rows = data;
    if (req.query.low_stock === 'true') rows = rows.filter(d => d.stock <= d.min_stock);
    return ok(res, rows);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load drugs');
  }
});

app.post('/drugs', requireRole('admin', 'pharmacist'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return fail(res, 400, 'name is required');
    const insert = {
      name: b.name,
      category: b.category || null,
      unit: b.unit || 'tablet',
      stock: b.stock ?? 0,
      min_stock: b.min_stock ?? 10,
      price: b.price ?? null,
      expiry_date: b.expiry_date || null,
      supplier: b.supplier || null,
    };
    const { data, error } = await supabase.from('drugs').insert(insert).select().single();
    if (error) throw error;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not add drug');
  }
});

app.patch('/drugs/:id', requireRole('admin', 'pharmacist'), async (req, res) => {
  try {
    const b = req.body || {};
    const update = {};
    if (b.stock !== undefined) update.stock = b.stock;
    if (b.price !== undefined) update.price = b.price;
    const { data, error } = await supabase
      .from('drugs').update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not update drug');
  }
});

// =====================================================================
// INVOICES / BILLING
// =====================================================================
app.get('/invoices', async (req, res) => {
  try {
    let query = supabase.from('invoices').select('*').order('created_at', { ascending: false });
    if (req.user.role === 'patient') {
      query = query.eq('patient_id', req.user.patient_id);
    }
    if (req.query.status) query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) throw error;
    const pMap = await patientMap();
    const rows = data.map(i => ({ ...i, patient_name: pMap[i.patient_id]?.full_name || null }));
    return ok(res, rows);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load invoices');
  }
});

app.post('/invoices', requireRole('admin', 'receptionist'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.patient_id || !Array.isArray(b.items) || !b.items.length) {
      return fail(res, 400, 'patient_id and at least one item are required');
    }
    const subtotal = b.items.reduce((s, it) => s + Number(it.unit_price) * Number(it.quantity || 1), 0);
    const discount = Number(b.discount || 0);
    const total = Math.max(subtotal - discount, 0);

    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .insert({
        patient_id: b.patient_id,
        appointment_id: b.appointment_id || null,
        subtotal,
        discount,
        total,
        amount_paid: 0,
        status: 'unpaid',
        notes: b.notes || null,
        created_by: req.user.id,
      })
      .select().single();
    if (invErr) throw invErr;

    const itemsInsert = b.items.map(it => ({
      invoice_id: invoice.id,
      service: it.service,
      quantity: it.quantity || 1,
      unit_price: it.unit_price,
      total: Number(it.unit_price) * Number(it.quantity || 1),
    }));
    const { error: itemsErr } = await supabase.from('invoice_items').insert(itemsInsert);
    if (itemsErr) throw itemsErr;

    return ok(res, invoice, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not create invoice');
  }
});

app.get('/invoices/:id/items', async (req, res) => {
  try {
    const { data: invoice, error: invErr } = await supabase
      .from('invoices').select('patient_id').eq('id', req.params.id).single();
    if (invErr) throw invErr;
    if (req.user.role === 'patient' && String(invoice.patient_id) !== String(req.user.patient_id)) {
      return fail(res, 403, 'Not allowed');
    }
    const { data, error } = await supabase
      .from('invoice_items').select('*').eq('invoice_id', req.params.id);
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load invoice items');
  }
});

app.patch('/invoices/:id/pay', requireRole('admin', 'receptionist'), async (req, res) => {
  try {
    const { amount_paid, payment_method } = req.body || {};
    const payment = Number(amount_paid);
    if (!payment || payment <= 0) return fail(res, 400, 'amount_paid must be a positive number');

    const { data: invoice, error: getErr } = await supabase
      .from('invoices').select('*').eq('id', req.params.id).single();
    if (getErr) throw getErr;

    const newPaid = Number(invoice.amount_paid) + payment;
    const status = newPaid >= Number(invoice.total) ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid';

    const update = {
      amount_paid: newPaid,
      payment_method: payment_method || invoice.payment_method,
      status,
      paid_at: status === 'paid' ? new Date().toISOString() : invoice.paid_at,
    };
    const { data, error } = await supabase
      .from('invoices').update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not record payment');
  }
});

// =====================================================================
// SERVICES  (read-only for the frontend's invoice builder)
// =====================================================================
app.get('/services', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('services').select('*').eq('active', true).order('name', { ascending: true });
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load services');
  }
});

app.post('/services', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name) return fail(res, 400, 'name is required');
    const insert = {
      name: b.name,
      category: b.category || null,
      price: b.price ?? null,
      duration_mins: b.duration_mins ?? 30,
      description: b.description || null,
      active: b.active ?? true,
    };
    const { data, error } = await supabase.from('services').insert(insert).select().single();
    if (error) throw error;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not add service');
  }
});

// =====================================================================
// STAFF
// =====================================================================
// Open to any logged-in staff member (not just admin) — this is what the
// booking modal's doctor dropdown needs to work for receptionist/dentist.
app.get('/staff', requireStaff, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('staff').select('id, full_name, email, role, specialization, phone, status, created_at')
      .order('full_name', { ascending: true });
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load staff');
  }
});

app.post('/staff', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.full_name || !b.email || !b.password || !b.role) {
      return fail(res, 400, 'full_name, email, password and role are required');
    }
    const hashed = await bcrypt.hash(b.password, 10);
    const insert = {
      full_name: b.full_name,
      email: b.email,
      password: hashed,
      role: b.role,
      specialization: b.specialization || null,
      phone: b.phone || null,
    };
    const { data, error } = await supabase.from('staff').insert(insert).select().single();
    if (error) throw error;
    delete data.password;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not add staff — email may already be in use');
  }
});

app.patch('/staff/:id', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const update = {};
    if (b.status) update.status = b.status;
    if (b.role) update.role = b.role;
    if (b.specialization !== undefined) update.specialization = b.specialization;
    if (b.phone !== undefined) update.phone = b.phone;
    if (b.password) update.password = await bcrypt.hash(b.password, 10);

    const { data, error } = await supabase
      .from('staff').update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    delete data.password;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not update staff');
  }
});

// =====================================================================
// ANNOUNCEMENTS (bonus — not called by the current frontend, admin only)
// =====================================================================
app.get('/announcements', requireStaff, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('announcements').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load announcements');
  }
});

app.post('/announcements', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.message) return fail(res, 400, 'message is required');
    const insert = {
      title: b.title || null,
      message: b.message,
      target: b.target || 'all',
      created_by: req.user.id,
    };
    const { data, error } = await supabase.from('announcements').insert(insert).select().single();
    if (error) throw error;
    return ok(res, data, 201);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not create announcement');
  }
});

// =====================================================================
// AUDIT LOGS (bonus — admin only)
// =====================================================================
app.get('/audit-logs', requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    return ok(res, data);
  } catch (e) {
    console.error(e);
    return fail(res, 500, 'Could not load audit logs');
  }
});

// =====================================================================
// 404 + error fallback
// =====================================================================
app.use((req, res) => fail(res, 404, 'Not found'));

const port = PORT || 3000;
app.listen(port, () => console.log(`DentCare Pro API listening on port ${port}`));
