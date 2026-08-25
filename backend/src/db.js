/**
 * Minimal file-based JSON database (no external DB required for the MVP).
 *
 * Why not Postgres/Mongo directly in the MVP?
 * - Zero external services to install -> the whole MVP runs with `npm install && npm start`.
 * - Data access is isolated in this one file, so swapping to Postgres (Prisma/Sequelize)
 *   or MongoDB (Mongoose) later only means rewriting this file, not routes or agents.
 *
 * Collections:
 *  - users:   { id, email, passwordHash, createdAt }
 *  - reports: { id, userId, inputType, inputRef, settings, report, createdAt }
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const file = path.join(dataDir, 'db.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let state = { users: [], reports: [] };

function loadFromDisk() {
  if (fs.existsSync(file)) {
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      state = { users: [], reports: [] };
    }
  }
  state.users = state.users || [];
  state.reports = state.reports || [];
}

function saveToDisk() {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

// `db` mimics the small subset of the lowdb API the rest of the app uses:
// db.read(), db.write(), db.data.{users,reports}
const db = {
  get data() {
    return state;
  },
  async read() {
    loadFromDisk();
  },
  async write() {
    saveToDisk();
  },
};

async function initDB() {
  await db.read();
  await db.write();
  return db;
}

module.exports = { db, initDB };
