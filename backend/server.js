require('dotenv').config();

console.log("========== ENVIRONMENT CHECK ==========");
console.log("PORT =", process.env.PORT);
console.log("MOCK_MODE =", process.env.MOCK_MODE);
console.log("SEARCH_PROVIDER =", process.env.SEARCH_PROVIDER);
console.log("GEMINI_API_KEY loaded =", !!process.env.GEMINI_API_KEY);
console.log(
  "GEMINI_API_KEY first 15 chars =",
  process.env.GEMINI_API_KEY
    ? process.env.GEMINI_API_KEY.substring(0, 15)
    : "NOT FOUND"
);
console.log("SERPER_API_KEY loaded =", !!process.env.SERPER_API_KEY);
console.log("=======================================\n");

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const { initDB } = require('./src/db');
const authRoutes = require('./src/routes/auth');
const analyzeRoutes = require('./src/routes/analyze');
const accountRoutes = require('./src/routes/account');
const { isMock: llmMock } = require('./src/utils/llmClient');
const { isMock: searchMock } = require('./src/utils/searchClient');

const app = express();
const PORT = process.env.PORT || 5000;

// Ensure upload dir exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    mockMode: {
      llm: llmMock(),
      search: searchMock(),
    },
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/analyze', analyzeRoutes);
app.use('/api/account', accountRoutes);

// Generic error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).json({
    error: err.message || 'Something went wrong',
  });
});

initDB()
  .then(() => {
    const server = app.listen(PORT, () => {
      console.log(`\n🚀 Fake News & Fact Verification API running on http://localhost:${PORT}`);
      console.log(`LLM mock mode: ${llmMock() ? 'ON' : 'OFF'}`);
      console.log(`Search mock mode: ${searchMock() ? 'ON' : 'OFF'}`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Stop the other process or pick a different PORT.`);
        process.exit(1);
      } else {
        console.error(err);
        process.exit(1);
      }
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });