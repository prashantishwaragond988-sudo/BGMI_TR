require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const QRCode = require('qrcode');
const { sendAccountWelcomeEmail, sendTournamentRegistrationEmail, sendApprovalEmail } = require('./services/emailService');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CAPACITY = 25;
const fee = 50;
const JWT_TTL_SECONDS = 8 * 60 * 60;

function initFirebase() {
  if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
    throw new Error('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.');
  }
  const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey
  }) });
  return admin.firestore();
}
const db = initFirebase();
const users = db.collection('users');
const registrations = db.collection('registrations');
const registrationKeys = db.collection('registrationKeys');
const counters = db.collection('counters');

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], scriptSrc: ["'self'"], connectSrc: ["'self'"] } } }));
app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));
app.use(cookieParser());

const registrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many submissions. Please try again later.' } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' } });
const clean = v => String(v || '').trim();
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const validPhone = v => /^[+\d\s()-]{8,20}$/.test(v);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const timestamp = () => admin.firestore.FieldValue.serverTimestamp();
const emailDocId = email => sha(email.toLowerCase());

function signToken(claims) {
  return jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: JWT_TTL_SECONDS, issuer: 'sara-shadows-squad', audience: 'sara-shadows-web' });
}
function setAuthCookie(res, token) {
  res.cookie('sara_auth', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: JWT_TTL_SECONDS * 1000 });
}
function authRequired(req, res, next) {
  const token = req.cookies?.sara_auth;
  if (!token) return res.status(401).json({ error: 'Please log in to continue.' });
  try {
    req.auth = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'sara-shadows-squad', audience: 'sara-shadows-web' });
    return next();
  } catch { return res.status(401).json({ error: 'Your login has expired. Please log in again.' }); }
}
function adminOnly(req, res, next) {
  return authRequired(req, res, () => req.auth?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required.' }));
}
const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// Account registration/login. Email is sent through the configured Gmail SMTP service.
app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const name = clean(req.body?.name);
  const email = clean(req.body?.email).toLowerCase();
  const password = String(req.body?.password || '');
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Name must be between 2 and 80 characters.' });
  if (!validEmail(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Password must be 10 to 128 characters long.' });
  const userRef = users.doc(emailDocId(email));
  const passwordHash = await bcrypt.hash(password, 12);
  const user = { name, email, passwordHash, createdAt: timestamp() };
  try {
    await db.runTransaction(async tx => {
      const existing = await tx.get(userRef);
      if (existing.exists) { const err = new Error('EMAIL_EXISTS'); err.code = 'EMAIL_EXISTS'; throw err; }
      tx.create(userRef, user);
    });
  } catch (err) {
    if (err.code === 'EMAIL_EXISTS') return res.status(409).json({ error: 'An account with this email already exists.' });
    throw err;
  }
  let emailSent = false;
  try { emailSent = await sendAccountWelcomeEmail({ to: email, name }); }
  catch { /* Account creation is retained if the optional confirmation email fails. */ }
  const token = signToken({ sub: userRef.id, role: 'user', email });
  setAuthCookie(res, token);
  res.status(201).json({ ok: true, user: { name, email }, emailSent, emailNotice: emailSent ? undefined : 'Your account was created, but the confirmation email could not be sent. Please contact the organizer.' });
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const email = clean(req.body?.email).toLowerCase();
  const password = String(req.body?.password || '');
  if (!validEmail(email) || !password || password.length > 128) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const userRef = users.doc(emailDocId(email));
  const userSnap = await userRef.get();
  const user = userSnap.exists ? userSnap.data() : null;
  const passwordOk = await bcrypt.compare(password, user?.passwordHash || '$2a$12$zZyuZMFN4t5pyA9nRXXvqOeW3f/a3o.JQfqO6uM6ekjD3FSl14vCa');
  if (!user || !passwordOk) return res.status(401).json({ error: 'Incorrect email or password.' });
  setAuthCookie(res, signToken({ sub: userRef.id, role: 'user', email: user.email }));
  res.json({ ok: true, user: { name: user.name, email: user.email } });
}));
app.get('/api/auth/me', authRequired, asyncRoute(async (req, res) => {
  if (req.auth.role !== 'user') return res.status(403).json({ error: 'User account required.' });
  const snap = await users.doc(req.auth.sub).get();
  if (!snap.exists) return res.status(401).json({ error: 'Account no longer exists.' });
  const { name, email } = snap.data();
  res.json({ user: { name, email } });
}));
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('sara_auth', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' }); res.json({ ok: true }); });

app.get('/api/config', asyncRoute(async (_req, res) => {
  const snap = await registrations.select('registrationNumber').get();
  res.json({ fee, capacity: CAPACITY, registered: snap.size, upiId: process.env.UPI_ID || '', upiName: process.env.UPI_NAME || 'SARA SHADOWS SQUAD' });
}));
app.get('/api/upi-qr', asyncRoute(async (req, res) => {
  const id = process.env.UPI_ID;
  if (!id) return res.status(503).json({ error: 'Organizer UPI ID is not configured.' });
  const amount = Number(req.query.amount || fee);
  if (amount !== fee) return res.status(400).json({ error: 'Invalid amount.' });
  const payload = `upi://pay?pa=${encodeURIComponent(id)}&pn=${encodeURIComponent(process.env.UPI_NAME || 'SARA SHADOWS SQUAD')}&am=${fee}.00&cu=INR&tn=${encodeURIComponent('BGMI Tournament Entry')}`;
  res.json({ payload, image: await QRCode.toDataURL(payload, { width: 280, margin: 1, color: { dark: '#111111', light: '#ffffff' } }) });
}));

app.post('/api/registrations', registrationLimiter, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const squadName = clean(b.squadName);
  const squadKey = squadName.toLowerCase();
  const leaderName = clean(b.leaderName);
  const email = clean(b.email).toLowerCase();
  const whatsapp = clean(b.whatsapp);
  const transactionId = clean(b.transactionId).toUpperCase();
  const players = Array.isArray(b.players) ? b.players.map(p => ({ name: clean(p.name), characterId: clean(p.characterId) })) : [];
  const substitute = { name: clean(b.substitute?.name), characterId: clean(b.substitute?.characterId) };
  if (squadName.length < 2 || squadName.length > 40 || leaderName.length < 2 || leaderName.length > 80 || !validEmail(email) || !validPhone(whatsapp)) return res.status(400).json({ error: 'Please check your squad and team leader details.' });
  if (players.length !== 4 || players.some(p => !p.name || p.name.length > 60 || !p.characterId || p.characterId.length > 30)) return res.status(400).json({ error: 'Enter the name and BGMI Character ID for all four players.' });
  if ((substitute.name && !substitute.characterId) || (!substitute.name && substitute.characterId) || substitute.name.length > 60 || substitute.characterId.length > 30) return res.status(400).json({ error: 'Enter both substitute fields, or leave both blank.' });
  if (transactionId.length < 6 || transactionId.length > 40 || !/^[A-Z0-9-]+$/.test(transactionId) || !b.paymentConfirmed) return res.status(400).json({ error: 'Enter a valid UTR number and confirm payment.' });

  const utrRef = registrationKeys.doc(`utr_${sha(transactionId)}`);
  const squadRef = registrationKeys.doc(`squad_${sha(squadKey)}`);
  const counterRef = counters.doc('registration');
  let registrationNumber;
  try {
    await db.runTransaction(async tx => {
      const [all, counter, utr, squad] = await Promise.all([tx.get(registrations), tx.get(counterRef), tx.get(utrRef), tx.get(squadRef)]);
      if (all.size >= CAPACITY) { const err = new Error('CAPACITY_REACHED'); err.code = 'CAPACITY_REACHED'; throw err; }
      if (utr.exists) { const err = new Error('DUPLICATE_UTR'); err.code = 'DUPLICATE_UTR'; throw err; }
      if (squad.exists) { const err = new Error('DUPLICATE_SQUAD'); err.code = 'DUPLICATE_SQUAD'; throw err; }
      const seq = (counter.exists ? Number(counter.get('seq')) : 0) + 1;
      registrationNumber = `SSS-${String(seq).padStart(4, '0')}`;
      const regRef = registrations.doc(registrationNumber);
      tx.create(regRef, { registrationNumber, squadName, squadNameKey: squadKey, leaderName, email, whatsapp, players, substitute, transactionId, registrationDate: timestamp(), paymentStatus: 'PENDING', status: 'PENDING', emailSentAt: null, activity: [{ action: 'SUBMITTED', by: 'team leader', at: new Date().toISOString() }] });
      tx.create(utrRef, { registrationNumber, type: 'utr' });
      tx.create(squadRef, { registrationNumber, type: 'squad' });
      tx.set(counterRef, { seq }, { merge: true });
    });
  } catch (err) {
    if (err.code === 'CAPACITY_REACHED') return res.status(409).json({ error: 'All 25 squad slots have been filled.' });
    if (err.code === 'DUPLICATE_UTR') return res.status(409).json({ error: 'This UTR number has already been submitted.' });
    if (err.code === 'DUPLICATE_SQUAD') return res.status(409).json({ error: 'This squad name is already registered.' });
    throw err;
  }
  // Send only after Firestore commits; email failure must not undo registration.
  let emailSent = false;
  try {
    emailSent = await sendTournamentRegistrationEmail({
      to: email,
      participantName: leaderName,
      squadName,
      registrationNumber
    });
  } catch { /* Keep the committed registration if Gmail SMTP is unavailable. */ }
  res.status(201).json({
    ok: true,
    registrationNumber,
    emailSent,
    emailNotice: emailSent ? undefined : 'Registration saved, but the confirmation email could not be delivered. Please contact the organizer.'
  });
}));

// Tournament admin uses the existing username/password hash and the same signed JWT cookie.
app.post('/api/admin/login', authLimiter, asyncRoute(async (req, res) => {
  const usernameOk = clean(req.body?.username) === process.env.ADMIN_USERNAME;
  const hash = process.env.ADMIN_PASSWORD_HASH || '';
  const passwordOk = hash.startsWith('$2') && await bcrypt.compare(String(req.body?.password || ''), hash);
  if (!usernameOk || !passwordOk) return res.status(401).json({ error: 'Incorrect username or password.' });
  setAuthCookie(res, signToken({ sub: 'admin', role: 'admin' }));
  res.json({ ok: true });
}));
app.post('/api/admin/logout', adminOnly, (_req, res) => { res.clearCookie('sara_auth', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/' }); res.json({ ok: true }); });
app.get('/api/admin/me', adminOnly, (_req, res) => res.json({ ok: true }));
app.get('/api/admin/registrations', adminOnly, asyncRoute(async (_req, res) => {
  const snap = await registrations.orderBy('registrationDate', 'desc').get();
  const items = snap.docs.map(doc => ({ _id: doc.id, ...doc.data() }));
  const pending = items.filter(r => r.status === 'PENDING').length;
  const approved = items.filter(r => r.status === 'APPROVED').length;
  const rejected = items.filter(r => r.status === 'REJECTED').length;
  res.json({ items, stats: { total: items.length, pending, approved, rejected, available: Math.max(0, CAPACITY - items.length) } });
}));
app.post('/api/admin/registrations/:id/approve', adminOnly, asyncRoute(async (req, res) => {
  const regRef = registrations.doc(req.params.id);
  let reg;
  await db.runTransaction(async tx => {
    const snap = await tx.get(regRef);
    if (!snap.exists || snap.get('status') !== 'PENDING') return;
    reg = snap.data();
    tx.update(regRef, { status: 'APPROVED', paymentStatus: 'VERIFIED', activity: [...(reg.activity || []), { action: 'APPROVED', by: 'admin', at: new Date().toISOString() }] });
  });
  if (!reg) return res.status(409).json({ error: 'Registration is no longer pending.' });
  try {
    const sent = await sendApprovalEmail({ to: reg.email, participantName: reg.leaderName, squadName: reg.squadName, registrationNumber: reg.registrationNumber });
    if (sent) await regRef.update({ emailSentAt: timestamp(), activity: [...(reg.activity || []), { action: 'APPROVED', by: 'admin', at: new Date().toISOString() }, { action: 'APPROVAL_EMAIL_SENT', by: 'system', at: new Date().toISOString() }] });
    return res.json({ ok: true, emailSent: sent });
  } catch { return res.json({ ok: true, emailSent: false, emailError: 'Approval saved; email could not be delivered. Check Gmail SMTP settings and contact the team leader.' }); }
}));
app.post('/api/admin/registrations/:id/reject', adminOnly, asyncRoute(async (req, res) => {
  const regRef = registrations.doc(req.params.id);
  let changed = false;
  await db.runTransaction(async tx => {
    const snap = await tx.get(regRef);
    if (!snap.exists || snap.get('status') !== 'PENDING') return;
    const reg = snap.data();
    tx.update(regRef, { status: 'REJECTED', paymentStatus: 'REJECTED', activity: [...(reg.activity || []), { action: 'REJECTED', by: 'admin', at: new Date().toISOString() }] });
    changed = true;
  });
  if (!changed) return res.status(409).json({ error: 'Registration is no longer pending.' });
  res.json({ ok: true });
}));

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, _req, res, _next) => {
  console.error('Request error:', err.message);
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must contain valid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
  res.status(500).json({ error: 'The request could not be completed. Please try again.' });
});

function start() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET to a random value at least 32 characters long.');
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD_HASH) throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD_HASH.');
  app.listen(PORT, () => console.log(`SARA SHADOWS SQUAD running on port ${PORT}`));
}
try { start(); } catch (err) { console.error('Startup failed:', err.message); process.exit(1); }
