require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;

// -----------------------------------------------------
// DATABASE
// -----------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl:
    process.env.DB_SSL === 'true'
      ? { rejectUnauthorized: false }
      : false
});

const db = {
  query: (text, params) => pool.query(text, params)
};

// -----------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-api-key'
  );
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// -----------------------------------------------------
// HELPERS
// -----------------------------------------------------
const STAFF_ROLES = ['admin', 'dentist', 'receptionist', 'pharmacist', 'assistant'];

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + API_KEY).digest('hex');
}

function makeToken(payload, expSeconds = 60 * 60 * 24) {
  const body = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + expSeconds
  };
  return Buffer.from(JSON.stringify(body)).toString('base64');
}

function decodeToken(token) {
  try {
    const json = Buffer.from(token, 'base64').toString('utf8');
    const data = JSON.parse(json);
    if (!data || !data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch (e) {
    return null;
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

async function audit(req, action, entity, entity_id, old_value, new_value, description) {
  try {
    const actor = req.user || {};
    await db.query(
      `INSERT INTO audit_logs
        (action, entity, entity_id, actor_id, actor_name, actor_role, old_value, new_value, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        action,
        entity,
        entity_id || null,
        actor.id || null,
        actor.full_name || null,
        actor.role || null,
        old_value ? JSON.stringify(old_value) : null,
        new_value ? JSON.stringify(new_value) : null,
        description || null
      ]
    );
  } catch (e) {
    console.error('audit() failed:', e.message);
  }
}

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

// -----------------------------------------------------
// AUTH MIDDLEWARE
// -----------------------------------------------------

// Requires a valid Bearer token (staff or patient). Populates req.user.
function verifyToken(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return sendError(res, 401, 'Missing authorization token');
  const data = decodeToken(token);
  if (!data) return sendError(res, 401, 'Invalid or expired token');
  req.user = data;
  next();
}

// Allows either a valid API key (x-api-key header) OR a valid Bearer token.
function verifyAny(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && API_KEY && apiKey === API_KEY) {
    req.isApiKey = true;
    return next();
  }
  const token = getBearerToken(req);
  if (token) {
    const data = decodeToken(token);
    if (data) {
      req.user = data;
      return next();
    }
  }
  return sendError(res, 401, 'Missing or invalid credentials');
}

// Must be logged in as staff (any staff role, not a patient account).
function requireStaff(req, res, next) {
  if (!req.user || req.user.account_type !== 'staff') {
    return sendError(res, 403, 'Staff access only');
  }
  next();
}

// Must have one of the given roles. Admin is always allowed.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return sendError(res, 401, 'Authentication required');
    if (req.user.role === 'admin') return next();
    if (roles.includes(req.user.role)) return next();
    return sendError(res, 403, 'Insufficient permissions');
  };
}

// For routes with a :id patient param (or a patient_id resolvable field).
// Staff may pass through (route-specific role checks apply separately).
// Patients may only access their own record.
function canSeePatient(req, res, next) {
  if (!req.user) return sendError(res, 401, 'Authentication required');
  if (req.user.account_type === 'staff') return next();
  if (req.user.account_type === 'patient') {
    const paramId = req.params.id;
    if (String(req.user.patient_id) === String(paramId)) return next();
    return sendError(res, 403, 'You may only access your own records');
  }
  return sendError(res, 403, 'Access denied');
}

// -----------------------------------------------------
// HEALTH
// -----------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// -----------------------------------------------------
// AUTH ROUTES
// -----------------------------------------------------

// Create the first admin account. Requires the shared API_KEY as "secret".
app.post('/auth/setup', async (req, res) => {
  try {
    const { full_name, email, password, secret } = req.body;
    if (secret !== API_KEY) return sendError(res, 403, 'Invalid setup secret');
    if (!full_name || !email || !password) {
      return sendError(res, 400, 'full_name, email and password are required');
    }
    const existingAdmin = await db.query(
      `SELECT id FROM staff WHERE role = 'admin' LIMIT 1`
    );
    if (existingAdmin.rows.length > 0) {
      return sendError(res, 403, 'An admin already exists');
    }
    const hashed = hashPassword(password);
    const result = await db.query(
      `INSERT INTO staff (full_name, email, password, role, status)
       VALUES ($1,$2,$3,'admin','active')
       RETURNING id, full_name, email, role, status, created_at`,
      [full_name, email, hashed]
    );
    const admin = result.rows[0];
    req.user = { id: admin.id, full_name: admin.full_name, role: 'admin', account_type: 'staff' };
    await audit(req, 'create', 'staff', admin.id, null, admin, 'Initial admin setup');
    res.status(201).json({ staff: admin });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to set up admin');
  }
});

// Login. Checks staff table first, then patient_accounts.
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return sendError(res, 400, 'email and password are required');
    const hashed = hashPassword(password);

    const staffResult = await db.query(
      `SELECT id, full_name, email, password, role, status FROM staff WHERE email = $1`,
      [email]
    );
    if (staffResult.rows.length > 0) {
      const staffRow = staffResult.rows[0];
      if (staffRow.status !== 'active') return sendError(res, 403, 'Account is not active');
      if (staffRow.password !== hashed) return sendError(res, 401, 'Invalid credentials');
      const token = makeToken({
        id: staffRow.id,
        role: staffRow.role,
        account_type: 'staff',
        email: staffRow.email,
        patient_id: null,
        full_name: staffRow.full_name
      });
      return res.json({
        token,
        user: {
          id: staffRow.id,
          full_name: staffRow.full_name,
          email: staffRow.email,
          role: staffRow.role,
          account_type: 'staff'
        }
      });
    }

    const patientAcctResult = await db.query(
      `SELECT id, patient_id, full_name, email, password FROM patient_accounts WHERE email = $1`,
      [email]
    );
    if (patientAcctResult.rows.length > 0) {
      const acct = patientAcctResult.rows[0];
      if (acct.password !== hashed) return sendError(res, 401, 'Invalid credentials');
      const token = makeToken({
        id: acct.id,
        role: 'patient',
        account_type: 'patient',
        email: acct.email,
        patient_id: acct.patient_id,
        full_name: acct.full_name
      });
      return res.json({
        token,
        user: {
          id: acct.id,
          full_name: acct.full_name,
          email: acct.email,
          role: 'patient',
          account_type: 'patient',
          patient_id: acct.patient_id
        }
      });
    }

    return sendError(res, 401, 'Invalid credentials');
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Login failed');
  }
});

// -----------------------------------------------------
// STAFF ROUTES
// -----------------------------------------------------

// Any authenticated staff member can list staff; only admin sees full details.
app.get('/staff', verifyToken, requireStaff, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, full_name, email, role, specialization, phone, status, created_at
       FROM staff ORDER BY full_name ASC`
    );
    if (req.user.role === 'admin') {
      return res.json({ staff: result.rows });
    }
    const limited = result.rows.map((s) => ({
      id: s.id,
      full_name: s.full_name,
      role: s.role,
      specialization: s.specialization,
      status: s.status
    }));
    res.json({ staff: limited });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch staff');
  }
});

// Doctor dropdown for receptionist appointment booking.
app.get('/doctors', verifyToken, requireStaff, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, full_name, specialization, status
       FROM staff WHERE role = 'dentist' AND status = 'active'
       ORDER BY full_name ASC`
    );
    res.json({ doctors: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch doctors');
  }
});

app.post('/staff', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { full_name, email, password, role, specialization, phone, status } = req.body;
    if (!full_name || !email || !password || !role) {
      return sendError(res, 400, 'full_name, email, password and role are required');
    }
    if (!STAFF_ROLES.includes(role)) return sendError(res, 400, 'Invalid role');
    const hashed = hashPassword(password);
    const result = await db.query(
      `INSERT INTO staff (full_name, email, password, role, specialization, phone, status)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'active'))
       RETURNING id, full_name, email, role, specialization, phone, status, created_at`,
      [full_name, email, hashed, role, specialization || null, phone || null, status || null]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'staff', created.id, null, created, 'Staff created');
    res.status(201).json({ staff: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to create staff');
  }
});

app.patch('/staff/:id', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const before = await db.query('SELECT * FROM staff WHERE id = $1', [id]);
    if (before.rows.length === 0) return sendError(res, 404, 'Staff member not found');

    const fields = [];
    const values = [];
    let i = 1;
    const allowed = ['full_name', 'email', 'role', 'specialization', 'phone', 'status'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        values.push(req.body[key]);
      }
    }
    if (req.body.password) {
      fields.push(`password = $${i++}`);
      values.push(hashPassword(req.body.password));
    }
    if (fields.length === 0) return sendError(res, 400, 'No valid fields to update');
    values.push(id);
    const result = await db.query(
      `UPDATE staff SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, full_name, email, role, specialization, phone, status, created_at`,
      values
    );
    await audit(req, 'update', 'staff', id, before.rows[0], result.rows[0], 'Staff updated');
    res.json({ staff: result.rows[0] });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to update staff');
  }
});

app.delete('/staff/:id', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const before = await db.query('SELECT * FROM staff WHERE id = $1', [id]);
    if (before.rows.length === 0) return sendError(res, 404, 'Staff member not found');
    await db.query('DELETE FROM staff WHERE id = $1', [id]);
    await audit(req, 'delete', 'staff', id, before.rows[0], null, 'Staff deleted');
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to delete staff');
  }
});

// -----------------------------------------------------
// PATIENT ROUTES
// -----------------------------------------------------

app.get('/patients', verifyToken, async (req, res) => {
  try {
    if (req.user.account_type === 'patient') {
      const result = await db.query('SELECT * FROM patients WHERE id = $1', [req.user.patient_id]);
      return res.json({ patients: result.rows });
    }
    if (req.user.account_type !== 'staff') return sendError(res, 403, 'Access denied');
    const { search } = req.query;
    let query = 'SELECT * FROM patients';
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      query += ` WHERE full_name ILIKE $1 OR patient_id ILIKE $1 OR phone ILIKE $1`;
    }
    query += ' ORDER BY created_at DESC';
    const result = await db.query(query, params);
    res.json({ patients: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch patients');
  }
});

app.get('/patients/:id', verifyToken, canSeePatient, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return sendError(res, 404, 'Patient not found');
    res.json({ patient: result.rows[0] });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch patient');
  }
});

// staff or x-api-key can create a patient
app.post('/patients', verifyAny, async (req, res) => {
  try {
    if (req.user && req.user.account_type !== 'staff' && !req.isApiKey) {
      return sendError(res, 403, 'Staff access only');
    }
    const {
      full_name, date_of_birth, gender, blood_type, allergies,
      phone, email, address, emergency_name, emergency_phone
    } = req.body;
    if (!full_name) return sendError(res, 400, 'full_name is required');
    const result = await db.query(
      `INSERT INTO patients
        (full_name, date_of_birth, gender, blood_type, allergies, phone, email, address, emergency_name, emergency_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [full_name, date_of_birth || null, gender || null, blood_type || null, allergies || null,
        phone || null, email || null, address || null, emergency_name || null, emergency_phone || null]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'patients', created.id, null, created, 'Patient registered');
    res.status(201).json({ patient: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to create patient');
  }
});

app.patch('/patients/:id', verifyToken, requireStaff, async (req, res) => {
  try {
    const { id } = req.params;
    const before = await db.query('SELECT * FROM patients WHERE id = $1', [id]);
    if (before.rows.length === 0) return sendError(res, 404, 'Patient not found');

    const allowed = [
      'full_name', 'date_of_birth', 'gender', 'blood_type', 'allergies',
      'phone', 'email', 'address', 'emergency_name', 'emergency_phone', 'status'
    ];
    const fields = [];
    const values = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        values.push(req.body[key]);
      }
    }
    if (fields.length === 0) return sendError(res, 400, 'No valid fields to update');
    fields.push(`updated_at = NOW()`);
    values.push(id);
    const result = await db.query(
      `UPDATE patients SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    await audit(req, 'update', 'patients', id, before.rows[0], result.rows[0], 'Patient updated');
    res.json({ patient: result.rows[0] });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to update patient');
  }
});

// Create a patient portal account (login) for an existing patient.
app.post('/patients/:id/account', verifyToken, requireStaff, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, password, full_name, phone } = req.body;
    if (!email || !password) return sendError(res, 400, 'email and password are required');

    const patient = await db.query('SELECT * FROM patients WHERE id = $1', [id]);
    if (patient.rows.length === 0) return sendError(res, 404, 'Patient not found');

    const hashed = hashPassword(password);
    const result = await db.query(
      `INSERT INTO patient_accounts (patient_id, full_name, email, password, phone)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, patient_id, full_name, email, phone, created_at`,
      [id, full_name || patient.rows[0].full_name, email, hashed, phone || null]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'patient_accounts', created.id, null, created, 'Patient portal account created');
    res.status(201).json({ account: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to create patient account');
  }
});

// -----------------------------------------------------
// APPOINTMENTS
// -----------------------------------------------------

app.get('/appointments', verifyToken, async (req, res) => {
  try {
    const { patient_id, doctor_id, date, status } = req.query;
    let query = `SELECT a.*, p.full_name AS patient_name, p.patient_id AS patient_code,
                        s.full_name AS doctor_name
                 FROM appointments a
                 LEFT JOIN patients p ON p.id = a.patient_id
                 LEFT JOIN staff s ON s.id = a.doctor_id
                 WHERE 1=1`;
    const params = [];
    let i = 1;

    if (req.user.account_type === 'patient') {
      query += ` AND a.patient_id = $${i++}`;
      params.push(req.user.patient_id);
    } else if (req.user.role === 'dentist') {
      query += ` AND a.doctor_id = $${i++}`;
      params.push(req.user.id);
    }

    if (patient_id) {
      query += ` AND a.patient_id = $${i++}`;
      params.push(patient_id);
    }
    if (doctor_id) {
      query += ` AND a.doctor_id = $${i++}`;
      params.push(doctor_id);
    }
    if (date) {
      query += ` AND a.date = $${i++}`;
      params.push(date);
    }
    if (status) {
      query += ` AND a.status = $${i++}`;
      params.push(status);
    }
    query += ' ORDER BY a.date DESC, a.time DESC';

    const result = await db.query(query, params);
    res.json({ appointments: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch appointments');
  }
});

// staff, patient self-book, or x-api-key
app.post('/appointments', verifyAny, async (req, res) => {
  try {
    const { patient_id, doctor_id, date, time, treatment, notes, type } = req.body;
    if (!date || !time || !treatment) {
      return sendError(res, 400, 'date, time and treatment are required');
    }

    let finalPatientId = patient_id;
    if (req.user && req.user.account_type === 'patient') {
      finalPatientId = req.user.patient_id;
    }
    if (!finalPatientId) return sendError(res, 400, 'patient_id is required');

    const createdBy = req.user && req.user.account_type === 'staff' ? req.user.id : null;

    const result = await db.query(
      `INSERT INTO appointments (patient_id, doctor_id, date, time, treatment, notes, type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'booked'),$8)
       RETURNING *`,
      [finalPatientId, doctor_id || null, date, time, treatment, notes || null, type || null, createdBy]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'appointments', created.id, null, created, 'Appointment booked');
    res.status(201).json({ appointment: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to create appointment');
  }
});

app.patch('/appointments/:id', verifyToken, requireStaff, async (req, res) => {
  try {
    const { id } = req.params;
    const before = await db.query('SELECT * FROM appointments WHERE id = $1', [id]);
    if (before.rows.length === 0) return sendError(res, 404, 'Appointment not found');

    const allowed = ['doctor_id', 'date', 'time', 'treatment', 'notes', 'type', 'status'];
    const fields = [];
    const values = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        values.push(req.body[key]);
      }
    }
    if (fields.length === 0) return sendError(res, 400, 'No valid fields to update');
    values.push(id);
    const result = await db.query(
      `UPDATE appointments SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    await audit(req, 'update', 'appointments', id, before.rows[0], result.rows[0], 'Appointment updated');
    res.json({ appointment: result.rows[0] });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to update appointment');
  }
});

app.delete('/appointments/:id', verifyToken, requireRole('admin', 'receptionist'), async (req, res) => {
  try {
    const { id } = req.params;
    const before = await db.query('SELECT * FROM appointments WHERE id = $1', [id]);
    if (before.rows.length === 0) return sendError(res, 404, 'Appointment not found');
    await db.query('DELETE FROM appointments WHERE id = $1', [id]);
    await audit(req, 'delete', 'appointments', id, before.rows[0], null, 'Appointment deleted');
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to delete appointment');
  }
});

// -----------------------------------------------------
// DENTAL CHART
// -----------------------------------------------------

app.get('/patients/:id/chart', verifyToken, canSeePatient, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM dental_chart WHERE patient_id = $1 ORDER BY tooth_number ASC`,
      [req.params.id]
    );
    res.json({ chart: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch dental chart');
  }
});

app.post('/patients/:id/chart', verifyToken, requireRole('admin', 'dentist'), async (req, res) => {
  try {
    const { id } = req.params;
    const { tooth_number, condition, treatment_date, notes } = req.body;
    if (tooth_number === undefined || !condition) {
      return sendError(res, 400, 'tooth_number and condition are required');
    }
    const doctorId = req.user.role === 'dentist' ? req.user.id : (req.body.doctor_id || null);

    const result = await db.query(
      `INSERT INTO dental_chart (patient_id, tooth_number, condition, treatment_date, notes, doctor_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (patient_id, tooth_number)
       DO UPDATE SET condition = EXCLUDED.condition,
                     treatment_date = EXCLUDED.treatment_date,
                     notes = EXCLUDED.notes,
                     doctor_id = EXCLUDED.doctor_id,
                     updated_at = NOW()
       RETURNING *`,
      [id, tooth_number, condition, treatment_date || null, notes || null, doctorId]
    );
    const saved = result.rows[0];
    await audit(req, 'upsert', 'dental_chart', saved.id, null, saved, 'Dental chart updated');
    res.status(201).json({ chart_entry: saved });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to update dental chart');
  }
});

// -----------------------------------------------------
// MEDICAL RECORDS
// -----------------------------------------------------

app.get('/patients/:id/records', verifyToken, canSeePatient, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.*, s.full_name AS doctor_name
       FROM medical_records r
       LEFT JOIN staff s ON s.id = r.doctor_id
       WHERE r.patient_id = $1
       ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    res.json({ records: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch medical records');
  }
});

app.post('/patients/:id/records', verifyToken, requireRole('admin', 'dentist'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      appointment_id, diagnosis, treatment_done, treatment_plan, notes,
      bp, temperature, pulse, weight, oxygen
    } = req.body;
    const doctorId = req.user.role === 'dentist' ? req.user.id : (req.body.doctor_id || null);

    const result = await db.query(
      `INSERT INTO medical_records
        (patient_id, appointment_id, doctor_id, diagnosis, treatment_done, treatment_plan, notes, bp, temperature, pulse, weight, oxygen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [id, appointment_id || null, doctorId, diagnosis || null, treatment_done || null,
        treatment_plan || null, notes || null, bp || null, temperature || null, pulse || null,
        weight || null, oxygen || null]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'medical_records', created.id, null, created, 'Medical record added');
    res.status(201).json({ record: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to create medical record');
  }
});

// -----------------------------------------------------
// X-RAYS
// -----------------------------------------------------

app.get('/patients/:id/xrays', verifyToken, canSeePatient, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT x.*, s.full_name AS doctor_name
       FROM xrays x
       LEFT JOIN staff s ON s.id = x.doctor_id
       WHERE x.patient_id = $1
       ORDER BY x.created_at DESC`,
      [req.params.id]
    );
    res.json({ xrays: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch x-rays');
  }
});

app.post('/patients/:id/xrays', verifyToken, requireRole('admin', 'dentist'), async (req, res) => {
  try {
    const { id } = req.params;
    const { tooth_number, type, file_url, findings, status } = req.body;
    const doctorId = req.user.role === 'dentist' ? req.user.id : (req.body.doctor_id || null);

    const result = await db.query(
      `INSERT INTO xrays (patient_id, tooth_number, type, file_url, findings, doctor_id, status)
       VALUES ($1,$2,COALESCE($3,'other'),$4,$5,$6,COALESCE($7,'pending'))
       RETURNING *`,
      [id, tooth_number || null, type || null, file_url || null, findings || null, doctorId, status || null]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'xrays', created.id, null, created, 'X-ray added');
    res.status(201).json({ xray: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to add x-ray');
  }
});

// -----------------------------------------------------
// PRESCRIPTIONS
// -----------------------------------------------------

app.get('/prescriptions', verifyToken, async (req, res) => {
  try {
    let query = `SELECT p.*, pt.full_name AS patient_name, pt.patient_id AS patient_code,
                        s.full_name AS doctor_name
                 FROM prescriptions p
                 LEFT JOIN patients pt ON pt.id = p.patient_id
                 LEFT JOIN staff s ON s.id = p.doctor_id
                 WHERE 1=1`;
    const params = [];
    let i = 1;

    if (req.user.account_type === 'patient') {
      query += ` AND p.patient_id = $${i++}`;
      params.push(req.user.patient_id);
    } else if (req.user.role === 'dentist') {
      query += ` AND p.doctor_id = $${i++}`;
      params.push(req.user.id);
    }

    const { status, patient_id } = req.query;
    if (status) {
      query += ` AND p.status = $${i++}`;
      params.push(status);
    }
    if (patient_id) {
      query += ` AND p.patient_id = $${i++}`;
      params.push(patient_id);
    }
    query += ' ORDER BY p.created_at DESC';

    const result = await db.query(query, params);
    res.json({ prescriptions: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch prescriptions');
  }
});

app.post('/patients/:id/prescriptions', verifyToken, requireRole('admin', 'dentist'), async (req, res) => {
  try {
    const { id } = req.params;
    const { appointment_id, drug_name, dosage, frequency, duration, notes } = req.body;
    if (!drug_name || !dosage || !frequency || !duration) {
      return sendError(res, 400, 'drug_name, dosage, frequency and duration are required');
    }
    const doctorId = req.user.role === 'dentist' ? req.user.id : (req.body.doctor_id || null);

    const result = await db.query(
      `INSERT INTO prescriptions (patient_id, doctor_id, appointment_id, drug_name, dosage, frequency, duration, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [id, doctorId, appointment_id || null, drug_name, dosage, frequency, duration, notes || null]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'prescriptions', created.id, null, created, 'Prescription created');
    res.status(201).json({ prescription: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to create prescription');
  }
});

app.patch('/prescriptions/:id/dispense', verifyToken, requireRole('admin', 'pharmacist'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await client.query('SELECT * FROM prescriptions WHERE id = $1', [req.params.id]);
    if (before.rows.length === 0) {
      await client.query('ROLLBACK');
      return sendError(res, 404, 'Prescription not found');
    }
    const prescription = before.rows[0];
    if (prescription.status === 'dispensed') {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'Prescription already dispensed');
    }

    // Optionally decrement drug stock if a matching drug record exists.
    const drugResult = await client.query(
      `SELECT * FROM drugs WHERE name = $1 LIMIT 1`,
      [prescription.drug_name]
    );
    if (drugResult.rows.length > 0) {
      await client.query(
        `UPDATE drugs SET stock = GREATEST(stock - 1, 0) WHERE id = $1`,
        [drugResult.rows[0].id]
      );
    }

    const result = await client.query(
      `UPDATE prescriptions
       SET status = 'dispensed', dispensed_by = $1, dispensed_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.user.id, req.params.id]
    );
    await client.query('COMMIT');
    await audit(req, 'update', 'prescriptions', req.params.id, prescription, result.rows[0], 'Prescription dispensed');
    res.json({ prescription: result.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    sendError(res, 500, 'Failed to dispense prescription');
  } finally {
    client.release();
  }
});

// -----------------------------------------------------
// DRUGS / PHARMACY
// -----------------------------------------------------

app.get('/drugs', verifyToken, requireStaff, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM drugs ORDER BY name ASC');
    res.json({ drugs: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch drugs');
  }
});

app.post('/drugs', verifyToken, requireRole('admin', 'pharmacist'), async (req, res) => {
  try {
    const { name, category, unit, stock, min_stock, price, expiry_date, supplier, status } = req.body;
    if (!name) return sendError(res, 400, 'name is required');
    const result = await db.query(
      `INSERT INTO drugs (name, category, unit, stock, min_stock, price, expiry_date, supplier, status)
       VALUES ($1,$2,COALESCE($3,'tablet'),COALESCE($4,0),COALESCE($5,10),$6,$7,$8,COALESCE($9,'active'))
       RETURNING *`,
      [name, category || null, unit || null, stock, min_stock, price || null,
        expiry_date || null, supplier || null, status || null]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'drugs', created.id, null, created, 'Drug added');
    res.status(201).json({ drug: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to create drug');
  }
});

app.patch('/drugs/:id', verifyToken, requireRole('admin', 'pharmacist'), async (req, res) => {
  try {
    const { id } = req.params;
    const before = await db.query('SELECT * FROM drugs WHERE id = $1', [id]);
    if (before.rows.length === 0) return sendError(res, 404, 'Drug not found');

    const allowed = ['name', 'category', 'unit', 'stock', 'min_stock', 'price', 'expiry_date', 'supplier', 'status'];
    const fields = [];
    const values = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        values.push(req.body[key]);
      }
    }
    if (fields.length === 0) return sendError(res, 400, 'No valid fields to update');
    values.push(id);
    const result = await db.query(
      `UPDATE drugs SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    await audit(req, 'update', 'drugs', id, before.rows[0], result.rows[0], 'Drug updated');
    res.json({ drug: result.rows[0] });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to update drug');
  }
});

// -----------------------------------------------------
// SERVICES
// -----------------------------------------------------

app.get('/services', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM services WHERE active = TRUE ORDER BY name ASC');
    res.json({ services: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch services');
  }
});

app.post('/services', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { name, category, price, duration_mins, description, active } = req.body;
    if (!name) return sendError(res, 400, 'name is required');
    const result = await db.query(
      `INSERT INTO services (name, category, price, duration_mins, description, active)
       VALUES ($1,$2,$3,COALESCE($4,30),$5,COALESCE($6,TRUE))
       RETURNING *`,
      [name, category || null, price || null, duration_mins, description || null, active]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'services', created.id, null, created, 'Service created');
    res.status(201).json({ service: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to create service');
  }
});

app.patch('/services/:id', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const before = await db.query('SELECT * FROM services WHERE id = $1', [id]);
    if (before.rows.length === 0) return sendError(res, 404, 'Service not found');

    const allowed = ['name', 'category', 'price', 'duration_mins', 'description', 'active'];
    const fields = [];
    const values = [];
    let i = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${i++}`);
        values.push(req.body[key]);
      }
    }
    if (fields.length === 0) return sendError(res, 400, 'No valid fields to update');
    values.push(id);
    const result = await db.query(
      `UPDATE services SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    await audit(req, 'update', 'services', id, before.rows[0], result.rows[0], 'Service updated');
    res.json({ service: result.rows[0] });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to update service');
  }
});

// -----------------------------------------------------
// INVOICES
// -----------------------------------------------------

app.get('/invoices', verifyToken, async (req, res) => {
  try {
    let query = `SELECT i.*, p.full_name AS patient_name, p.patient_id AS patient_code
                 FROM invoices i
                 LEFT JOIN patients p ON p.id = i.patient_id
                 WHERE 1=1`;
    const params = [];
    let i = 1;

    if (req.user.account_type === 'patient') {
      query += ` AND i.patient_id = $${i++}`;
      params.push(req.user.patient_id);
    } else if (req.user.account_type !== 'staff') {
      return sendError(res, 403, 'Access denied');
    }

    const { status, patient_id } = req.query;
    if (status) {
      query += ` AND i.status = $${i++}`;
      params.push(status);
    }
    if (patient_id) {
      query += ` AND i.patient_id = $${i++}`;
      params.push(patient_id);
    }
    query += ' ORDER BY i.created_at DESC';

    const result = await db.query(query, params);
    res.json({ invoices: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch invoices');
  }
});

app.get('/invoices/:id', verifyToken, async (req, res) => {
  try {
    const invoiceResult = await db.query(
      `SELECT i.*, p.full_name AS patient_name, p.patient_id AS patient_code
       FROM invoices i
       LEFT JOIN patients p ON p.id = i.patient_id
       WHERE i.id = $1`,
      [req.params.id]
    );
    if (invoiceResult.rows.length === 0) return sendError(res, 404, 'Invoice not found');
    const invoice = invoiceResult.rows[0];

    if (req.user.account_type === 'patient' && String(invoice.patient_id) !== String(req.user.patient_id)) {
      return sendError(res, 403, 'Access denied');
    }
    if (req.user.account_type !== 'staff' && req.user.account_type !== 'patient') {
      return sendError(res, 403, 'Access denied');
    }

    const itemsResult = await db.query(
      'SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id ASC',
      [req.params.id]
    );
    res.json({ invoice, items: itemsResult.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch invoice');
  }
});

app.post('/invoices', verifyToken, requireRole('admin', 'receptionist'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { patient_id, appointment_id, discount, payment_method, notes, items } = req.body;
    if (!patient_id) {
      await client.query('ROLLBACK');
      return sendError(res, 400, 'patient_id is required');
    }

    const itemList = Array.isArray(items) ? items : [];
    let subtotal = 0;
    for (const item of itemList) {
      const qty = item.quantity || 1;
      const unitPrice = item.unit_price || 0;
      subtotal += qty * unitPrice;
    }
    const discountVal = discount || 0;
    const total = subtotal - discountVal;

    const invoiceResult = await client.query(
      `INSERT INTO invoices (patient_id, appointment_id, subtotal, discount, total, payment_method, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [patient_id, appointment_id || null, subtotal, discountVal, total, payment_method || null, notes || null, req.user.id]
    );
    const invoice = invoiceResult.rows[0];

    const savedItems = [];
    for (const item of itemList) {
      const qty = item.quantity || 1;
      const unitPrice = item.unit_price || 0;
      const itemTotal = qty * unitPrice;
      const itemResult = await client.query(
        `INSERT INTO invoice_items (invoice_id, service, quantity, unit_price, total)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [invoice.id, item.service || null, qty, unitPrice, itemTotal]
      );
      savedItems.push(itemResult.rows[0]);
    }

    await client.query('COMMIT');
    await audit(req, 'create', 'invoices', invoice.id, null, invoice, 'Invoice created');
    res.status(201).json({ invoice, items: savedItems });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    sendError(res, 500, 'Failed to create invoice');
  } finally {
    client.release();
  }
});

app.patch('/invoices/:id/payment', verifyToken, requireRole('admin', 'receptionist'), async (req, res) => {
  try {
    const { id } = req.params;
    const { amount_paid, payment_method } = req.body;
    if (amount_paid === undefined) return sendError(res, 400, 'amount_paid is required');

    const before = await db.query('SELECT * FROM invoices WHERE id = $1', [id]);
    if (before.rows.length === 0) return sendError(res, 404, 'Invoice not found');
    const invoice = before.rows[0];

    const newAmountPaid = Number(invoice.amount_paid) + Number(amount_paid);
    const newStatus = newAmountPaid >= Number(invoice.total) ? 'paid' : 'partial';

    const result = await db.query(
      `UPDATE invoices
       SET amount_paid = $1, status = $2, payment_method = COALESCE($3, payment_method),
           paid_at = CASE WHEN $2 = 'paid' THEN NOW() ELSE paid_at END
       WHERE id = $4
       RETURNING *`,
      [newAmountPaid, newStatus, payment_method || null, id]
    );
    await audit(req, 'update', 'invoices', id, invoice, result.rows[0], 'Payment recorded');
    res.json({ invoice: result.rows[0] });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to record payment');
  }
});

// -----------------------------------------------------
// ANNOUNCEMENTS
// -----------------------------------------------------

app.get('/announcements', verifyToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT a.*, s.full_name AS created_by_name
       FROM announcements a
       LEFT JOIN staff s ON s.id = a.created_by
       ORDER BY a.created_at DESC`
    );
    res.json({ announcements: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch announcements');
  }
});

app.post('/announcements', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { title, message, target } = req.body;
    if (!message) return sendError(res, 400, 'message is required');
    const result = await db.query(
      `INSERT INTO announcements (title, message, target, created_by)
       VALUES ($1,$2,COALESCE($3,'all'),$4)
       RETURNING *`,
      [title || null, message, target || null, req.user.id]
    );
    const created = result.rows[0];
    await audit(req, 'create', 'announcements', created.id, null, created, 'Announcement posted');
    res.status(201).json({ announcement: created });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to create announcement');
  }
});

// -----------------------------------------------------
// STATS
// -----------------------------------------------------

app.get('/stats', verifyToken, async (req, res) => {
  try {
    const role = req.user.role;

    if (role === 'admin' || role === 'receptionist') {
      const [patients, apptsToday, revenueToday, lowStock, outstanding] = await Promise.all([
        db.query('SELECT COUNT(*)::int AS count FROM patients'),
        db.query('SELECT COUNT(*)::int AS count FROM appointments WHERE date = CURRENT_DATE'),
        db.query(
          `SELECT COALESCE(SUM(amount_paid),0)::numeric AS total
           FROM invoices WHERE paid_at::date = CURRENT_DATE`
        ),
        db.query('SELECT COUNT(*)::int AS count FROM drugs WHERE stock <= min_stock'),
        db.query(`SELECT COUNT(*)::int AS count FROM invoices WHERE status != 'paid'`)
      ]);
      return res.json({
        role,
        total_patients: patients.rows[0].count,
        appointments_today: apptsToday.rows[0].count,
        revenue_today: revenueToday.rows[0].total,
        low_stock_drugs: lowStock.rows[0].count,
        outstanding_invoices: outstanding.rows[0].count
      });
    }

    if (role === 'dentist') {
      const [apptsToday, pendingXrays, recordsCount] = await Promise.all([
        db.query(
          'SELECT COUNT(*)::int AS count FROM appointments WHERE doctor_id = $1 AND date = CURRENT_DATE',
          [req.user.id]
        ),
        db.query(
          `SELECT COUNT(*)::int AS count FROM xrays WHERE doctor_id = $1 AND status = 'pending'`,
          [req.user.id]
        ),
        db.query('SELECT COUNT(*)::int AS count FROM medical_records WHERE doctor_id = $1', [req.user.id])
      ]);
      return res.json({
        role,
        appointments_today: apptsToday.rows[0].count,
        pending_xrays: pendingXrays.rows[0].count,
        records_count: recordsCount.rows[0].count
      });
    }

    if (role === 'pharmacist') {
      const [pendingRx, lowStock, totalDrugs] = await Promise.all([
        db.query(`SELECT COUNT(*)::int AS count FROM prescriptions WHERE status = 'pending'`),
        db.query('SELECT COUNT(*)::int AS count FROM drugs WHERE stock <= min_stock'),
        db.query('SELECT COUNT(*)::int AS count FROM drugs')
      ]);
      return res.json({
        role,
        pending_prescriptions: pendingRx.rows[0].count,
        low_stock_drugs: lowStock.rows[0].count,
        total_drugs: totalDrugs.rows[0].count
      });
    }

    if (role === 'patient') {
      const [appts, invoices, pendingRx] = await Promise.all([
        db.query('SELECT COUNT(*)::int AS count FROM appointments WHERE patient_id = $1', [req.user.patient_id]),
        db.query(
          `SELECT COALESCE(SUM(total - amount_paid),0)::numeric AS balance
           FROM invoices WHERE patient_id = $1 AND status != 'paid'`,
          [req.user.patient_id]
        ),
        db.query(
          `SELECT COUNT(*)::int AS count FROM prescriptions WHERE patient_id = $1 AND status = 'pending'`,
          [req.user.patient_id]
        )
      ]);
      return res.json({
        role,
        appointments_count: appts.rows[0].count,
        balance: invoices.rows[0].balance,
        pending_prescriptions: pendingRx.rows[0].count
      });
    }

    // assistant or unknown staff role - basic info only
    return res.json({ role, message: 'No specific dashboard stats configured for this role' });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch stats');
  }
});

// -----------------------------------------------------
// AUDIT LOGS
// -----------------------------------------------------

app.get('/audit-logs', verifyToken, requireRole('admin'), async (req, res) => {
  try {
    const { entity, actor_id, limit } = req.query;
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    let i = 1;
    if (entity) {
      query += ` AND entity = $${i++}`;
      params.push(entity);
    }
    if (actor_id) {
      query += ` AND actor_id = $${i++}`;
      params.push(actor_id);
    }
    query += ' ORDER BY created_at DESC';
    query += ` LIMIT $${i++}`;
    params.push(limit ? parseInt(limit, 10) : 200);

    const result = await db.query(query, params);
    res.json({ audit_logs: result.rows });
  } catch (e) {
    console.error(e);
    sendError(res, 500, 'Failed to fetch audit logs');
  }
});

// -----------------------------------------------------
// 404 + ERROR HANDLERS
// -----------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// -----------------------------------------------------
// START SERVER
// -----------------------------------------------------
app.listen(PORT, () => {
  console.log(`DentCare Pro server running on port ${PORT}`);
});

module.exports = app;
