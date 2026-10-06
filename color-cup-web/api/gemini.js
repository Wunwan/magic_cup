// api/gemini.js — runs on Vercel, never in the browser.
// It holds the Gemini key (set GEMINI_API_KEY in Vercel → Project → Settings →
// Environment Variables), so the key never reaches visitors or GitHub.
// It only answers Color Cup's two questions, so it can't be used as a general Gemini proxy.

const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'];
const TIMEOUT_MS = 9000;      // give up on a slow model so the browser can try the next one
const MAX_IMAGE = 1500000;    // base64 characters (~1.1 MB); the doodles are far smaller

const NAME_PROMPT = `This is a quick black-ink doodle on white paper.
What single object does it most likely show?
Reply with JSON only, exactly this shape: {"object": "a tree"}
object: a short lowercase noun phrase starting with "a" or "an".`;

const COLOR_PROMPT = `This black-ink doodle shows {OBJECT}.
Color it the way that thing really looks. Split it into 1 to 4 parts that have different real-world colors
(a tree: leaves green, trunk brown; a strawberry: berry red, leafy top green).
If the whole thing is one color, return just one part. Use bold colors when the real thing is bold.
For each part, give a bounding box around where that part is in this image,
as [ymin, xmin, ymax, xmax] scaled from 0 to 1000.
Reply with JSON only, exactly this shape:
{"parts": [{"name": "leaves", "hex": "#3f8f3a", "colorName": "leaf green", "box": [40, 120, 560, 880]}]}
hex: that part's real-world color as #rrggbb
colorName: one or two lowercase words, like "tomato red" or "sky blue"`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, 'use POST');

  // Only this site's own pages may call it from a browser.
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return send(res, 403, 'not allowed from this site'); }
    catch (e) { return send(res, 403, 'not allowed from this site'); }
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return send(res, 500, 'GEMINI_API_KEY is not set on the server');

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== 'object') body = await readJson(req);
  const { model, step, image, object } = body || {};

  if (!MODELS.includes(model)) return send(res, 400, 'unknown model');
  if (step !== 'name' && step !== 'colors') return send(res, 400, 'unknown step');
  if (typeof image !== 'string' || image.length > MAX_IMAGE || !/^[A-Za-z0-9+/=]+$/.test(image)) return send(res, 400, 'bad image');

  const thing = String(object || '').toLowerCase().replace(/[^a-z0-9 '\-]/g, '').trim().slice(0, 40) || 'something';
  const prompt = step === 'name' ? NAME_PROMPT : COLOR_PROMPT.replace('{OBJECT}', thing);

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/png', data: image } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    res.statusCode = r.status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return send(res, 504, 'gemini took too long');
    return send(res, 502, "couldn't reach gemini");
  }
};

function send(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: { message } }));
}

function readJson(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > MAX_IMAGE + 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
