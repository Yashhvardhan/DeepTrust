/**
 * Minimal JSON database for the DeepTrust MVP.
 *
 * Local development:
 *   Reads and writes backend/data/db.json.
 *
 * Vercel:
 *   Reads the bundled db.json but does NOT attempt to write to the
 *   deployment filesystem, because serverless deployment storage
 *   should not be used as a persistent database.
 */

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const file = path.join(dataDir, 'db.json');

const isVercel = !!process.env.VERCEL;

if (!isVercel && !fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let state = {
  users: [],
  reports: [],
};

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
  // Vercel deployment filesystems are not persistent.
  // Keep changes in memory for the lifetime of the running instance.
  if (isVercel) {
    return;
  }

  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

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

  // Only initialize the physical JSON file during local development.
  if (!isVercel) {
    await db.write();
  }

  return db;
}

module.exports = {
  db,
  initDB,
};