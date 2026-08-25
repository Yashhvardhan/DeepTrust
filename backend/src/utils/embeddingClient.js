/**
 * Lightweight semantic-similarity layer used to match a claim to evidence by
 * MEANING instead of literal keyword overlap. Supports the same two
 * providers as llmClient.js:
 *  - "gemini": Google's text-embedding-004
 *  - "ollama": a local embedding model (default nomic-embed-text) via a
 *    locally-running Ollama server — no API key, no per-call cost.
 * Selected by the same LLM_PROVIDER env var as llmClient.js.
 *
 * NOTE on scope: the original roadmap proposed FAISS + a vector index. FAISS
 * is built for approximate nearest-neighbor search over thousands/millions
 * of vectors; this pipeline compares a handful of claims against a handful
 * of evidence snippets per report, so a vector index adds an entire extra
 * service for no measurable benefit. Plain embedding + cosine similarity,
 * computed in-process, gets the real win here.
 */
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const EMBED_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 20000;

function getProvider() {
  const p = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  return p === 'ollama' ? 'ollama' : 'gemini';
}

const isMock = () => {
  if (process.env.MOCK_MODE === 'true') return true;
  if (getProvider() === 'ollama') return false;
  return !process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.startsWith('your_gemini');
};

let geminiClient = null;
function getGeminiClient() {
  if (!geminiClient) geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return geminiClient;
}

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

/** Real embedding via Gemini's embedding model. */
async function embedGemini(text) {
  const model = getGeminiClient().getGenerativeModel({ model: 'text-embedding-004' });
  const result = await model.embedContent(text.slice(0, 2000));
  return result.embedding.values;
}

/** Real embedding via a local Ollama embedding model. */
async function embedOllama(text) {
  const resp = await axios.post(
    `${OLLAMA_BASE_URL}/api/embeddings`,
    { model: OLLAMA_EMBED_MODEL, prompt: text.slice(0, 2000) },
    { timeout: EMBED_TIMEOUT_MS }
  );
  const vec = resp.data?.embedding;
  if (!Array.isArray(vec)) throw new Error('Ollama embeddings response missing "embedding" array');
  return vec;
}

/**
 * Deterministic offline mock embedding: a feature-hashed bag-of-words vector.
 * Two texts sharing more vocabulary land closer together under cosine
 * similarity, which is a reasonable stand-in for real embeddings when no
 * provider is configured (demos, tests, CI).
 */
function embedMock(text, dims = 64) {
  const vec = new Array(dims).fill(0);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) {
    let hash = 0;
    for (let i = 0; i < w.length; i++) hash = (hash * 31 + w.charCodeAt(i)) >>> 0;
    vec[hash % dims] += 1;
  }
  return vec;
}

async function embedText(text) {
  if (!text) return null;
  if (isMock()) return embedMock(text);
  try {
    return getProvider() === 'ollama' ? await embedOllama(text) : await embedGemini(text);
  } catch (err) {
    console.error('[embeddingClient] embedding failed, falling back to mock:', err.message);
    return embedMock(text);
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Embeds a claim once and every evidence snippet, returns a parallel array of
 * 0-1 semantic-similarity scores (claim vs. each snippet's title+snippet text).
 * Failures degrade to 0 similarity for that item rather than aborting ranking.
 */
async function semanticScores(claimText, evidenceItems) {
  const claimVec = await embedText(claimText);
  const scores = await Promise.all(
    evidenceItems.map(async (item) => {
      try {
        const text = `${item.title || ''} ${item.snippet || ''}`.trim();
        if (!text) return 0;
        const vec = await embedText(text);
        return cosineSimilarity(claimVec, vec);
      } catch {
        return 0;
      }
    })
  );
  return scores;
}

module.exports = { embedText, cosineSimilarity, semanticScores, isMock, getProvider };
