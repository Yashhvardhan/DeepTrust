const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');

const router = express.Router();

const PLAN_LIMITS = { Free: 50, Starter: 100, Team: 500, Newsroom: 2000, Enterprise: null };
const PROFILE_FIELDS = ['name', 'mobile', 'company', 'website', 'role', 'beats', 'notifyBelow', 'notifyDigest', 'notifyRanking'];

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    process.env.JWT_SECRET || 'dev_secret',
    { expiresIn: '7d' }
  );
}

// Strips the password hash and computes this-cycle usage before sending a
// user object to the client. Every route that returns a user goes through
// this so the frontend never has to guess/hardcode plan or usage numbers.
function toSafeUser(user, reports) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const usedThisCycle = (reports || []).filter(
    (r) => r.userId === user.id && new Date(r.createdAt) >= startOfMonth
  ).length;
  const plan = user.plan || 'Free';
  return {
    id: user.id,
    email: user.email,
    name: user.name || user.email.split('@')[0],
    mobile: user.mobile || '',
    company: user.company || '',
    website: user.website || '',
    role: user.role || '',
    beats: user.beats || '',
    notifyBelow: user.notifyBelow !== false,
    notifyDigest: !!user.notifyDigest,
    notifyRanking: !!user.notifyRanking,
    plan,
    planLimit: Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan) ? PLAN_LIMITS[plan] : (user.planLimit ?? 50),
    usedThisCycle,
    createdAt: user.createdAt,
  };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  await db.read();
  const existing = db.data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    email,
    passwordHash,
    name: email.split('@')[0],
    mobile: '',
    company: '',
    website: '',
    role: '',
    beats: '',
    notifyBelow: true,
    notifyDigest: false,
    notifyRanking: false,
    plan: 'Free',
    lastSeenNotificationsAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  db.data.users.push(user);
  await db.write();

  const token = signToken(user);
  res.status(201).json({ token, user: toSafeUser(user, db.data.reports) });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  await db.read();
  const user = db.data.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = signToken(user);
  res.json({ token, user: toSafeUser(user, db.data.reports) });
});

const { requireAuth } = require('../middleware/auth');

// GET /api/auth/me — full profile + real usage for the logged-in user
// (replaces any hardcoded plan/usage numbers on the frontend).
router.get('/me', requireAuth, async (req, res) => {
  await db.read();
  const user = db.data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user: toSafeUser(user, db.data.reports) });
});

// PATCH /api/auth/me — actually persists profile edits made in Settings,
// instead of writing only to localStorage.
router.patch('/me', requireAuth, async (req, res) => {
  await db.read();
  const user = db.data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  for (const field of PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(req.body, field)) {
      user[field] = req.body[field];
    }
  }
  await db.write();
  res.json({ user: toSafeUser(user, db.data.reports) });
});

module.exports = router;
