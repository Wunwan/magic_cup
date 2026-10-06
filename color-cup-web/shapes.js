// shapes.js
// Turns the pen strokes into: a filled silhouette, a texture for three.js,
// a small PNG for Gemini, and a matter.js body with the drawing's real outline.
// Also holds the color math that turns Gemini's "real" color into a pastel.

const CLOSE_GAP = 6;   // px. Gaps smaller than ~2x this still count as a closed shape
const HALO = 7;        // px. Line-only doodles get a colored halo this wide instead of a fill

// ---------------------------------------------------------------------------
// Pastel color math (OKLCH keeps the hue honest while we soften it)
// ---------------------------------------------------------------------------

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linearToSrgb(c) { return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function rgbToHex(rgb) {
  return '#' + rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

function linearToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

function hexToOklch(hex) {
  const [L, a, b] = linearToOklab(hexToRgb(hex).map(srgbToLinear));
  return { L, C: Math.hypot(a, b), h: Math.atan2(b, a) };
}

// Builds a hex color from OKLCH, pulling chroma in until it fits in sRGB.
function oklchToHex(L, C, h) {
  const toLinear = c => oklabToLinear([L, c * Math.cos(h), c * Math.sin(h)]);
  const fits = rgb => rgb.every(v => v >= -0.0005 && v <= 1.0005);
  let lo = 0, hi = C;
  if (!fits(toLinear(C))) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(toLinear(mid))) lo = mid; else hi = mid;
    }
    C = lo;
  }
  return rgbToHex(toLinear(C).map(linearToSrgb));
}

// Gemini's real-world color → the soft pastel we paint with.
// Your reference blue sits around L 0.75, C 0.08, so we land near there.
function pastelize(hex) {
  const { L, C, h } = hexToOklch(hex);
  const Lt = Math.min(0.9, Math.max(0.73, 0.8 + (L - 0.62) * 0.35)); // yellows stay light, browns stay deeper
  const Ct = Math.min(C * 0.85, 0.1);
  return oklchToHex(Lt, Ct, h);
}

// A deeper shade of the same hue, readable as text on white.
function labelInk(hex) {
  const { C, h } = hexToOklch(hex);
  return oklchToHex(0.52, Math.min(0.13, C * 1.6 + 0.01), h);
}

// Gemini's real-world color → a bright paint: pastel or vibrant, never dark or muddy.
//   white / gray / black → an airy pastel tint
//   light, soft colors   → pastel
//   everything else      → vibrant, lifted out of the dark range (brown becomes amber)
function paintColor(hex) {
  const { L, C, h } = hexToOklch(hex);
  if (C < 0.035) return oklchToHex(Math.min(0.92, 0.86 + L * 0.06), 0.04, C < 0.01 ? 4.9 : h);
  if ((C < 0.1 && L > 0.72) || C < 0.06) return oklchToHex(Math.min(0.92, Math.max(0.84, L)), Math.min(0.11, Math.max(0.07, C)), h);
  // Each hue is most vivid at its own lightness (red lower, yellow higher): step down from the
  // lifted lightness until the hue can be properly saturated.
  const lift = L < 0.68 ? 0.7 + (L / 0.68) * 0.06 : Math.min(0.92, L);
  let Lv = lift;
  for (let l = lift; l >= 0.62; l -= 0.01) {
    if (maxChroma(l, h) >= 0.17) { Lv = l; break; }
  }
  return oklchToHex(Lv, Math.min(0.24, Math.max(0.17, C * 1.15)), h);
}

// The most saturated an OKLCH color of this lightness and hue can be in sRGB.
function maxChroma(L, h) {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const rgb = oklabToLinear([L, mid * Math.cos(h), mid * Math.sin(h)]);
    if (rgb.every(v => v >= -0.0005 && v <= 1.0005)) lo = mid; else hi = mid;
  }
  return lo;
}

// Used when Gemini can't answer: half bold, half pastel.
function randomColor() {
  const h = Math.random() * Math.PI * 2;
  return Math.random() < 0.5
    ? oklchToHex(0.72 + Math.random() * 0.1, 0.16 + Math.random() * 0.05, h)
    : oklchToHex(0.86, 0.09, h);
}

// ---------------------------------------------------------------------------
// Strokes → masks
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Draws the strokes into a canvas, offset so the bbox corner is (0,0), scaled by d.
function strokeCanvas(strokes, ox, oy, d, W, H, lineWidth) {
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  for (const s of strokes) {
    if (s.length === 1) {
      ctx.beginPath();
      ctx.arc((s[0].x - ox) * d, (s[0].y - oy) * d, lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo((s[0].x - ox) * d, (s[0].y - oy) * d);
    for (let i = 1; i < s.length; i++) ctx.lineTo((s[i].x - ox) * d, (s[i].y - oy) * d);
    ctx.stroke();
  }
  return c;
}

function alphaMask(canvas, threshold) {
  const { width: W, height: H } = canvas;
  const px = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) m[i] = px[i * 4 + 3] > threshold ? 1 : 0;
  return m;
}

// Everything reachable from the border without crossing ink = outside.
function floodOutside(ink, W, H) {
  const out = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = i => { if (!ink[i] && !out[i]) { out[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % W, y = (i / W) | 0;
    if (x > 0) push(i - 1);
    if (x < W - 1) push(i + 1);
    if (y > 0) push(i - W);
    if (y < H - 1) push(i + W);
  }
  return out;
}

// Square dilation with running sums (fast, separable).
function dilate(src, W, H, r) {
  if (r <= 0) return src.slice();
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let count = 0;
    for (let x = 0; x <= r && x < W; x++) count += src[row + x];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = count > 0 ? 1 : 0;
      if (x + r + 1 < W) count += src[row + x + r + 1];
      if (x - r >= 0) count -= src[row + x - r];
    }
  }
  for (let x = 0; x < W; x++) {
    let count = 0;
    for (let y = 0; y <= r && y < H; y++) count += tmp[y * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = count > 0 ? 1 : 0;
      if (y + r + 1 < H) count += tmp[(y + r + 1) * W + x];
      if (y - r >= 0) count -= tmp[(y - r) * W + x];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mask → outline polygons (for physics)
// ---------------------------------------------------------------------------

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
function dirIndex(dx, dy) {
  for (let i = 0; i < 8; i++) if (N8[i][0] === dx && N8[i][1] === dy) return i;
  return 0;
}

// Moore-neighbour boundary trace of one labelled component.
function traceComponent(labels, W, H, label, sx, sy) {
  const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && labels[y * W + x] === label;
  const pts = [];
  let x = sx, y = sy, back = 4; // came from the west
  let first = null;
  const limit = W * H * 4;
  for (let iter = 0; iter < limit; iter++) {
    let found = false, nx = 0, ny = 0, nb = 0;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      const tx = x + N8[d][0], ty = y + N8[d][1];
      if (on(tx, ty)) {
        const pd = (d + 7) % 8;
        nb = dirIndex(x + N8[pd][0] - tx, y + N8[pd][1] - ty);
        nx = tx; ny = ty; found = true;
        break;
      }
    }
    if (!found) { pts.push([x, y]); break; }
    if (first === null) first = [nx, ny];
    else if (x === sx && y === sy && nx === first[0] && ny === first[1]) break;
    pts.push([x, y]);
    x = nx; y = ny; back = nb;
  }
  return pts;
}

function simplify(points, eps) {
  if (points.length < 4) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const len = Math.hypot(bx - ax, by - ay) || 1e-9;
    let best = -1, bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const dd = Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (dd > bestD) { bestD = dd; best = i; }
    }
    if (best > 0 && bestD > eps) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Returns polygons in drawing px (relative to the bbox corner).
function maskToPolygons(fill, W, H, d) {
  const cell = Math.max(1, Math.round(2 * d));         // ~2 drawing px per cell
  const cw = Math.ceil(W / cell), ch = Math.ceil(H / cell);
  const coarse = new Uint8Array(cw * ch);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (fill[y * W + x]) coarse[((y / cell) | 0) * cw + ((x / cell) | 0)] = 1;
    }
  }
  const labels = new Int32Array(cw * ch);
  const polys = [];
  let next = 1;
  const queue = new Int32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) {
    if (!coarse[i] || labels[i]) continue;
    const label = next++;
    let qh = 0, qt = 0, size = 0;
    labels[i] = label; queue[qt++] = i;
    while (qh < qt) {
      const j = queue[qh++]; size++;
      const jx = j % cw, jy = (j / cw) | 0;
      for (const [dx, dy] of N8) {
        const kx = jx + dx, ky = jy + dy;
        if (kx < 0 || ky < 0 || kx >= cw || ky >= ch) continue;
        const k = ky * cw + kx;
        if (coarse[k] && !labels[k]) { labels[k] = label; queue[qt++] = k; }
      }
    }
    if (size < 6) continue;                          // specks don't need collision
    const sx = i % cw, sy = (i / cw) | 0;            // first pixel in raster order
    const contour = traceComponent(labels, cw, ch, label, sx, sy)
      .map(([cx, cy]) => [((cx + 0.5) * cell) / d, ((cy + 0.5) * cell) / d]);
    const simple = simplify(contour, 1.4);
    if (simple.length >= 3) polys.push(simple);
  }
  return polys;
}

// ---------------------------------------------------------------------------
// The whole pipeline, run once when you press enter
// ---------------------------------------------------------------------------

function buildSketch(strokes, strokeW) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  if (!isFinite(minX)) return null;

  const pad = Math.ceil(strokeW / 2 + HALO + 4);
  const bx = Math.floor(minX - pad), by = Math.floor(minY - pad);
  const bw = Math.ceil(maxX + pad) - bx, bh = Math.ceil(maxY + pad) - by;

  let d = Math.min(2, window.devicePixelRatio || 1);
  const maxPixels = 1.6e6;
  if (bw * bh * d * d > maxPixels) d = Math.sqrt(maxPixels / (bw * bh));
  const W = Math.max(8, Math.round(bw * d)), H = Math.max(8, Math.round(bh * d));

  // 1. close small gaps: thick strokes → flood the outside → shrink the outside back
  const thick = alphaMask(strokeCanvas(strokes, bx, by, d, W, H, (strokeW + 2 * CLOSE_GAP) * d), 24);
  const outside = dilate(floodOutside(thick, W, H), W, H, Math.round(CLOSE_GAP * d));
  const lineCanvas = strokeCanvas(strokes, bx, by, d, W, H, strokeW * d);
  const line = alphaMask(lineCanvas, 60);

  let fill = new Uint8Array(W * H);
  let total = 0, interior = 0;
  for (let i = 0; i < W * H; i++) {
    const inside = !outside[i] || line[i];
    fill[i] = inside ? 1 : 0;
    total += fill[i];
    if (inside && !line[i]) interior++;
  }

  // 2. nothing enclosed (a squiggle, a stick figure): color sits under the line as a soft halo
  const lineOnly = interior < total * 0.2;
  if (lineOnly) fill = alphaMask(strokeCanvas(strokes, bx, by, d, W, H, (strokeW + 2 * HALO) * d), 40);

  // 3. texture: R = fill (lightly blurred edge), G = antialiased ink line
  const tex = makeCanvas(W, H);
  const tctx = tex.getContext('2d');
  const img = tctx.createImageData(W, H);
  const linePx = lineCanvas.getContext('2d').getImageData(0, 0, W, H).data;
  const fillCount = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let s = 0, n = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const xx = x + ox, yy = y + oy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        s += fill[yy * W + xx]; n++;
      }
      img.data[i * 4] = Math.round((s / n) * 255);
      img.data[i * 4 + 1] = linePx[i * 4 + 3];
      img.data[i * 4 + 2] = 0;
      img.data[i * 4 + 3] = 255;
      if (fill[i] && !line[i] && (i % 7 === 0)) fillCount.push(i);
    }
  }
  tctx.putImageData(img, 0, 0);

  // 4. where the color starts spreading from when it fills in
  let origin = [0.5, 0.5];
  if (fillCount.length) {
    const i = fillCount[Math.floor(Math.random() * fillCount.length)];
    origin = [((i % W) + 0.5) / W, 1 - (((i / W) | 0) + 0.5) / H];
  }

  // 5. physics outline (a hair bigger than the ink so pieces don't visibly overlap)
  const polys = maskToPolygons(dilate(fill, W, H, Math.round(d)), W, H, d);

  return {
    bx, by, bw: W / d, bh: H / d, d, W, H,
    tex, polys, origin, lineOnly,
    ...renderForGemini(strokes, minX, minY, maxX - minX, maxY - minY, strokeW),
  };
}

// Black lines on white, max 512px: what Gemini actually looks at.
function renderForGemini(strokes, x0, y0, w, h, strokeW) {
  const margin = 32, size = 512 - margin * 2;
  const k = size / Math.max(w, h, 1);
  const c = makeCanvas(Math.round(w * k) + margin * 2, Math.round(h * k) + margin * 2);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const lw = Math.max(3, strokeW * k * 0.8);
  const drawn = strokeCanvas(strokes, x0 - margin / k, y0 - margin / k, k, c.width, c.height, lw);
  ctx.drawImage(drawn, 0, 0);
  // frame: how to turn Gemini's 0-1000 box coordinates back into screen px
  return { png: c.toDataURL('image/png').split(',')[1], frame: { x0, y0, k, margin, w: c.width, h: c.height } };
}

// ---------------------------------------------------------------------------
// Gemini's parts → a color map for the drawing (each part's color where Gemini
// says that part is, blended softly where parts meet, so you get gradients)
// ---------------------------------------------------------------------------

function buildColorMap(sk, parts) {
  const scale = Math.min(1, 220 / Math.max(sk.W, sk.H));
  const cw = Math.max(2, Math.round(sk.W * scale)), ch = Math.max(2, Math.round(sk.H * scale));
  const canvas = makeCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cw, ch);
  const f = sk.frame;
  const labs = parts.map(p => linearToOklab(hexToRgb(p.paint).map(srgbToLinear)));
  const sizeBoost = parts.map(p => Math.sqrt(250000 / Math.max(400, (p.box[2] - p.box[0]) * (p.box[3] - p.box[1]))));
  const SOFT = 40; // how wide the blend between parts is, in Gemini's 0-1000 units

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      // color-map pixel → screen px → Gemini's image → 0..1000
      const sx = sk.bx + ((x + 0.5) / cw) * sk.bw;
      const sy = sk.by + ((y + 0.5) / ch) * sk.bh;
      const nx = (((sx - f.x0) * f.k + f.margin) / f.w) * 1000;
      const ny = (((sy - f.y0) * f.k + f.margin) / f.h) * 1000;
      let L = 0, A = 0, B = 0, W = 0;
      parts.forEach((p, i) => {
        const [ymin, xmin, ymax, xmax] = p.box;
        const dx = Math.max(xmin - nx, 0, nx - xmax), dy = Math.max(ymin - ny, 0, ny - ymax);
        // inside its box = full weight; smaller parts win over the big part they sit in
        const w = Math.exp(-(dx * dx + dy * dy) / (SOFT * SOFT)) * sizeBoost[i] + 1e-6;
        L += labs[i][0] * w; A += labs[i][1] * w; B += labs[i][2] * w; W += w;
      });
      const rgb = oklabToLinear([L / W, A / W, B / W]).map(v => linearToSrgb(Math.min(1, Math.max(0, v))));
      const o = (y * cw + x) * 4;
      img.data[o] = rgb[0] * 255; img.data[o + 1] = rgb[1] * 255; img.data[o + 2] = rgb[2] * 255; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function stripArticle(phrase) {
  return String(phrase || '').replace(/^(a|an|the)\s+/, '');
}

// ---------------------------------------------------------------------------
// Outline polygons → one matter.js body (concave shapes split into convex parts)
// ---------------------------------------------------------------------------

function buildBody(polys, bw, bh) {
  const { Body, Bodies, Vertices } = Matter;
  const opts = { friction: 0.9, frictionStatic: 1.2, restitution: 0, frictionAir: 0.012, slop: 0.04, density: 0.0012 };
  const parts = [];

  for (const poly of polys) {
    let chunks = [];
    try {
      const p = poly.map(([x, y]) => [x, y]);
      decomp.makeCCW(p);
      decomp.removeCollinearPoints(p, 0.03);
      if (decomp.removeDuplicatePoints) decomp.removeDuplicatePoints(p, 0.4);
      if (p.length < 3) continue;
      chunks = decomp.isSimple(p) ? decomp.quickDecomp(p) : [];
      if (!chunks.length) {
        chunks = [Vertices.hull(p.map(([x, y]) => ({ x, y }))).map(v => [v.x, v.y])];
      }
    } catch (e) {
      chunks = [Vertices.hull(poly.map(([x, y]) => ({ x, y }))).map(v => [v.x, v.y])];
    }
    for (const chunk of chunks) {
      const verts = chunk.map(([x, y]) => ({ x, y }));
      if (verts.length < 3 || Vertices.area(verts) < 12) continue;
      parts.push(Body.create(Object.assign({ position: Vertices.centre(verts), vertices: verts }, opts)));
    }
  }

  if (parts.length === 0) return Bodies.rectangle(bw / 2, bh / 2, Math.max(8, bw * 0.7), Math.max(8, bh * 0.7), opts);
  if (parts.length === 1) return parts[0];
  return Body.create(Object.assign({ parts: parts.slice(0) }, opts));
}
