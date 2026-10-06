// sketch.js
// Draw something and press enter. Gemini guesses what it is and what color that thing
// usually is. The drawing gets painted in a pastel of that color, drops into the glass,
// and once it lands its paint bleeds into its neighbours, about halfway, so every
// drawing keeps some of its own color.
//
// Tabs:
//   sketch.js  drawing, the flow of each drawing, matter.js physics, text
//   glass.js   three.js glass (transmission material) + the watercolor simulation
//   shapes.js  outline → filled shape → physics body, pastel color math
//   gemini.js  the Gemini call (put your API key there)
//
// Keys: enter drops the drawing in, z undoes a line, esc clears, r pours the glass out.

// If anything breaks, say so on the page instead of leaving it blank.
window.addEventListener('error', e => showProblem(e.message + (e.lineno ? ' (line ' + e.lineno + ')' : '')));
window.addEventListener('unhandledrejection', e => showProblem(String((e.reason && e.reason.message) || e.reason)));
function showProblem(msg) {
  let el = document.getElementById('color-cup-problem');
  if (!el) {
    el = document.createElement('div');
    el.id = 'color-cup-problem';
    Object.assign(el.style, {
      position: 'fixed', left: '12px', top: '12px', right: '12px', zIndex: '10', font: '14px/1.4 monospace',
      color: '#8f2a1c', background: '#fff6f3', border: '1px solid #e9c6bd', borderRadius: '6px', padding: '8px 10px', whiteSpace: 'pre-wrap',
    });
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = 'something broke: ' + msg;
}

const STROKE_W = 2.6;
const GLASS_OUTLINE = true;  // a thin ink line around the 3D glass, like the drawings
const FONT = '"Gaegu", "Patrick Hand", "Comic Neue", cursive';
const LIBS = {
  matter: 'https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.20.0/matter.min.js',
  decomp: 'https://cdn.jsdelivr.net/npm/poly-decomp@0.3.0/build/decomp.min.js',
  three: 'https://cdn.jsdelivr.net/npm/three@0.183.2/build/three.module.js',
  font: 'https://fonts.googleapis.com/css2?family=Gaegu:wght@400;700&display=swap',
};

let strokes = [];          // finished lines of the drawing in progress
let currentStroke = null;  // the line being drawn right now
let drops = [];            // every drawing that has been sent off
let guesses = [];          // the last few things Gemini said
let glass = null;
let engine = null;
let ready = false;
let bootError = null;
let notice = null;
let physicsLag = 0;
let dropButton = null;
let glassLines = null;      // cached screen-space outline of the glass
let canvasEl = null;
let guessBox = { right: 0, top: 0 };   // where the guess list sits, so the hint can avoid it
let topWord = null;                    // Gemini's latest guess of what you drew

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setup() {
  const cnv = createCanvas(windowWidth, windowHeight);
  canvasEl = cnv.elt;
  pinToWindow(canvasEl, 2);
  canvasEl.style.touchAction = 'none';
  canvasEl.tabIndex = 0;            // so it can take keyboard focus
  canvasEl.style.outline = 'none';
  document.body.style.background = PAPER_HEX;
  document.body.style.margin = '0';
  document.body.style.userSelect = 'none';
  boot();
}

async function boot() {
  try {
    await loadLibraries();
    glass = new GlassScene();
    glass.init();
    initPhysics();
    addPaperGrain();
    ready = true;
  } catch (err) {
    console.error(err);
    bootError = err;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}

async function loadLibraries() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = LIBS.font;
  document.head.appendChild(link);

  const jobs = [import(LIBS.three).then(mod => { THREE = mod; })];
  if (!window.Matter) jobs.push(loadScript(LIBS.matter));
  if (!window.decomp) jobs.push(loadScript(LIBS.decomp));
  await Promise.all(jobs);
  try {
    await Promise.race([
      Promise.all([document.fonts.load('20px "Gaegu"'), document.fonts.load('700 20px "Gaegu"')]),
      new Promise(r => setTimeout(r, 2500)),
    ]);
  } catch (e) { /* the fallback font is fine */ }
}

function glassPhysics() {
  return {
    yBottom: -GLASS.TB * PX,
    yRim: -GLASS.H * PX,
    rBottom: innerRadiusAt(GLASS.TB) * PX,
    rRim: innerRadiusAt(GLASS.H) * PX,
  };
}

function initPhysics() {
  const { Engine, Bodies, Composite } = Matter;
  engine = Engine.create({ enableSleeping: true, positionIterations: 10, velocityIterations: 8 });
  engine.gravity.y = 1;
  engine.gravity.scale = 0.0011;

  // The inside of the glass: two slanted walls and a floor, matching the 3D glass exactly.
  const P = glassPhysics();
  const th = 18;
  const statics = [];
  for (const side of [-1, 1]) {
    const x0 = side * P.rBottom, y0 = P.yBottom, x1 = side * P.rRim, y1 = P.yRim;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    let nx = -uy, ny = ux;
    if (nx * side < 0) { nx = -nx; ny = -ny; }
    const cx = (x0 + x1) / 2 + nx * th / 2 - ux * 20;
    const cy = (y0 + y1) / 2 + ny * th / 2 - uy * 20;
    statics.push(Bodies.rectangle(cx, cy, len + 40, th, { isStatic: true, angle: Math.atan2(uy, ux), friction: 0.4 }));
  }
  statics.push(Bodies.rectangle(0, P.yBottom + 40, P.rBottom * 2 + 60, 80, { isStatic: true, friction: 0.6 }));
  statics.push(Bodies.rectangle(0, 40, 8000, 80, { isStatic: true, friction: 0.7 })); // the table
  Composite.add(engine.world, statics);
  Matter.Events.on(engine, 'beforeUpdate', applyWater);
}

// Below the waterline drawings get drag and some buoyancy, so they sink gently.
function applyWater() {
  const g = engine.gravity;
  const waterline = -WATER_Y * PX;
  for (const d of drops) {
    const b = d.body;
    if (!d.inWorld || b.isStatic) continue;
    const top = b.bounds.min.y, bottom = b.bounds.max.y;
    const yWorld = Math.max(GLASS.TB, -b.position.y / PX);
    const inside = Math.abs(b.position.x) < innerRadiusAt(yWorld) * PX && b.position.y < 0;
    const depth = inside ? Math.min(1, Math.max(0, (bottom - waterline) / Math.max(1, bottom - top))) : 0;
    d.waterDepth = depth;
    b.frictionAir = 0.012 + 0.09 * depth;
    Matter.Body.applyForce(b, b.position, { x: 0, y: -b.mass * g.y * g.scale * 0.5 * depth });
  }
}

function stepPhysics(dt) {
  const step = 1 / 60;
  physicsLag += dt;
  let n = 0;
  while (physicsLag >= step && n < 4) {
    Matter.Engine.update(engine, step * 1000);
    physicsLag -= step;
    n++;
  }
  if (n === 4) physicsLag = 0;
}

function addPaperGrain() {
  const size = 220;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 236 + Math.random() * 19;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const div = document.createElement('div');
  Object.assign(div.style, {
    position: 'fixed', left: '0', top: '0', right: '0', bottom: '0', pointerEvents: 'none', zIndex: '3',
    backgroundImage: `url(${c.toDataURL()})`, mixBlendMode: 'multiply', opacity: '0.35',
  });
  document.body.appendChild(div);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function draw() {
  clear();
  if (!ready) { drawStatus(); return; }
  const dt = Math.min(0.05, (deltaTime || 16.7) / 1000);
  stepPhysics(dt);
  for (const d of drops) d.update(dt);
  drops = drops.filter(d => !d.gone);
  glass.render(dt);

  if (GLASS_OUTLINE) drawGlassOutline();
  drawStrokes();
  drawCaptions();
  drawGuessList();
  drawHint();
  drawTopWord();
}

// ---------------------------------------------------------------------------
// One drawing's life: asking → named → filling → falling → (frozen) mixing or resting
// ---------------------------------------------------------------------------

class Drop {
  constructor(sk) {
    this.sk = sk;
    this.state = 'asking';
    this.t = 0;
    this.stillT = 0;
    this.inWorld = false;

    // physics body in drawing px; its position is the center of mass
    this.body = buildBody(sk.polys, sk.bw, sk.bh);
    this.com = { x: this.body.position.x, y: this.body.position.y };
    const b = this.body.bounds;
    this.extent = { left: this.com.x - b.min.x, right: b.max.x - this.com.x, top: this.com.y - b.min.y, bottom: b.max.y - this.com.y };

    // start exactly where it was drawn, so the hand-off from p5 to three.js is invisible
    const sx = sk.bx + this.com.x, sy = sk.by + this.com.y;
    const p = glass.screenToWorld(sx, sy);
    this.pose = { x: p.x, y: p.y, a: 0, s: glass.worldPerPixel(sx, sy) };
    this.view = glass.addSketch(sk, this.com);
    this.view.setPose(this.pose);

    const fs = fontSize();
    this.caption = sk.by > fs * 3.2
      ? { x: sk.bx + 10, y: sk.by + 4 - fs * 2.4 }
      : { x: sk.bx + 10, y: sk.by + sk.bh + 2 };
    this.ask();
  }

  // Step 1: what is it? Step 2: knowing that, what colors are its parts?
  async ask() {
    let named = true;
    try {
      this.object = (await askGeminiWhatItIs(this.sk.png)).object;
    } catch (err) {
      named = false;
      this.object = 'something';
      this.colors = fallbackColors();
      notice = { text: describeGeminiError(err), until: millis() + 7000 };
    }
    if (this.gone) return;
    topWord = { text: named ? stripArticle(this.object) : '?', t0: millis() };
    this.go('named');
    if (!named) return;
    try {
      this.colors = await askGeminiForColors(this.sk.png, this.object);
    } catch (err) {
      this.colors = fallbackColors();
      notice = { text: describeGeminiError(err), until: millis() + 7000 };
    }
  }

  applyColors() {
    this.parts = this.colors.parts.map(p => {
      const paint = paintColor(p.hex);
      return Object.assign({}, p, { paint, ink: labelInk(paint) });
    });
    this.view.setColorMap(buildColorMap(this.sk, this.parts));
    guesses.push({ object: this.object, parts: this.parts });
    while (guesses.length > 3) guesses.shift();
    this.go('filling');
  }

  go(state) { this.state = state; this.t = 0; }

  update(dt) {
    this.t += dt;
    const v = this.view;
    switch (this.state) {
      case 'asking':
      case 'named':
        v.set('uBoil', 1.2);
        v.set('uBoilSeed', Math.floor(millis() / 120) % 64);
        // give the word at the top a moment on its own before the colors arrive
        if (this.state === 'named' && this.colors && this.t > 0.8) this.applyColors();
        break;
      case 'filling':
        v.set('uBoil', 0);
        v.set('uReveal', easeOutCubic(Math.min(1, this.t / 0.9)));
        if (this.t > 1.0) this.startFall();
        break;
      default:
        if (!this.inWorld) break;
        this.syncFromBody();
        if (this.state === 'falling') this.checkLanding(dt);
        if (this.state === 'mixing') v.set('uDissolve', Math.min(1, this.t / 2.6));
        if (this.state === 'leaving') {
          v.set('uFade', Math.max(0, 1 - this.t / 0.8));
          if (this.t > 0.8) this.remove();
        }
        if (this.body.position.y > 3000) this.remove();
    }
  }

  // Falls straight down from where it was drawn, at the size it was drawn.
  startFall() {
    const { Body, Composite, Query } = Matter;
    this.sDrop = this.pose.s * PX; // physics px per drawing px
    Body.scale(this.body, this.sDrop, this.sDrop);
    Body.setPosition(this.body, { x: this.pose.x * PX, y: -this.pose.y * PX });
    // Drawn on top of the glass or the pile? Lift it just clear, so physics doesn't fling it.
    const others = Composite.allBodies(engine.world);
    for (let i = 0; i < 150 && Query.collides(this.body, others).length > 0; i++) {
      Body.translate(this.body, { x: 0, y: -5 });
    }
    Body.setVelocity(this.body, { x: 0, y: 0 });
    Body.setAngularVelocity(this.body, (Math.random() - 0.5) * 0.01);
    Composite.add(engine.world, this.body);
    this.inWorld = true;
    this.go('falling');
  }

  syncFromBody() {
    const b = this.body;
    this.pose = { x: b.position.x / PX, y: -b.position.y / PX, a: -b.angle, s: this.sDrop / PX };
    this.view.setPose(this.pose);
  }

  checkLanding(dt) {
    const b = this.body;
    const still = b.isSleeping || (b.speed < 0.25 && Math.abs(b.angularVelocity) < 0.01);
    this.stillT = still ? this.stillT + dt : 0;
    if (this.stillT < 0.25 && this.t < 7) return;
    // Settled: freeze it, so it stops wobbling and later drawings can't push it around.
    Matter.Body.setStatic(b, true);
    this.syncFromBody();
    const bottomY = -b.bounds.max.y / PX; // its lowest point, in world units
    const overGlass = b.position.y < 0 && Math.abs(this.pose.x) < innerRadiusAt(Math.min(WATER_Y, Math.max(GLASS.TB, bottomY)));
    if (overGlass && bottomY < WATER_Y) {
      glass.stamp(this.view, this.pose); // its colors go into the water
      this.go('mixing');
    } else {
      this.go('resting'); // caught on the rim or spilled: stays solid
    }
  }

  remove() {
    if (this.inWorld) Matter.Composite.remove(engine.world, this.body);
    this.inWorld = false;
    this.view.dispose();
    this.gone = true;
  }
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function submitDrawing() {
  if (!ready || strokes.length === 0) return;
  const sk = buildSketch(strokes, STROKE_W);
  if (!sk) return;
  drops.push(new Drop(sk));
  strokes = [];
}

function pourOut() {
  if (!ready) return;
  for (const d of drops) if (d.inWorld && d.state !== 'leaving') d.go('leaving');
  glass.field.fadeOut(0.8);
}

function glassIsFull() {
  const P = glassPhysics();
  return drops.some(d => d.inWorld && d.body.isStatic &&
    d.body.bounds.min.y < P.yRim + 14 && Math.abs(d.body.position.x) < P.rRim);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function mousePressed(event) {
  // Take keyboard focus, so enter / z / r reach the sketch even when it runs
  // inside an iframe (OpenProcessing, previews). Mouse clicks are left alone so the
  // browser can focus the frame too; only touch gets its default (scrolling) blocked.
  window.focus();
  if (canvasEl) canvasEl.focus({ preventScroll: true });
  const touch = event && (String(event.type).startsWith('touch') || event.pointerType === 'touch');
  if (!ready) return touch ? false : undefined;
  if (dropButton && mouseX >= dropButton.x && mouseX <= dropButton.x + dropButton.w &&
      mouseY >= dropButton.y && mouseY <= dropButton.y + dropButton.h) {
    submitDrawing();
    return touch ? false : undefined;
  }
  currentStroke = [{ x: mouseX, y: mouseY }];
  return touch ? false : undefined;
}

function mouseDragged() {
  if (!currentStroke) return false;
  const last = currentStroke[currentStroke.length - 1];
  if (Math.hypot(mouseX - last.x, mouseY - last.y) >= 1.5) currentStroke.push({ x: mouseX, y: mouseY });
  return false;
}

function mouseReleased() {
  if (currentStroke) strokes.push(currentStroke);
  currentStroke = null;
  return false;
}

function keyPressed() {
  if (key === 'Enter' || keyCode === 13) { submitDrawing(); return false; }
  if (key === 'z' || key === 'Z' || key === 'Backspace' || keyCode === 8) { strokes.pop(); return false; }
  if (key === 'Escape' || keyCode === 27) { strokes = []; currentStroke = null; return false; }
  if (key === 'r' || key === 'R') { pourOut(); return false; }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (glass) glass.resize(windowWidth, windowHeight);
  glassLines = null;
}

// ---------------------------------------------------------------------------
// Drawing the 2D layer (lines in progress + handwritten text)
// ---------------------------------------------------------------------------

function fontSize() { return Math.max(15, Math.min(22, Math.min(width, height) * 0.026)); }

function label(str, x, y, o = {}) {
  const ctx = drawingContext;
  ctx.save();
  ctx.font = `${o.weight || 400} ${o.size || fontSize()}px ${FONT}`;
  ctx.fillStyle = o.color || INK_HEX;
  ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.baseline || 'alphabetic';
  ctx.fillText(str, x, y);
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

function drawStrokes() {
  push();
  noFill();
  stroke(INK_HEX);
  strokeWeight(STROKE_W);
  strokeJoin(ROUND);
  strokeCap(ROUND);
  const all = currentStroke ? strokes.concat([currentStroke]) : strokes;
  for (const s of all) {
    if (s.length === 1) { point(s[0].x, s[0].y); continue; }
    beginShape();
    for (const p of s) vertex(p.x, p.y);
    endShape();
  }
  pop();
}

// Slightly wobbly, like the lines in the reference drawing.
function inkPath(pts, closed, seed) {
  beginShape();
  pts.forEach((p, i) => {
    const n = noise(seed + i * 0.09) - 0.5;
    vertex(p.x + n * 1.2, p.y + n * 1.2);
  });
  if (closed) endShape(CLOSE); else endShape();
}

function drawGlassOutline() {
  if (!glassLines) glassLines = glass.outline();
  const g = glassLines;
  push();
  noFill();
  stroke(INK_HEX);
  strokeWeight(STROKE_W * 0.85);
  strokeJoin(ROUND);
  strokeCap(ROUND);
  inkPath(g.left, false, 10);
  inkPath(g.right, false, 30);
  inkPath(g.rim, true, 50);
  inkPath(g.base, false, 70);
  stroke('#8a8a8a');               // the waterline, a little lighter than the glass
  strokeWeight(STROKE_W * 0.6);
  inkPath(g.water, true, 90);
  pop();
}

// Color names in a row, each written in its own color.
function colorNames(parts, x, y, size, alpha = 1) {
  let cx = x;
  parts.forEach((p, i) => {
    cx += label(p.colorName + (i < parts.length - 1 ? ',' : ''), cx, y, { size, color: p.ink, alpha }) + size * 0.3;
  });
  return cx - x;
}

function drawCaptions() {
  const fs = fontSize();
  const dots = '.'.repeat(1 + (Math.floor(millis() / 350) % 3));
  for (const d of drops) {
    const { x, y } = d.caption;
    if (d.state === 'asking') {
      label('hmm' + dots, x, y + fs, { size: fs * 1.1, color: '#9a9a9a' });
    } else if (d.state === 'named') {
      label('colors' + dots, x, y + fs, { size: fs * 1.1, color: '#9a9a9a' });
    } else if (d.parts && (d.state === 'filling' || (d.state === 'falling' && d.t < 0.6))) {
      const alpha = d.state === 'falling' ? Math.max(0, 1 - d.t / 0.6) : Math.min(1, d.t / 0.3);
      colorNames(d.parts, x, y + fs, fs * 1.1, alpha);
    }
  }
}

// What Gemini thinks you drew, big at the top, before the colors come in.
function drawTopWord() {
  if (!topWord) return;
  const size = Math.max(32, Math.min(64, Math.min(width, height) * 0.068));
  const alpha = Math.min(1, (millis() - topWord.t0) / 350);
  label(topWord.text, width / 2, 16 + size, { size, align: 'center', weight: 700, alpha });
}

// Bottom left, like the little handwritten stack in the reference.
function drawGuessList() {
  const fs = fontSize() * 1.2;
  const lineH = fs * 1.15;
  let y = height - 24 - lineH * (guesses.length - 1);
  guessBox = { right: 0, top: y - fs };
  for (const g of guesses) {
    const w = label(g.object, 26, y, { size: fs });
    const w2 = colorNames(g.parts, 26 + w + fs * 0.45, y, fs);
    guessBox.right = Math.max(guessBox.right, 26 + w + fs * 0.45 + w2);
    y += lineH;
  }
}

function textWidth2(str, size, weight = 400) {
  const ctx = drawingContext;
  ctx.save();
  ctx.font = `${weight} ${size}px ${FONT}`;
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

function drawHint() {
  const fs = fontSize();
  const x = width - 26;
  const narrow = width < 760;
  dropButton = null;

  let main, size = fs, weight = 400, color = '#8a8a8a', sub = null, button = false;
  if (strokes.length || currentStroke) {
    main = 'drop it in'; size = fs * 1.3; weight = 700; color = INK_HEX; button = true;
    sub = narrow ? null : 'enter works too, z undoes a line';
  } else if (!drops.length) {
    main = narrow ? 'draw above the glass, then enter' : 'draw something above the glass, then press enter';
  } else if (glassIsFull()) {
    main = narrow ? 'full! r pours it out' : 'the glass is full. press r to pour it out';
  } else {
    main = narrow ? 'r pours it out' : 'draw the next thing. r pours the glass out';
    color = '#a8a8a8';
  }

  // If it would run into the guess list, use the top corner instead.
  const w = textWidth2(main, size, weight);
  const crowded = guesses.length > 0 && x - w < guessBox.right + 20;
  const y = crowded ? 22 + size : height - 24;
  const subY = crowded ? y + fs * 1.4 : y - fs * 1.45;

  label(main, x, y, { size, weight, color, align: 'right' });
  if (button) {
    push();
    noFill();
    stroke(INK_HEX);
    strokeWeight(1.6);
    beginShape();
    for (let i = 0; i <= 12; i++) vertex(x - w + (w * i) / 12, y + 5 + Math.sin(i * 1.7) * 1.2);
    endShape();
    pop();
    dropButton = { x: x - w - 12, y: y - size * 1.1, w: w + 24, h: size * 1.6 };
  }
  if (sub) label(sub, x, subY, { size: fs * 0.9, align: 'right', color: '#9a9a9a' });
  if (notice && millis() < notice.until) {
    const ny = crowded ? (sub ? subY : y) + fs * 1.5 : (sub ? subY : y) - fs * 1.5;
    label(notice.text, x, ny, { size: fs * 0.95, align: 'right', color: '#7a6a5e' });
  }
}

function drawStatus() {
  const msg = bootError ? "couldn't set up the glass: " + bootError.message : 'setting up the glass…';
  label(msg, 26, height - 24, { size: fontSize(), color: '#8a8a8a' });
}
