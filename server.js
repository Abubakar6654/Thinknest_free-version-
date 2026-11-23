require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Database = require('better-sqlite3');

const {
  PORT = 3000, JWT_SECRET, PAYSTACK_SECRET_KEY, ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = 'claude-sonnet-5-5', FRONTEND_URL = '*',
  ADMIN_EMAIL, ADMIN_PASSWORD, DB_PATH = 'thinknest.db',
} = process.env;
if (!JWT_SECRET) { console.error('Set JWT_SECRET in .env'); process.exit(1); }

const PREMIUM_KOBO = 499900;          // ₦4,999
const PLAN_DAYS = 30;
const FREE_TUTOR_PER_DAY = 5;

// ───────────── DATABASE ─────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('student','parent','teacher','admin')),
  parent_id INTEGER REFERENCES users(id), age INTEGER, class_level TEXT, goals TEXT,
  plan TEXT NOT NULL DEFAULT 'free', plan_expires TEXT,
  points INTEGER NOT NULL DEFAULT 0, streak INTEGER NOT NULL DEFAULT 0, last_active TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS subjects(
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, created_by INTEGER REFERENCES users(id));
CREATE TABLE IF NOT EXISTS lessons(
  id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id), class_level TEXT NOT NULL,
  topic TEXT, title TEXT NOT NULL, body TEXT NOT NULL, author_id INTEGER REFERENCES users(id),
  premium INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS quizzes(
  id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id), lesson_id INTEGER REFERENCES lessons(id),
  class_level TEXT NOT NULL, title TEXT NOT NULL, is_diagnostic INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS questions(
  id INTEGER PRIMARY KEY, quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN('multiple_choice','short_answer')), prompt TEXT NOT NULL,
  options TEXT, answer TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), quiz_id INTEGER NOT NULL REFERENCES quizzes(id),
  subject_id INTEGER NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS completed_lessons(
  user_id INTEGER NOT NULL, lesson_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id, lesson_id));
CREATE TABLE IF NOT EXISTS badges(user_id INTEGER NOT NULL, badge TEXT NOT NULL, PRIMARY KEY(user_id, badge));
CREATE TABLE IF NOT EXISTS tutor_usage(user_id INTEGER NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS brain_days(user_id INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY(user_id, day));
CREATE TABLE IF NOT EXISTS payments(
  reference TEXT PRIMARY KEY, payer_id INTEGER NOT NULL REFERENCES users(id), beneficiary_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
for (const s of ['Mathematics', 'English Language', 'Basic Science', 'Social Studies'])
  db.prepare('INSERT OR IGNORE INTO subjects(name,is_default) VALUES(?,1)').run(s);
if (ADMIN_EMAIL && ADMIN_PASSWORD)
  db.prepare(`INSERT OR IGNORE INTO users(name,email,password_hash,role) VALUES('Admin',?,?,'admin')`)
    .run(ADMIN_EMAIL.toLowerCase(), bcrypt.hashSync(ADMIN_PASSWORD, 10));

// ───────────── HELPERS ─────────────
const today = () => new Date().toISOString().slice(0, 10);
const level = (pts) => Math.floor(pts / 100) + 1;
const isPremium = (u) => u.plan === 'premium' && u.plan_expires && new Date(u.plan_expires) > new Date();
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, age: u.age, class_level: u.class_level,
  goals: u.goals, plan: isPremium(u) ? 'premium' : 'free', plan_expires: u.plan_expires,
  points: u.points, level: level(u.points), streak: u.streak });
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
const str = (v, max = 5000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function touchStreak(uid) {
  const u = getUser(uid), t = today();
  if (u.last_active === t) return;
  const y = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  db.prepare('UPDATE users SET streak=?, last_active=? WHERE id=?').run(u.last_active === y ? u.streak + 1 : 1, t, uid);
  if (u.last_active === y && u.streak + 1 >= 7) giveBadge(uid, 'Streak Master');
}
function giveBadge(uid, badge) { db.prepare('INSERT OR IGNORE INTO badges(user_id,badge) VALUES(?,?)').run(uid, badge); }
function award(uid, pts) { db.prepare('UPDATE users SET points=points+? WHERE id=?').run(pts, uid); touchStreak(uid); }

// ───────────── APP + AUTH ─────────────
const app = express();
app.set('trust proxy', 1);   // correct https/host behind Render's proxy
app.use(cors({ origin: FRONTEND_URL === '*' ? true : FRONTEND_URL.split(',') }));

// Paystack webhook needs the RAW body, so it is registered before express.json()
app.post('/api/webhooks/paystack', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.get('x-paystack-signature') || '';
  const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY || '').update(req.body).digest('hex');
  if (!PAYSTACK_SECRET_KEY || sig.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hash))) return res.sendStatus(401);
  const evt = JSON.parse(req.body.toString());
  if (evt.event === 'charge.success') activatePayment(evt.data.reference, evt.data.amount, evt.data.status);
  res.sendStatus(200);
});
app.use(express.json({ limit: '200kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120 }));
app.use('/api/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 30 }));

const sign = (u) => jwt.sign({ id: u.id, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
const auth = (...roles) => (req, res, next) => {
  try {
    const t = (req.get('authorization') || '').replace(/^Bearer /, '');
    const p = jwt.verify(t, JWT_SECRET);
    const u = getUser(p.id);
    if (!u) return bad(res, 'Unauthorized', 401);
    if (roles.length && !roles.includes(u.role)) return bad(res, 'Forbidden', 403);
    req.user = u; next();
  } catch { bad(res, 'Unauthorized', 401); }
};

app.post('/api/auth/register', wrap((req, res) => {
  const { role = 'student' } = req.body;
  const name = str(req.body.name, 100), email = str(req.body.email, 200).toLowerCase(), password = str(req.body.password, 200);
  if (!['student', 'parent', 'teacher'].includes(role)) return bad(res, 'Invalid role');
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) return bad(res, 'Name, valid email and 8+ char password required');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return bad(res, 'Email already registered', 409);
  const r = db.prepare('INSERT INTO users(name,email,password_hash,role,age,class_level,goals) VALUES(?,?,?,?,?,?,?)')
    .run(name, email, bcrypt.hashSync(password, 10), role, Number(req.body.age) || null, str(req.body.class_level, 30), str(req.body.goals, 500));
  const u = getUser(r.lastInsertRowid);
  res.status(201).json({ token: sign(u), user: publicUser(u) });
}));

app.post('/api/auth/login', wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(str(req.body.email, 200).toLowerCase());
  if (!u || !bcrypt.compareSync(str(req.body.password, 200), u.password_hash)) return bad(res, 'Invalid email or password', 401);
  res.json({ token: sign(u), user: publicUser(u) });
}));

app.get('/api/me', auth(), (req, res) => res.json(publicUser(req.user)));
app.patch('/api/me', auth(), (req, res) => {
  db.prepare('UPDATE users SET age=?, class_level=?, goals=? WHERE id=?')
    .run(Number(req.body.age) || req.user.age, str(req.body.class_level, 30) || req.user.class_level, str(req.body.goals, 500) || req.user.goals, req.user.id);
  res.json(publicUser(getUser(req.user.id)));
});

// ── Parent → child profiles
app.post('/api/children', auth('parent'), wrap((req, res) => {
  const name = str(req.body.name, 100), email = str(req.body.email, 200).toLowerCase(), password = str(req.body.password, 200);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) return bad(res, 'Name, valid email and 8+ char password required');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) return bad(res, 'Email already registered', 409);
  const r = db.prepare(`INSERT INTO users(name,email,password_hash,role,parent_id,age,class_level,goals) VALUES(?,?,?,'student',?,?,?,?)`)
    .run(name, email, bcrypt.hashSync(password, 10), req.user.id, Number(req.body.age) || null, str(req.body.class_level, 30), str(req.body.goals, 500));
  res.status(201).json(publicUser(getUser(r.lastInsertRowid)));
}));
app.get('/api/children', auth('parent'), (req, res) =>
  res.json(db.prepare('SELECT * FROM users WHERE parent_id=?').all(req.user.id).map(publicUser)));

// ── Progress (self, or a parent's child)
function progressFor(uid) {
  const u = getUser(uid);
  const lessons = db.prepare('SELECT COUNT(*) c FROM completed_lessons WHERE user_id=?').get(uid).c;
  const bySubject = db.prepare(`SELECT s.name subject, ROUND(100.0*SUM(a.score)/SUM(a.total)) accuracy, COUNT(*) attempts
    FROM attempts a JOIN subjects s ON s.id=a.subject_id WHERE a.user_id=? GROUP BY s.id ORDER BY accuracy`).all(uid);
  const recent = db.prepare('SELECT quiz_id, score, total, created_at FROM attempts WHERE user_id=? ORDER BY id DESC LIMIT 20').all(uid);
  return { user: publicUser(u), lessons_completed: lessons, subjects: bySubject,
    strengths: bySubject.filter((s) => s.accuracy >= 75).map((s) => s.subject), weaknesses: bySubject.filter((s) => s.accuracy < 60).map((s) => s.subject),
    badges: db.prepare('SELECT badge FROM badges WHERE user_id=?').all(uid).map((b) => b.badge), recent_quizzes: recent };
}
app.get('/api/progress', auth('student'), (req, res) => res.json(progressFor(req.user.id)));
app.get('/api/children/:id/progress', auth('parent'), (req, res) => {
  const c = getUser(req.params.id);
  if (!c || c.parent_id !== req.user.id) return bad(res, 'Not found', 404);
  res.json(progressFor(c.id));
});

// ───────────── SUBJECTS / LESSONS / QUIZZES ─────────────
app.get('/api/subjects', auth(), (req, res) => res.json(db.prepare('SELECT * FROM subjects ORDER BY is_default DESC, name').all()));
app.post('/api/subjects', auth('teacher', 'admin'), (req, res) => {
  const name = str(req.body.name, 80);
  if (!name) return bad(res, 'Name required');
  try { res.status(201).json({ id: db.prepare('INSERT INTO subjects(name,created_by) VALUES(?,?)').run(name, req.user.id).lastInsertRowid, name }); }
  catch { bad(res, 'Subject exists', 409); }
});

app.get('/api/lessons', auth(), (req, res) => {
  const { subject_id, class_level, mine } = req.query;
  let sql = 'SELECT l.id,l.subject_id,l.class_level,l.topic,l.title,l.premium,l.status,l.author_id FROM lessons l WHERE 1=1';
  const p = [];
  if (req.user.role === 'teacher' && mine) { sql += ' AND l.author_id=?'; p.push(req.user.id); }
  else if (req.user.role !== 'admin') sql += " AND l.status='approved'";
  if (subject_id) { sql += ' AND l.subject_id=?'; p.push(subject_id); }
  if (class_level) { sql += ' AND l.class_level=?'; p.push(class_level); }
  res.json(db.prepare(sql + ' ORDER BY l.id').all(...p));
});
app.get('/api/lessons/:id', auth(), (req, res) => {
  const l = db.prepare('SELECT * FROM lessons WHERE id=?').get(req.params.id);
  const owner = l && (req.user.role === 'admin' || l.author_id === req.user.id);
  if (!l || (l.status !== 'approved' && !owner)) return bad(res, 'Not found', 404);
  if (l.premium && !owner && !isPremium(req.user) && req.user.role === 'student') return bad(res, 'Premium content — upgrade to unlock', 402);
  res.json(l);
});
app.post('/api/lessons', auth('teacher', 'admin'), (req, res) => {
  const { subject_id, class_level, title, body } = req.body;
  if (!subject_id || !str(class_level, 30) || !str(title, 200) || !str(body, 50000)) return bad(res, 'subject_id, class_level, title, body required');
  const r = db.prepare('INSERT INTO lessons(subject_id,class_level,topic,title,body,author_id,premium,status) VALUES(?,?,?,?,?,?,?,?)')
    .run(subject_id, str(class_level, 30), str(req.body.topic, 100), str(title, 200), str(body, 50000), req.user.id, req.body.premium ? 1 : 0,
      req.user.role === 'admin' ? 'approved' : 'pending');
  res.status(201).json({ id: r.lastInsertRowid, status: req.user.role === 'admin' ? 'approved' : 'pending' });
});
app.put('/api/lessons/:id', auth('teacher', 'admin'), (req, res) => {
  const l = db.prepare('SELECT * FROM lessons WHERE id=?').get(req.params.id);
  if (!l || (req.user.role !== 'admin' && l.author_id !== req.user.id)) return bad(res, 'Not found', 404);
  db.prepare(`UPDATE lessons SET title=?,body=?,topic=?,class_level=?,premium=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(str(req.body.title, 200) || l.title, str(req.body.body, 50000) || l.body, str(req.body.topic, 100) || l.topic,
      str(req.body.class_level, 30) || l.class_level, req.body.premium === undefined ? l.premium : (req.body.premium ? 1 : 0),
      req.user.role === 'admin' ? l.status : 'pending', l.id);   // teacher edits go back to review
  res.json({ ok: true });
});
app.post('/api/lessons/:id/complete', auth('student'), (req, res) => {
  const l = db.prepare("SELECT * FROM lessons WHERE id=? AND status='approved'").get(req.params.id);
  if (!l) return bad(res, 'Not found', 404);
  if (l.premium && !isPremium(req.user)) return bad(res, 'Premium content', 402);
  const r = db.prepare('INSERT OR IGNORE INTO completed_lessons(user_id,lesson_id) VALUES(?,?)').run(req.user.id, l.id);
  if (r.changes) {
    award(req.user.id, 10);
    const n = db.prepare('SELECT COUNT(*) c FROM completed_lessons WHERE user_id=?').get(req.user.id).c;
    if (n >= 20) giveBadge(req.user.id, 'Bookworm');
  }
  res.json({ points_awarded: r.changes ? 10 : 0 });
});

// Quizzes (multiple_choice + short_answer)
app.post('/api/quizzes', auth('teacher', 'admin'), (req, res) => {
  const { subject_id, lesson_id, class_level, title, questions } = req.body;
  if (!subject_id || !str(class_level, 30) || !str(title, 200) || !Array.isArray(questions) || !questions.length) return bad(res, 'subject_id, class_level, title, questions[] required');
  for (const q of questions) {
    if (!['multiple_choice', 'short_answer'].includes(q.type) || !str(q.prompt) || !str(q.answer, 500)) return bad(res, 'Each question needs type, prompt, answer');
    if (q.type === 'multiple_choice' && (!Array.isArray(q.options) || q.options.length < 2)) return bad(res, 'Multiple choice needs 2+ options');
  }
  const status = req.user.role === 'admin' ? 'approved' : 'pending';
  const id = db.transaction(() => {
    const qid = db.prepare('INSERT INTO quizzes(subject_id,lesson_id,class_level,title,is_diagnostic,author_id,status) VALUES(?,?,?,?,?,?,?)')
      .run(subject_id, lesson_id || null, str(class_level, 30), str(title, 200), req.user.role === 'admin' && req.body.is_diagnostic ? 1 : 0, req.user.id, status).lastInsertRowid;
    const ins = db.prepare('INSERT INTO questions(quiz_id,type,prompt,options,answer) VALUES(?,?,?,?,?)');
    for (const q of questions) ins.run(qid, q.type, str(q.prompt), q.type === 'multiple_choice' ? JSON.stringify(q.options.map((o) => str(o, 300))) : null, str(q.answer, 500));
    return qid;
  })();
  res.status(201).json({ id, status });
});
app.get('/api/quizzes', auth(), (req, res) => {
  const { subject_id, class_level, diagnostic } = req.query;
  let sql = "SELECT id,subject_id,lesson_id,class_level,title,is_diagnostic FROM quizzes WHERE status='approved'";
  const p = [];
  if (subject_id) { sql += ' AND subject_id=?'; p.push(subject_id); }
  if (class_level) { sql += ' AND class_level=?'; p.push(class_level); }
  if (diagnostic) sql += ' AND is_diagnostic=1';
  res.json(db.prepare(sql).all(...p));
});
app.get('/api/quizzes/:id', auth(), (req, res) => {
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id=?').get(req.params.id);
  const owner = quiz && (req.user.role === 'admin' || quiz.author_id === req.user.id);
  if (!quiz || (quiz.status !== 'approved' && !owner)) return bad(res, 'Not found', 404);
  const qs = db.prepare('SELECT * FROM questions WHERE quiz_id=?').all(quiz.id)
    .map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, options: q.options ? JSON.parse(q.options) : null, ...(owner ? { answer: q.answer } : {}) }));
  res.json({ ...quiz, questions: qs });   // answers are never sent to students
});
app.post('/api/quizzes/:id/submit', auth('student'), (req, res) => {
  const quiz = db.prepare("SELECT * FROM quizzes WHERE id=? AND status='approved'").get(req.params.id);
  if (!quiz) return bad(res, 'Not found', 404);
  const answers = req.body.answers || {};
  const qs = db.prepare('SELECT * FROM questions WHERE quiz_id=?').all(quiz.id);
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const results = qs.map((q) => ({ question_id: q.id, correct: norm(answers[q.id]) === norm(q.answer), correct_answer: q.answer }));
  const score = results.filter((r) => r.correct).length;
  db.prepare('INSERT INTO attempts(user_id,quiz_id,subject_id,score,total) VALUES(?,?,?,?,?)').run(req.user.id, quiz.id, quiz.subject_id, score, qs.length);
  award(req.user.id, score * 5);
  if (qs.length && score === qs.length) {
    const perfect = db.prepare('SELECT COUNT(*) c FROM attempts WHERE user_id=? AND score=total').get(req.user.id).c;
    if (perfect >= 5) giveBadge(req.user.id, 'Quiz Champion');
  }
  res.json({ score, total: qs.length, points_awarded: score * 5, results });
});

// Adaptive learning path: weakest subjects first, unfinished lessons at the student's level
app.get('/api/path', auth('student'), (req, res) => {
  if (!isPremium(req.user)) return bad(res, 'Personalized learning paths are a Premium feature', 402);
  const acc = db.prepare('SELECT subject_id, 1.0*SUM(score)/SUM(total) a FROM attempts WHERE user_id=? GROUP BY subject_id').all(req.user.id);
  const accOf = (sid) => (acc.find((x) => x.subject_id === sid)?.a ?? 0.5);
  const lessons = db.prepare(`SELECT l.id,l.subject_id,l.title,l.topic,l.premium FROM lessons l WHERE l.status='approved'
    AND (l.class_level=? OR ?='') AND l.id NOT IN (SELECT lesson_id FROM completed_lessons WHERE user_id=?)`)
    .all(req.user.class_level || '', req.user.class_level || '', req.user.id);
  lessons.sort((a, b) => accOf(a.subject_id) - accOf(b.subject_id) || a.id - b.id);
  res.json(lessons.slice(0, 15).map((l) => ({ ...l, focus: accOf(l.subject_id) < 0.6 ? 'weak area' : 'keep growing' })));
});

// ───────────── DAILY BRAIN TRAINING (deterministic per user+day, graded server-side) ─────────────
function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) { h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
function brainSet(uid, day) {
  const r = rng(`${uid}:${day}:${JWT_SECRET}`), n = (a, b) => a + Math.floor(r() * (b - a + 1));
  const digits = Array.from({ length: 5 }, () => n(0, 9)).join('');
  const start = n(1, 9), step = n(2, 6);
  const a = n(10, 40), b = n(2, 9);
  return [
    { id: 'memory', type: 'memory', prompt: 'Remember these digits, then type them back:', show: digits, answer: digits },
    { id: 'logic', type: 'logic', prompt: `What comes next? ${[0, 1, 2, 3].map((i) => start + i * step).join(', ')}, ?`, answer: String(start + 4 * step) },
    { id: 'problem', type: 'problem_solving', prompt: `A shop has ${a} mangoes and sells ${b} bags of 3 mangoes each. How many mangoes are left?`, answer: String(a - b * 3) },
    { id: 'reading', type: 'reading', prompt: 'Read: "Ada waters her plants every morning before school." When does Ada water her plants? (before school / after school)', answer: 'before school' },
  ];
}
app.get('/api/brain/today', auth('student'), (req, res) =>
  res.json({ day: today(), done: !!db.prepare('SELECT 1 FROM brain_days WHERE user_id=? AND day=?').get(req.user.id, today()),
    exercises: brainSet(req.user.id, today()).map(({ answer, ...e }) => e) }));
app.post('/api/brain/submit', auth('student'), (req, res) => {
  const set = brainSet(req.user.id, today()), ans = req.body.answers || {};
  const correct = set.filter((e) => String(ans[e.id] ?? '').trim().toLowerCase() === e.answer).length;
  const first = db.prepare('INSERT OR IGNORE INTO brain_days(user_id,day) VALUES(?,?)').run(req.user.id, today()).changes;
  if (first) { award(req.user.id, correct * 3); if (correct === set.length) giveBadge(req.user.id, 'Deep Thinker'); }
  res.json({ correct, total: set.length, points_awarded: first ? correct * 3 : 0 });
});

// ───────────── AI TUTOR (Claude API, key stays on server) ─────────────
app.post('/api/tutor', auth('student'), rateLimit({ windowMs: 60_000, limit: 20 }), wrap(async (req, res) => {
  if (!ANTHROPIC_API_KEY) return bad(res, 'AI tutor not configured', 503);
  const message = str(req.body.message, 2000);
  if (!message) return bad(res, 'Message required');
  if (!isPremium(req.user)) {
    const used = db.prepare('SELECT count FROM tutor_usage WHERE user_id=? AND day=?').get(req.user.id, today())?.count || 0;
    if (used >= FREE_TUTOR_PER_DAY) return bad(res, `Free plan allows ${FREE_TUTOR_PER_DAY} tutor chats a day. Upgrade for unlimited access.`, 402);
  }
  const history = (Array.isArray(req.body.history) ? req.body.history : []).slice(-10)
    .filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  const system = `You are ThinkNest's friendly AI tutor for a student${req.user.age ? ` aged ${req.user.age}` : ''}${req.user.class_level ? ` in ${req.user.class_level}` : ''}. ` +
    `Explain in simple, age-appropriate language, step by step. Guide the student to understand rather than just giving final answers: ask a check-for-understanding question, use everyday Nigerian examples where helpful. ` +
    `Stay on school subjects, be encouraging, keep replies short, and politely redirect anything unsafe or off-topic.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 600, system, messages: [...history, { role: 'user', content: message }] }),
  });
  if (!r.ok) { console.error('Anthropic error', r.status, await r.text()); return bad(res, 'Tutor is unavailable right now', 502); }
  const data = await r.json();
  db.prepare('INSERT INTO tutor_usage(user_id,day,count) VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1').run(req.user.id, today());
  touchStreak(req.user.id);
  res.json({ reply: data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') });
}));

// ───────────── PAYSTACK (server-side init, verify, webhook) ─────────────
const paystack = (path, opts = {}) => fetch(`https://api.paystack.co${path}`, { ...opts,
  headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, 'content-type': 'application/json' } }).then((r) => r.json());

function activatePayment(reference, amount, status) {
  const p = db.prepare('SELECT * FROM payments WHERE reference=?').get(reference);
  if (!p || p.status === 'success') return !!p && p.status === 'success';      // idempotent
  if (status !== 'success' || amount !== p.amount) return false;                // amount must match what WE created
  db.transaction(() => {
    db.prepare("UPDATE payments SET status='success' WHERE reference=?").run(reference);
    const b = getUser(p.beneficiary_id);
    const base = isPremium(b) ? new Date(b.plan_expires) : new Date();
    db.prepare("UPDATE users SET plan='premium', plan_expires=? WHERE id=?").run(new Date(base.getTime() + PLAN_DAYS * 864e5).toISOString(), b.id);
  })();
  return true;
}
// Parent pays for a child (student_id), or a student pays for themselves
app.post('/api/payments/initialize', auth('parent', 'student'), wrap(async (req, res) => {
  if (!PAYSTACK_SECRET_KEY) return bad(res, 'Payments not configured', 503);
  const benId = req.user.role === 'parent' ? Number(req.body.student_id) : req.user.id;
  const ben = getUser(benId);
  if (!ben || ben.role !== 'student' || (req.user.role === 'parent' && ben.parent_id !== req.user.id)) return bad(res, 'Invalid student', 400);
  const reference = 'TN_' + crypto.randomBytes(10).toString('hex');
  db.prepare('INSERT INTO payments(reference,payer_id,beneficiary_id,amount) VALUES(?,?,?,?)').run(reference, req.user.id, benId, PREMIUM_KOBO);
  const d = await paystack('/transaction/initialize', { method: 'POST', body: JSON.stringify({
    email: req.user.email, amount: PREMIUM_KOBO, currency: 'NGN', reference,
    callback_url: FRONTEND_URL === '*' ? `${req.protocol}://${req.get('host')}` : FRONTEND_URL.split(',')[0], metadata: { beneficiary_id: benId } }) });
  if (!d.status) return bad(res, 'Could not start payment', 502);
  res.json({ authorization_url: d.data.authorization_url, reference });
}));
app.get('/api/payments/verify/:reference', auth('parent', 'student'), wrap(async (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE reference=? AND payer_id=?').get(req.params.reference, req.user.id);
  if (!p) return bad(res, 'Not found', 404);
  const d = await paystack(`/transaction/verify/${encodeURIComponent(p.reference)}`);
  const ok = d.status && activatePayment(p.reference, d.data.amount, d.data.status);
  res.json({ success: !!ok });
}));

// ───────────── ADMIN ─────────────
app.get('/api/admin/users', auth('admin'), (req, res) =>
  res.json(db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 500').all().map(publicUser)));
app.patch('/api/admin/users/:id', auth('admin'), (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return bad(res, 'Not found', 404);
  if (req.body.role && ['student', 'parent', 'teacher', 'admin'].includes(req.body.role)) db.prepare('UPDATE users SET role=? WHERE id=?').run(req.body.role, u.id);
  if (req.body.plan === 'free') db.prepare("UPDATE users SET plan='free', plan_expires=NULL WHERE id=?").run(u.id);
  res.json(publicUser(getUser(u.id)));
});
app.delete('/api/admin/users/:id', auth('admin'), (req, res) => {
  if (Number(req.params.id) === req.user.id) return bad(res, "You can't delete yourself");
  res.json({ deleted: db.prepare('DELETE FROM users WHERE id=?').run(req.params.id).changes });
});
app.get('/api/admin/pending', auth('admin'), (req, res) => res.json({
  lessons: db.prepare("SELECT id,title,author_id,class_level FROM lessons WHERE status='pending'").all(),
  quizzes: db.prepare("SELECT id,title,author_id,class_level FROM quizzes WHERE status='pending'").all() }));
app.post('/api/admin/review/:type/:id', auth('admin'), (req, res) => {
  const table = { lessons: 'lessons', quizzes: 'quizzes' }[req.params.type];
  if (!table) return bad(res, 'Invalid type');
  const status = req.body.approve === false ? 'rejected' : 'approved';
  res.json({ updated: db.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(status, req.params.id).changes, status });
});
app.get('/api/admin/stats', auth('admin'), (req, res) => res.json({
  users_by_role: db.prepare('SELECT role, COUNT(*) count FROM users GROUP BY role').all(),
  premium_users: db.prepare("SELECT COUNT(*) c FROM users WHERE plan='premium' AND plan_expires>?").get(new Date().toISOString()).c,
  revenue_ngn: (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE status='success'").get().s) / 100,
  lessons: db.prepare('SELECT COUNT(*) c FROM lessons').get().c, quiz_attempts: db.prepare('SELECT COUNT(*) c FROM attempts').get().c,
  tutor_chats_today: db.prepare('SELECT COALESCE(SUM(count),0) s FROM tutor_usage WHERE day=?').get(today()).s }));

app.get('/api/health', (req, res) => res.json({ ok: true }));
// The website (landing page + app) is served by this same server
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => (req.path.startsWith('/api/') ? bad(res, 'Not found', 404) : res.status(404).send('Not found')));
if (require.main === module) app.listen(PORT, () => console.log(`ThinkNest API on :${PORT}`));
module.exports = app;
