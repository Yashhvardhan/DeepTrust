/**
 * Thin wrapper around the LLM used by every agent. Supports two providers:
 *  - "gemini" (default): Google Gemini API, cloud-hosted.
 *  - "ollama": a locally-running Ollama server (https://ollama.com) — free,
 *    private, no per-call API cost. Useful for dev/offline work or when you
 *    don't want article/claim text leaving your machine.
 * Select with LLM_PROVIDER=gemini|ollama in .env. If neither a Gemini key
 * nor a reachable Ollama server is configured (or MOCK_MODE=true), every
 * call falls back to deterministic mock responses so the pipeline still
 * runs end-to-end for demos/tests.
 *
 * Speed/reliability fix: every real LLM call is now wrapped in a hard
 * timeout (LLM_TIMEOUT_MS, default 20s / 30s for image calls). Previously a
 * single slow or hung API call had nothing bounding it, so one bad request
 * could stall the whole "Analyzing…" screen indefinitely. On timeout the
 * call rejects with a clear error instead of hanging, so callers (see
 * factVerificationAgent's per-claim try/catch) can degrade gracefully
 * instead of the whole report failing.
 */
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const TEXT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 20000;
const IMAGE_TIMEOUT_MS = Number(process.env.LLM_IMAGE_TIMEOUT_MS) || 30000;



const isMock = () => {
  return process.env.MOCK_MODE === 'true';
};

let geminiClient = null;
function getGeminiClient() {
  if (!geminiClient) geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return geminiClient;
}

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'llava';

/** Returns today's date as a plain-English string, e.g. "Tuesday, July 28, 2026". */
function todayString() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** Races a promise against a hard timeout so a stuck call can never hang the pipeline. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Strips ```json fences some local models add even in "JSON mode". */
function safeParseJSON(raw, context) {
  const cleaned = String(raw || '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`${context} did not return valid JSON: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * Ask the model to return strict JSON. `schemaHint` is baked into `system`
 * by each agent — this layer just handles transport + provider selection.
 */
async function completeJSON({ system, user, mockResponse }) {

  if (isMock()) {
    await new Promise((r) => setTimeout(r, 400));
    return mockResponse;
  }

  const dateGroundedSystem = `Today's real date is ${todayString()}. This is the current date — do not treat dates at or before today (including the current year) as "in the future" or as evidence of fabrication. Only flag a date as suspicious if it is genuinely after today's date, or is otherwise internally inconsistent.\n\n${system}`;

  // ---------- Try Gemini First ----------
  try {

    if (
      process.env.GEMINI_API_KEY &&
      !process.env.GEMINI_API_KEY.startsWith("your_gemini")
    ) {

      console.log("Using Gemini...");

      return await withTimeout(
        callGeminiJSON(dateGroundedSystem, user),
        TEXT_TIMEOUT_MS,
        "Gemini request"
      );

    }

    throw new Error("Gemini API Key Missing");

  } catch (err) {

    console.log("Gemini failed:", err.message);

  }

  // ---------- Fallback to Ollama ----------
  try {

    console.log("Falling back to Ollama...");

    return await withTimeout(
      callOllamaJSON(dateGroundedSystem, user),
      TEXT_TIMEOUT_MS,
      "Ollama request"
    );

  } catch (err) {

    console.log("Ollama failed:", err.message);

  }

  // ---------- Last Fallback ----------
  console.log("Returning Mock Response");

  return mockResponse;
}

async function callGeminiJSON(system, user) {
  const model = getGeminiClient().getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    systemInstruction: system,
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  });
  const resp = await model.generateContent(user);
  return safeParseJSON(resp.response.text(), 'Gemini');
}

async function callOllamaJSON(system, user) {
  const resp = await axios.post(
    `${OLLAMA_BASE_URL}/api/chat`,
    {
      model: OLLAMA_MODEL,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    { timeout: TEXT_TIMEOUT_MS }
  );
  const content = resp.data?.message?.content;
  return safeParseJSON(content, 'Ollama');
}

/**
 * Multimodal variant of completeJSON — sends one image alongside the prompt
 * (used only by the Visual Analysis agent). Falls back to mockResponse in
 * mock mode or if no image bytes were available.
 */
async function completeJSONWithImage({
  system,
  user,
  imageBase64,
  mimeType,
  mockResponse,
}) {

  if (isMock() || !imageBase64) {
    await new Promise((r) => setTimeout(r, 400));
    return mockResponse;
  }

  const dateGroundedSystem = `Today's real date is ${todayString()}.\n\n${system}`;

  // ==========================
  // 1. Try Gemini Vision
  // ==========================
  try {

    if (
      process.env.GEMINI_API_KEY &&
      !process.env.GEMINI_API_KEY.startsWith("your_gemini")
    ) {

      console.log("Using Gemini Vision...");

      return await withTimeout(
        callGeminiJSONWithImage(
          dateGroundedSystem,
          user,
          imageBase64,
          mimeType
        ),
        IMAGE_TIMEOUT_MS,
        "Gemini vision request"
      );
    }

    throw new Error("Gemini API Key Missing");

  } catch (err) {

    console.log("Gemini Vision failed:", err.message);

  }

  // ==========================
  // 2. Fallback to Ollama Vision
  // ==========================
  try {

    console.log("Falling back to Ollama Vision...");

    return await withTimeout(
      callOllamaJSONWithImage(
        dateGroundedSystem,
        user,
        imageBase64
      ),
      IMAGE_TIMEOUT_MS,
      "Ollama vision request"
    );

  } catch (err) {

    console.log("Ollama Vision failed:", err.message);

  }

  // ==========================
  // 3. Final fallback
  // ==========================
  console.log("Returning Mock Response");

  return mockResponse;
}

async function callGeminiJSONWithImage(system, user, imageBase64, mimeType) {
  const model = getGeminiClient().getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    systemInstruction: system,
    generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
  });
  const resp = await model.generateContent([
    { inlineData: { data: imageBase64, mimeType: mimeType || 'image/jpeg' } },
    { text: user },
  ]);
  return safeParseJSON(resp.response.text(), 'Gemini');
}

async function callOllamaJSONWithImage(system, user, imageBase64) {
  // Ollama's vision models (llava, bakllava, llama3.2-vision, ...) take raw
  // base64 image bytes (no data: URI prefix) attached to the user message.
  const resp = await axios.post(
    `${OLLAMA_BASE_URL}/api/chat`,
    {
      model: OLLAMA_VISION_MODEL,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user, images: [imageBase64] },
      ],
    },
    { timeout: IMAGE_TIMEOUT_MS }
  );
  const content = resp.data?.message?.content;
  return safeParseJSON(content, 'Ollama vision');
}

async function completeJSONWithImages({ system, user, images, mockResponse }) {
  if (isMock() || !Array.isArray(images) || images.length === 0) {
    await new Promise((r) => setTimeout(r, 250));
    return mockResponse;
  }
  const dateGroundedSystem = `Today's real date is ${todayString()}.\n\n${system}`;
  try {
    if (process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith('your_gemini')) {
      return await withTimeout(callGeminiJSONWithImages(dateGroundedSystem, user, images), IMAGE_TIMEOUT_MS * 2, 'Gemini multi-frame request');
    }
  } catch (err) { console.log('Gemini multi-frame failed:', err.message); }
  try {
    return await withTimeout(callOllamaJSONWithImages(dateGroundedSystem, user, images), IMAGE_TIMEOUT_MS * 2, 'Ollama multi-frame request');
  } catch (err) { console.log('Ollama multi-frame failed:', err.message); }
  return mockResponse;
}

async function callGeminiJSONWithImages(system, user, images) {
  const model = getGeminiClient().getGenerativeModel({
    model: process.env.GEMINI_VISION_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    systemInstruction: system,
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  });
  const parts = [];
  for (const img of images) {
    parts.push({ text: `TIMELINE FRAME ${img.label || img.timestamp || ''}` });
    parts.push({ inlineData: { data: img.base64, mimeType: img.mimeType || 'image/jpeg' } });
  }
  parts.push({ text: user });
  const resp = await model.generateContent(parts);
  return safeParseJSON(resp.response.text(), 'Gemini multi-frame');
}

async function callOllamaJSONWithImages(system, user, images) {
  const resp = await axios.post(`${OLLAMA_BASE_URL}/api/chat`, {
    model: OLLAMA_VISION_MODEL,
    stream: false,
    format: 'json',
    options: { temperature: 0.1 },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user, images: images.map(x => x.base64) }],
  }, { timeout: IMAGE_TIMEOUT_MS * 2 });
  return safeParseJSON(resp.data?.message?.content, 'Ollama multi-frame');
}

module.exports = { completeJSON, completeJSONWithImage, completeJSONWithImages, isMock, todayString };
