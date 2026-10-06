// gemini.js (web version)
// Two questions for Gemini about each doodle:
//   1. What is it?  → shown as a big word at the top of the screen
//   2. Knowing that, what are the real colors of its parts, and where is each part
//      in the drawing?  → the drawing gets those colors, blended where parts meet
//
// The browser never talks to Google directly. It asks this site's own server function
// (api/gemini.js), which holds the key, so visitors never see it and never get asked for one.

const GEMINI_ENDPOINT = '/api/gemini';

// Tried in order. A model that's busy, too slow, retired or out of quota is skipped,
// and whichever model answered last is tried first next time.
const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"];
const GEMINI_TIMEOUT = 11000; // ms before giving up on a model and trying the next
let goodModel = null;

class GeminiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function askGeminiWhatItIs(pngBase64) {
  const data = await askGeminiJSON({ step: 'name', image: pngBase64 });
  return { object: tidy(data.object) || 'something' };
}

async function askGeminiForColors(pngBase64, object) {
  const data = await askGeminiJSON({ step: 'colors', image: pngBase64, object });
  const parts = (Array.isArray(data.parts) ? data.parts : []).map(cleanPart).filter(Boolean).slice(0, 4);
  if (!parts.length) throw new GeminiError('format', 'gemini sent no colors');
  return { parts };
}

function cleanPart(p) {
  if (!p) return null;
  let hex = String(p.hex || p.color || '').trim();
  if (/^[0-9a-f]{6}$/i.test(hex)) hex = '#' + hex;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return null;
  let box = [0, 0, 1000, 1000];
  if (Array.isArray(p.box) && p.box.length === 4 && p.box.every(v => isFinite(+v))) {
    box = p.box.map(v => Math.min(1000, Math.max(0, +v)));
    if (box[2] < box[0]) [box[0], box[2]] = [box[2], box[0]];
    if (box[3] < box[1]) [box[1], box[3]] = [box[3], box[1]];
  }
  return { name: tidy(p.name), hex: hex.toLowerCase(), colorName: tidy(p.colorName) || tidy(p.name) || 'color', box };
}

async function askGeminiJSON(payload) {
  const order = goodModel ? [goodModel, ...GEMINI_MODELS.filter(m => m !== goodModel)] : GEMINI_MODELS;
  let lastError = null;
  for (const model of order) {
    try {
      const answer = await callGemini(model, payload);
      goodModel = model;
      return answer;
    } catch (err) {
      lastError = err;
      // problems other models won't fix
      if (['auth', 'server-key', 'no-server', 'offline'].includes(err.code)) break;
      // busy, slow, retired or out of quota for this model: try the next one
    }
  }
  throw lastError;
}

async function callGemini(model, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT);
  let res;
  try {
    res = await fetch(GEMINI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ model }, payload)),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new GeminiError('slow', 'gemini took too long');
    throw new GeminiError('offline', "couldn't reach the server");
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch (e) { /* not json: see below */ }
  if (!res.ok) {
    const msg = (json && json.error && json.error.message) || res.statusText || 'request failed';
    let code = 'other';
    if (res.status === 404 && !json) code = 'no-server';
    else if (res.status === 500 && /GEMINI_API_KEY/.test(msg)) code = 'server-key';
    else if (res.status === 401 || res.status === 403 || /api key/i.test(msg)) code = 'auth';
    else if (res.status === 429) code = 'quota';
    else if (res.status === 503 || res.status === 504 || res.status === 502 || res.status === 500) code = 'busy';
    else if (res.status === 404) code = 'model';
    console.warn(`[gemini ${model}] ${res.status}: ${msg}`);
    throw new GeminiError(code, msg);
  }

  const parts = (json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts) || [];
  const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new GeminiError('format', 'gemini answered without json');
  return JSON.parse(text.slice(start, end + 1));
}

function tidy(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 '\-]/g, '').trim().slice(0, 32);
}

// What the sketch uses when Gemini can't answer: one random color, or two blended top to bottom.
function fallbackColors() {
  const one = { name: '', hex: randomColor(), colorName: 'random', box: [0, 0, 1000, 1000] };
  if (Math.random() < 0.5) return { parts: [one] };
  return { parts: [
    Object.assign(one, { box: [0, 0, 480, 1000] }),
    { name: '', hex: randomColor(), colorName: 'random', box: [520, 0, 1000, 1000] },
  ] };
}

// Short, fixable explanations for the hint corner.
function describeGeminiError(err) {
  if (!err) return '';
  switch (err.code) {
    case 'no-server': return "can't find api/gemini.js. run the site on vercel (or with vercel dev)";
    case 'server-key': return 'the gemini key is not set yet. add GEMINI_API_KEY in vercel, then redeploy';
    case 'auth': return 'gemini rejected the key set on vercel, so the colors are random';
    case 'quota': return 'gemini quota is used up for now, so the colors are random';
    case 'busy':
    case 'slow': return 'gemini is overloaded right now, so the colors are random. try again in a bit';
    case 'offline': return err.message + ', so the colors are random';
    case 'model': return 'none of the gemini models are available on this key';
    default: return 'gemini had trouble with that one, so the colors are random';
  }
}
