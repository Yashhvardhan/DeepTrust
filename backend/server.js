require('dotenv').config();

console.log("========== ENVIRONMENT CHECK ==========");
console.log("PORT =", process.env.PORT);
console.log("MOCK_MODE =", process.env.MOCK_MODE);
console.log("SEARCH_PROVIDER =", process.env.SEARCH_PROVIDER);
console.log("GEMINI_API_KEY loaded =", !!process.env.GEMINI_API_KEY);
console.log("SERPER_API_KEY loaded =", !!process.env.SERPER_API_KEY);
console.log("VERCEL =", !!process.env.VERCEL);
console.log("=======================================\n");

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { initDB } = require('./src/db');
const authRoutes = require('./src/routes/auth');
const analyzeRoutes = require('./src/routes/analyze');
const { isMock: llmMock } = require('./src/utils/llmClient');
const { isMock: searchMock } = require('./src/utils/searchClient');

const app = express();
const PORT = process.env.PORT || 5000;

// =====================================================
// Upload directory
// =====================================================
// Vercel's deployed filesystem should not be used for
// persistent writes. /tmp is the writable temporary area.
// Locally, continue using backend/uploads.
const uploadsDir = process.env.VERCEL
  ? '/tmp/deeptrust-uploads'
  : path.join(__dirname, 'uploads');

try {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
} catch (err) {
  console.error('Failed to initialize upload directory:', err.message);
}

// =====================================================
// Middleware
// =====================================================
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// =====================================================
// Health check
// =====================================================
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    mockMode: {
      llm: llmMock(),
      search: searchMock(),
    },
    environment: process.env.VERCEL ? 'vercel' : 'local',
  });
});

// =====================================================
// API routes
// =====================================================
app.use('/api/auth', authRoutes);
app.use('/api/analyze', analyzeRoutes);

// =====================================================
// Root route
// =====================================================
app.get('/', (req, res) => {
  res.json({
    name: 'DeepTrust API',
    status: 'online',
    health: '/api/health',
  });
});

// =====================================================
// Favicon - prevent unnecessary function errors
// =====================================================
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// =====================================================
// 404 handler
// =====================================================
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
  });
});

// =====================================================
// Generic error handler
// =====================================================
app.use((err, req, res, next) => {
  console.error('API ERROR:', err);

  res.status(err.status || 500).json({
    error: err.message || 'Something went wrong',
  });
});

// =====================================================
// Local server startup
// =====================================================
// On Vercel, the Express app is exported and Vercel
// handles the HTTP server.
// Locally, npm start launches app.listen().
async function startServer() {
  try {
    await initDB();

    const server = app.listen(PORT, () => {
      console.log(
        `Fake News & Fact Verification API running on http://localhost:${PORT}`
      );
      console.log(`LLM mock mode: ${llmMock() ? 'ON' : 'OFF'}`);
      console.log(`Search mock mode: ${searchMock() ? 'ON' : 'OFF'}`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `Port ${PORT} is already in use. Stop the other process or pick a different PORT.`
        );
        process.exit(1);
      }

      console.error('Server error:', err);
      process.exit(1);
    });
  } catch (err) {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  }
}

if (!process.env.VERCEL) {
  startServer();
}

// =====================================================
// Vercel / Express export
// =====================================================
module.exports = app;