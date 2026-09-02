const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { db } = require('../db');
const { DOMAIN_REPUTATION } = require('../utils/domainReputation');

const router = express.Router();

const PLAN_LIMITS = { Free: 50, Starter: 100, Team: 500, Newsroom: 2000, Enterprise: null };

// GET /api/account/usage — real verification count for the current
// calendar month, replacing the hardcoded "310 / 500" shown throughout
// the old UI.
router.get('/usage', requireAuth, async (req, res) => {
  await db.read();
  const user = db.data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const used = db.data.reports.filter(
    (r) => r.userId === user.id && new Date(r.createdAt) >= startOfMonth
  ).length;
  const plan = user.plan || 'Free';
  const limit = Object.prototype.hasOwnProperty.call(PLAN_LIMITS, plan) ? PLAN_LIMITS[plan] : 50;

  const nextReset = new Date(startOfMonth);
  nextReset.setMonth(nextReset.getMonth() + 1);

  res.json({ plan, used, limit, resetsAt: nextReset.toISOString() });
});

// GET /api/account/notifications — derived from the user's own report
// history (no separate notification store to keep in sync/go stale).
// A verification scored below the fake-news threshold in the last 7 days
// becomes a notification; "unread" is whatever came in since the user
// last opened the bell.
router.get('/notifications', requireAuth, async (req, res) => {
  await db.read();
  const user = db.data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const items = db.data.reports
    .filter((r) => r.userId === user.id && new Date(r.createdAt).getTime() >= sevenDaysAgo)
    .filter((r) => r.report?.verdict === 'Likely Fake' || (r.report?.trustScore ?? 100) < 40)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      reportId: r.id,
      text: `"${r.inputRef}" scored ${r.report.trustScore}% (${r.report.verdict || 'Unclear'})`,
      createdAt: r.createdAt,
      read: user.lastSeenNotificationsAt ? new Date(r.createdAt) <= new Date(user.lastSeenNotificationsAt) : false,
    }));

  const unread = items.filter((i) => !i.read).length;
  res.json({ notifications: items, unread });
});

// POST /api/account/notifications/mark-read
router.post('/notifications/mark-read', requireAuth, async (req, res) => {
  await db.read();
  const user = db.data.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.lastSeenNotificationsAt = new Date().toISOString();
  await db.write();
  res.json({ ok: true });
});

// POST /api/account/upgrade-request — there is no payment processor wired
// into this MVP, so instead of faking a checkout, this genuinely records
// the request so it can be actioned by whoever manages billing.
router.post('/upgrade-request', requireAuth, async (req, res) => {
  const { plan, cycle } = req.body || {};
  if (!plan) return res.status(400).json({ error: 'plan is required' });

  await db.read();
  const request = {
    id: uuidv4(),
    userId: req.user.id,
    plan,
    cycle: cycle === 'year' ? 'year' : 'month',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  db.data.upgradeRequests.push(request);
  await db.write();
  res.status(201).json({ request });
});

// GET /api/account/sources — the ACTUAL source-reputation table the Fact
// Verification agent looks up against, not a hardcoded UI list. Replaces
// the previous frontend-only `sources` array in Settings, which had no
// connection to what the pipeline really does.
router.get('/sources', requireAuth, async (req, res) => {
  const rows = Object.entries(DOMAIN_REPUTATION)
    .map(([hostname, v]) => ({ hostname, score: v.score, category: v.category }))
    .sort((a, b) => b.score - a.score);
  const categories = {};
  for (const r of rows) categories[r.category] = (categories[r.category] || 0) + 1;
  res.json({ sources: rows, total: rows.length, categories });
});

// GET /api/account/stats — real time series + verdict distribution built
// from this user's own report history, for a trust-score trend chart that
// reflects actual runs rather than a decorative sparkline.
router.get('/stats', requireAuth, async (req, res) => {
  await db.read();
  const reports = db.data.reports
    .filter((r) => r.userId === req.user.id)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const trend = reports.slice(-20).map((r) => ({
    date: r.createdAt,
    trustScore: r.report?.trustScore ?? null,
    verdict: r.report?.verdict || 'Unclear',
  }));

  const distribution = { 'Likely Real': 0, 'Likely Fake': 0, Unclear: 0 };
  let evidenceSum = 0;
  let sourcesTotal = 0;
  for (const r of reports) {
    const v = r.report?.verdict;
    if (v === 'Likely Real' || v === 'Likely Fake') distribution[v]++;
    else distribution.Unclear++;
    evidenceSum += r.report?.evidenceCoverage || 0;
    sourcesTotal += r.report?.pipelineTrace?.sourcesKeptAfterRanking || 0;
  }

  res.json({
    trend,
    distribution,
    totalReports: reports.length,
    avgEvidenceCoverage: reports.length ? Math.round(evidenceSum / reports.length) : 0,
    totalSourcesChecked: sourcesTotal,
  });
});

module.exports = router;
