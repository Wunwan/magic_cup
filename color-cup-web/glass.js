// glass.js
// The three.js half: a transmission-material glass, the drawings inside it,
// and a small GPU watercolor simulation where their colors bleed and half-mix.
//
// Coordinates: three.js world units, y up. The glass stands on y = 0.
// matter.js runs in "physics px" = world * PX, with y flipped (y down).

let THREE = null; // filled in by sketch.js (dynamic import)

const PAPER_HEX = '#fcfcfb';
const INK_HEX = '#232323';
const WATER_HEX = '#f3f7f6';  // clear water, just a touch cooler than the paper
const GLASS = { RB: 1.16, RT: 1.42, H: 3.3, T: 0.06, TB: 0.07 }; // bottom/top outer radius, height, wall, base (thin, so the water reaches the bottom)
const PX = 100;          // physics px per world unit
const FIELD_RES = 150;   // watercolor texels per world unit
const WATER_LEVEL = 0.78; // how full of water the glass is (0..1)
const WATER_Y = GLASS.TB + (GLASS.H - GLASS.TB) * WATER_LEVEL;

// How the color bleeds into the water.
// Lower SPREAD = bigger halos. Lower CALM_DOWN = the water stays stirred longer.
// Lower MIX = different colors blend less where they meet (cleaner seams, less smudge).
const WATERCOLOR = {
  SPREAD: 0.016,       // cost per texel for the stirred-up water to reach outward
  CALM_DOWN: 0.0016,   // per sim step; the water settles in about 5 seconds
  PIGMENT_RATE: 0.3,   // how eagerly color spreads into clear water
  PIGMENT_REACH: 3.5,  // texels; how far each step can reach
  SWIRL: 0.12,         // a little curl, like ink in water
  SINK: 0.02,          // ink barely sinks
  MIX: 0.01,           // how readily two different colors blend
};

function innerRadiusAt(y) { return (GLASS.RB - GLASS.T) + (GLASS.RT - GLASS.RB) * (y / GLASS.H); }
function insideGlassWorld(x, y) { return y > GLASS.TB && y < GLASS.H && Math.abs(x) < innerRadiusAt(y); }
function inWaterWorld(x, y) { return y > GLASS.TB && y < WATER_Y && Math.abs(x) < innerRadiusAt(y); }

function pinToWindow(el, z) {
  Object.assign(el.style, { position: 'fixed', left: '0', top: '0', zIndex: String(z), display: 'block' });
}

function cupUniforms() {
  return {
    uRBin: { value: GLASS.RB - GLASS.T },
    uSlope: { value: (GLASS.RT - GLASS.RB) / GLASS.H },
    uTB: { value: GLASS.TB },
    uH: { value: WATER_Y }, // everything below the waterline
  };
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const GLSL_COMMON = /* glsl */`
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + 17.17; a *= 0.5; } return s / 0.9375; }
uniform float uRBin; uniform float uSlope; uniform float uTB; uniform float uH;
float insideCup(vec2 w){ return step(abs(w.x), uRBin + uSlope * w.y) * step(uTB, w.y) * step(w.y, uH); }
`;

// --- one drawing: ink line + solid fill that later soaks into the watercolor ---
const SKETCH_VERT = /* glsl */`
varying vec2 vUv; varying vec2 vWorld;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xy;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SKETCH_FRAG = /* glsl */`
uniform sampler2D uMap;          // r = fill mask, g = ink line
uniform sampler2D uColorMap;     // the colors Gemini picked, per part
uniform vec3 uInk;
uniform vec2 uTexSize;           // drawing px
uniform vec2 uMisreg;            // tiny print-style offset of the color under the line
uniform vec2 uOrigin;            // where the color starts filling in
uniform float uReveal, uDissolve, uFade, uSeed, uBoil, uBoilSeed;
varying vec2 vUv; varying vec2 vWorld;
${GLSL_COMMON}
float fillAt(vec2 uv){ return texture2D(uMap, uv - uMisreg).r; }
void main(){
  vec2 px = vUv * uTexSize;

  // while Gemini is looking, the line "boils" a little, like hand-drawn animation
  vec2 boil = vec2(vnoise(px / 24.0 + uBoilSeed * 7.31), vnoise(px / 24.0 + uBoilSeed * 3.17 + 40.0)) - 0.5;
  float line = texture2D(uMap, vUv + boil * 2.0 * uBoil / uTexSize).g;

  // the color grows out from one spot with a ragged edge
  float f = fillAt(vUv);
  float maxD = length(uTexSize);
  float grow = uReveal * maxD * 1.35 - length((vUv - uOrigin) * uTexSize) - (fbm(px / 38.0 + uSeed * 11.0) - 0.5) * maxD * 0.28;
  f *= smoothstep(0.0, 3.0, grow) * smoothstep(0.0, 0.05, uReveal); // nothing at all until the colors arrive

  // once it has landed, the solid color soaks into the watercolor below, in patches
  float soak = fbm(px / 22.0 + uSeed * 23.0);
  float underwater = step(abs(vWorld.x), uRBin + uSlope * vWorld.y + 0.05) * step(vWorld.y, uH);
  f *= mix(1.0, smoothstep(0.0, 0.06, soak - (uDissolve * 1.15 - 0.06)), underwater);

  // a hint of watercolor inside the solid: faint streaks and a slightly deeper rim
  float around = 0.0;
  for (int i = 0; i < 6; i++){ float a = float(i) * 1.0472; around += fillAt(vUv + vec2(cos(a), sin(a)) * 2.5 / uTexSize); }
  float rim = clamp((fillAt(vUv) - around / 6.0) * 2.0, 0.0, 1.0);
  float streak = fbm(px / vec2(14.0, 70.0) + uSeed * 5.0) - 0.5;
  vec3 fillCol = texture2D(uColorMap, vUv - uMisreg).rgb * (1.0 - 0.06 * streak) * (1.0 - 0.08 * rim);

  float a = f * (1.0 - line) + line;
  if (a * uFade < 0.03) discard;
  vec3 col = (fillCol * f * (1.0 - line) + uInk * line) / max(a, 1e-4);
  gl_FragColor = vec4(col, a * uFade);
  #include <colorspace_fragment>
}`;

// --- watercolor simulation passes (full-screen quads on small float textures) ---
const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Water creeps outward through "paper fibres" (noise) and slowly evaporates.
const WATER_FRAG = /* glsl */`
uniform sampler2D uWater; uniform sampler2D uPaper; uniform vec2 uTexel; uniform vec4 uRect; uniform float uEvap; uniform float uCost;
varying vec2 vUv;
${GLSL_COMMON}
void main(){
  vec2 world = mix(uRect.xy, uRect.zw, vUv);
  float perm = texture2D(uPaper, vUv).r;
  float c = uCost * mix(2.6, 0.25, smoothstep(0.3, 0.75, perm));
  float d = c * 1.41421;
  float m = texture2D(uWater, vUv).r;
  m = max(m, texture2D(uWater, vUv + vec2( uTexel.x, 0.0)).r - c);
  m = max(m, texture2D(uWater, vUv + vec2(-uTexel.x, 0.0)).r - c);
  m = max(m, texture2D(uWater, vUv + vec2(0.0,  uTexel.y)).r - c);
  m = max(m, texture2D(uWater, vUv + vec2(0.0, -uTexel.y)).r - c);
  m = max(m, texture2D(uWater, vUv + uTexel).r - d);
  m = max(m, texture2D(uWater, vUv - uTexel).r - d);
  m = max(m, texture2D(uWater, vUv + vec2(uTexel.x, -uTexel.y)).r - d);
  m = max(m, texture2D(uWater, vUv + vec2(-uTexel.x, uTexel.y)).r - d);
  m = max(m - uEvap, 0.0) * insideCup(world);
  gl_FragColor = vec4(m, 0.0, 0.0, 1.0);
}`;

// Pigment only moves where it's wet. Stored as (K/S * amount, amount) so mixing
// behaves like paint (Kubelka-Munk): blue + yellow → green, not grey.
const PIGMENT_FRAG = /* glsl */`
uniform sampler2D uPig; uniform sampler2D uWater; uniform vec2 uTexel; uniform vec4 uRect;
uniform float uRate; uniform float uReach; uniform float uSeed; uniform float uTime; uniform float uSwirl; uniform float uSink; uniform float uMix;
varying vec2 vUv;
${GLSL_COMMON}
float flowNoise(vec2 q){ return vnoise(q + vec2(uTime, -uTime * 0.7)) + 0.5 * vnoise(q * 2.1 - vec2(uTime * 1.3, uTime * 0.4)); }
void main(){
  vec2 world = mix(uRect.xy, uRect.zw, vUv);
  vec4 p = texture2D(uPig, vUv);
  float w = texture2D(uWater, vUv).r;
  if (w > 0.003) {
    vec2 tp = vUv / uTexel;
    // slow eddies: the curl of a drifting noise field, so the ink curls instead of just blurring
    vec2 q = tp * 0.03; float e = 0.35;
    vec2 vel = vec2(flowNoise(q + vec2(0.0, e)) - flowNoise(q - vec2(0.0, e)),
                  -(flowNoise(q + vec2(e, 0.0)) - flowNoise(q - vec2(e, 0.0)))) / (2.0 * e);
    vec2 flow = vel * uSwirl - vec2(0.0, uSink * smoothstep(0.0, 0.1, vUv.y)); // swirl + slow sinking
    vec2 src = vUv - flow * clamp(w, 0.0, 1.0) * uTexel;
    float a0 = hash12(tp + uSeed) * 6.2831853;
    vec4 here = texture2D(uPig, src);
    vec3 hereCol = here.rgb / max(here.a, 1e-4);
    vec4 acc = vec4(0.0); float ws = 0.0;
    for (int i = 0; i < 6; i++){
      float a = a0 + float(i) * 1.0471976;
      float r = uReach * (0.45 + 1.1 * hash12(tp * 1.37 + float(i) * 7.0 + uSeed));
      vec2 uv2 = src + vec2(cos(a), sin(a)) * r * uTexel;
      float w2 = texture2D(uWater, uv2).r;
      vec4 q = texture2D(uPig, uv2);
      float k = w2 > 0.003 ? min(w, w2) : 0.0;
      // inks spread freely into clear water, but barely into a different color
      if (here.a > 0.04 && q.a > 0.04) { vec3 d = q.rgb / q.a - hereCol; k *= exp(-dot(d, d) / uMix); }
      acc += q * k; ws += k;
    }
    p = ws > 1e-5 ? mix(here, acc / ws, uRate * clamp(w * 1.6, 0.0, 1.0)) : here;
  }
  gl_FragColor = p * insideCup(world);
}`;

// Writes one landed drawing into the pigment (mode 0) or water (mode 1) texture.
const STAMP_FRAG = /* glsl */`
uniform sampler2D uPrev; uniform sampler2D uMap; uniform sampler2D uColorMap; uniform vec4 uRect;
uniform vec2 uPos; uniform float uAng; uniform vec2 uOff; uniform vec2 uSize; uniform vec2 uMisreg;
uniform float uMode; uniform float uWet; uniform float uAmount;
varying vec2 vUv;
${GLSL_COMMON}
void main(){
  vec4 prev = texture2D(uPrev, vUv);
  vec2 world = mix(uRect.xy, uRect.zw, vUv);
  vec2 d = world - uPos;
  float c = cos(uAng), s = sin(uAng);
  vec2 local = vec2(c * d.x + s * d.y, -s * d.x + c * d.y) - uOff;
  vec2 tuv = local / uSize + 0.5;
  float m = 0.0;
  if (tuv.x > 0.0 && tuv.y > 0.0 && tuv.x < 1.0 && tuv.y < 1.0) m = texture2D(uMap, tuv - uMisreg).r;
  m *= insideCup(world);
  vec3 ink = texture2D(uColorMap, tuv - uMisreg).rgb;
  if (uMode < 0.5) gl_FragColor = prev * (1.0 - 0.9 * m * uAmount) + vec4(ink, 1.0) * m * uAmount;
  else gl_FragColor = vec4(max(prev.r, m * uWet), 0.0, 0.0, 1.0);
}`;

// Baked once: r = paper fibres (where water creeps easily), g = grain for the paint.
const PAPER_FRAG = /* glsl */`
uniform vec2 uTexel;
varying vec2 vUv;
${GLSL_COMMON}
void main(){
  vec2 tp = vUv / uTexel;
  float fibres = fbm(tp / 11.0) * 0.75 + vnoise(tp / 2.2) * 0.25;
  float grain = fbm(tp / 3.0) * 0.6 + fbm(tp / 13.0) * 0.4;
  gl_FragColor = vec4(fibres, grain, 0.0, 1.0);
}`;

// The water itself: a volume shaped like the inside of the glass. Each point looks
// "through" to the slice where the color lives (z = 0); points below or above the slice
// reuse its nearest row, so the color reaches the curved bottom and the water's surface.
const VOLUME_VERT = /* glsl */`
varying vec3 vWorld; varying vec3 vNormalW;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const VOLUME_FRAG = /* glsl */`
uniform sampler2D uPig; uniform sampler2D uWater; uniform sampler2D uGrain; uniform vec2 uTexel; uniform vec4 uRect;
uniform vec3 uTint; uniform float uFade;
varying vec3 vWorld; varying vec3 vNormalW;
${GLSL_COMMON}
void main(){
  vec3 dir = vWorld - cameraPosition;
  vec3 q = cameraPosition + dir * (-cameraPosition.z / dir.z);
  vec2 uv = clamp((q.xy - uRect.xy) / (uRect.zw - uRect.xy), uTexel * 0.5, 1.0 - uTexel * 0.5);

  vec3 col = uTint;
  vec4 p = texture2D(uPig, uv);
  float c = p.a;
  if (c > 0.003) {
    vec3 ink = p.rgb / max(c, 1e-4);                                   // the ink's own color, never watered down
    float avg = 0.0;
    for (int i = 0; i < 8; i++){ float a = float(i) * 0.785398 + 0.3; avg += texture2D(uPig, uv + vec2(cos(a), sin(a)) * uTexel * 3.5).a; }
    float rim = clamp((c - avg / 8.0) * 1.8, 0.0, 1.0);
    float grain = texture2D(uGrain, uv).g;
    float cover = smoothstep(0.012, 0.1, c * (0.9 + 0.2 * grain)) * uFade; // full color, soft edge
    col = mix(uTint, ink, cover);
    col *= 1.0 - 0.04 * rim * uFade;                                       // a faint watercolor edge
  }
  // a little deeper toward the sides, where you look through more water
  float side = 1.0 - abs(dot(normalize(vNormalW), normalize(-dir)));
  col *= 1.0 - 0.04 * side * side;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

function waterGeometry() {
  const { RB, RT, H, T, TB } = GLASS;
  const inner = y => RB + (RT - RB) * (y / H) - T - 0.006; // just inside the glass wall
  const ib = 0.09;
  const V = (x, y) => new THREE.Vector2(x, y);
  const ccx = inner(TB + ib) - ib, ccy = TB + ib;
  const pts = [V(0.0001, TB + 0.004), V(ccx, TB + 0.004)];
  for (let i = 1; i <= 6; i++) { const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2); pts.push(V(ccx + Math.cos(a) * ib, ccy + Math.sin(a) * ib)); }
  for (let i = 1; i <= 10; i++) { const y = ccy + (WATER_Y - ccy) * (i / 10); pts.push(V(inner(y), y)); }
  pts.push(V(0.0001, WATER_Y));
  return new THREE.LatheGeometry(pts, 96);
}

// ---------------------------------------------------------------------------
// The watercolor field: a flat slice through the middle of the glass
// ---------------------------------------------------------------------------

class PaintField {
  constructor(renderer) {
    this.renderer = renderer;
    const x1 = innerRadiusAt(GLASS.H) + 0.02;
    this.rect = new THREE.Vector4(-x1, GLASS.TB, x1, WATER_Y);
    this.W = Math.round(2 * x1 * FIELD_RES);
    this.H = Math.round((WATER_Y - GLASS.TB) * FIELD_RES);
    this.texel = new THREE.Vector2(1 / this.W, 1 / this.H);

    const target = () => new THREE.WebGLRenderTarget(this.W, this.H, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.pig = [target(), target()];
    this.water = [target(), target()];

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    const shared = () => Object.assign({ uTexel: { value: this.texel }, uRect: { value: this.rect } }, cupUniforms());
    const material = (fragmentShader, uniforms) =>
      new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader, uniforms: Object.assign(shared(), uniforms), depthTest: false, depthWrite: false });

    this.paper = new THREE.WebGLRenderTarget(this.W, this.H, {
      type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.pass(material(PAPER_FRAG, {}), this.paper);

    this.waterMat = material(WATER_FRAG, {
      uWater: { value: null }, uPaper: { value: this.paper.texture }, uEvap: { value: WATERCOLOR.CALM_DOWN }, uCost: { value: WATERCOLOR.SPREAD },
    });
    this.pigMat = material(PIGMENT_FRAG, {
      uPig: { value: null }, uWater: { value: null }, uRate: { value: WATERCOLOR.PIGMENT_RATE },
      uReach: { value: WATERCOLOR.PIGMENT_REACH }, uSeed: { value: 0 },
      uTime: { value: 0 }, uSwirl: { value: WATERCOLOR.SWIRL }, uSink: { value: WATERCOLOR.SINK }, uMix: { value: WATERCOLOR.MIX },
    });
    this.stampMat = material(STAMP_FRAG, {
      uPrev: { value: null }, uMap: { value: null }, uColorMap: { value: null }, uPos: { value: new THREE.Vector2() }, uAng: { value: 0 },
      uOff: { value: new THREE.Vector2() }, uSize: { value: new THREE.Vector2(1, 1) }, uMisreg: { value: new THREE.Vector2() },
      uMode: { value: 0 }, uWet: { value: 1 }, uAmount: { value: 1 },
    });

    // Drawn first and without depth, so the drawings always sit on top of the water.
    this.displayMat = new THREE.ShaderMaterial({
      vertexShader: VOLUME_VERT, fragmentShader: VOLUME_FRAG, depthWrite: false,
      uniforms: Object.assign(shared(), {
        uPig: { value: this.pig[0].texture }, uWater: { value: this.water[0].texture },
        uGrain: { value: this.paper.texture },
        uTint: { value: new THREE.Color(WATER_HEX) }, uFade: { value: 1 },
      }),
    });
    this.mesh = new THREE.Mesh(waterGeometry(), this.displayMat);
    this.mesh.renderOrder = -1;

    this.seed = 0;
    this.time = 0;
    this.fade = null;
    this.clear();
  }

  pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  step(dt) {
    this.time += dt * 0.05;
    this.pigMat.uniforms.uTime.value = this.time;
    const steps = Math.max(1, Math.min(6, Math.round(dt * 120)));
    for (let i = 0; i < steps; i++) {
      this.waterMat.uniforms.uWater.value = this.water[0].texture;
      this.pass(this.waterMat, this.water[1]);
      this.water.reverse();

      this.seed = (this.seed + 0.6180339) % 1;
      const u = this.pigMat.uniforms;
      u.uPig.value = this.pig[0].texture;
      u.uWater.value = this.water[0].texture;
      u.uSeed.value = this.seed * 997;
      this.pass(this.pigMat, this.pig[1]);
      this.pig.reverse();
    }
    this.renderer.setRenderTarget(null);

    if (this.fade) {
      this.fade.t += dt;
      const k = Math.min(1, this.fade.t / this.fade.duration);
      this.displayMat.uniforms.uFade.value = 1 - k;
      if (k >= 1) { this.fade = null; this.clear(); this.displayMat.uniforms.uFade.value = 1; }
    }
    this.displayMat.uniforms.uPig.value = this.pig[0].texture;
    this.displayMat.uniforms.uWater.value = this.water[0].texture;
  }

  stamp(s) {
    const u = this.stampMat.uniforms;
    u.uMap.value = s.map;
    u.uPos.value.set(s.pos[0], s.pos[1]);
    u.uAng.value = s.angle;
    u.uOff.value.set(s.offset[0], s.offset[1]);
    u.uSize.value.set(s.size[0], s.size[1]);
    u.uMisreg.value.copy(s.misreg);
    u.uColorMap.value = s.colorMap;
    u.uAmount.value = s.amount;

    u.uMode.value = 0;
    u.uPrev.value = this.pig[0].texture;
    this.pass(this.stampMat, this.pig[1]);
    this.pig.reverse();

    u.uMode.value = 1;
    u.uWet.value = s.wet;
    u.uPrev.value = this.water[0].texture;
    this.pass(this.stampMat, this.water[1]);
    this.water.reverse();
    this.renderer.setRenderTarget(null);
  }

  fadeOut(duration) { this.fade = { t: 0, duration }; }

  clear() {
    const r = this.renderer;
    const keepColor = r.getClearColor(new THREE.Color()), keepAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of [...this.pig, ...this.water]) { r.setRenderTarget(t); r.clear(); }
    r.setRenderTarget(null);
    r.setClearColor(keepColor, keepAlpha);
  }
}

// ---------------------------------------------------------------------------
// One drawing's mesh
// ---------------------------------------------------------------------------

class SketchView {
  constructor(owner, group, mesh, material, texture, size, offset) {
    Object.assign(this, { owner, group, mesh, material, texture, size, offset });
  }
  setPose(p) {
    this.group.position.x = p.x;
    this.group.position.y = p.y;
    this.group.rotation.z = p.a;
    this.group.scale.setScalar(p.s);
  }
  set(name, value) { this.material.uniforms[name].value = value; }
  setColorMap(canvas) {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    if (this.colorTex) this.colorTex.dispose();
    this.colorTex = t;
    this.material.uniforms.uColorMap.value = t;
  }
  dispose() {
    this.owner.scene.remove(this.group);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    if (this.colorTex) this.colorTex.dispose();
  }
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

class GlassScene {
  init() {
    this.w = window.innerWidth;
    this.h = window.innerHeight;

    const r = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    r.setSize(this.w, this.h);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.setClearColor(PAPER_HEX, 1);
    r.transmissionResolutionScale = 1.25; // a sharper look through the glass
    pinToWindow(r.domElement, 0);
    document.body.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PAPER_HEX);
    this.camera = new THREE.PerspectiveCamera(30, this.w / this.h, 0.1, 100);
    this.target = new THREE.Vector3(0, 2.75, 0);
    this.camOffset = new THREE.Vector3(0, 1.95, 12.4); // closer = a bigger glass on screen
    this.fitCamera();

    this.scene.environment = this.makeEnvironment();
    this.glassMesh = this.makeGlass();
    this.scene.add(this.glassMesh);
    this.scene.add(this.makeShadow());

    this.field = new PaintField(r);
    this.scene.add(this.field.mesh);
    this.layer = 0;
  }

  fitCamera() {
    const aspect = this.w / this.h;
    this.camera.aspect = aspect;
    const dist = this.camOffset.length();
    const halfWidth = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * aspect * dist;
    const pullBack = Math.max(1, 2.4 / halfWidth); // keep the glass in frame on narrow screens
    this.camera.position.copy(this.target).addScaledVector(this.camOffset, pullBack);
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  resize(w, h) {
    this.w = w; this.h = h;
    this.renderer.setSize(w, h);
    this.fitCamera();
  }

  // A small photo studio for the glass to reflect. The camera looks slightly down, so the
  // walls reflect directions below the horizon: the light strips reach low to catch that.
  makeEnvironment() {
    const env = new THREE.Scene();
    const gray = v => new THREE.Color(v, v, v);
    env.add(new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30), new THREE.MeshBasicMaterial({ color: gray(0.5), side: THREE.BackSide })));
    const panel = (w, h, power, x, y, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: gray(power), side: THREE.DoubleSide }));
      m.position.set(x, y, z);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    panel(2.2, 16, 9, -7, -1, 6);   // main strip, front left
    panel(1.2, 16, 5, 7.5, -1, 5);  // thin strip, front right
    panel(10, 4, 2.5, 0, 12, 2);    // soft top light
    panel(5, 18, 0.04, -7, 0, -8);  // dark flags behind, for the edges
    panel(5, 18, 0.04, 7, 0, -8);
    panel(30, 30, 0.22, 0, -9, 0);  // floor
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const texture = pmrem.fromScene(env, 0.02).texture;
    pmrem.dispose();
    return texture;
  }

  glassGeometry() {
    const { RB, RT, H, T, TB } = GLASS;
    const outer = y => RB + (RT - RB) * (y / H);
    const inner = y => outer(y) - T;
    const V = (x, y) => new THREE.Vector2(x, y);
    const pts = [V(0.0001, 0)];
    const baseR = 0.07;
    pts.push(V(RB - baseR, 0));
    for (let i = 1; i <= 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * (Math.PI / 2);
      pts.push(V(RB - baseR + Math.cos(a) * baseR, baseR + Math.sin(a) * baseR));
    }
    const rimY = H - T / 2;
    for (let i = 1; i <= 10; i++) { const y = baseR + (rimY - baseR) * (i / 10); pts.push(V(outer(y), y)); }
    const rc = T / 2, cx = outer(rimY) - rc;
    for (let i = 1; i < 10; i++) { const a = (i / 10) * Math.PI; pts.push(V(cx + Math.cos(a) * rc, rimY + Math.sin(a) * rc)); }
    const ib = 0.09;
    for (let i = 0; i <= 10; i++) { const y = rimY - (rimY - (TB + ib)) * (i / 10); pts.push(V(inner(y), y)); }
    const ccx = inner(TB + ib) - ib, ccy = TB + ib;
    for (let i = 1; i <= 6; i++) { const a = (i / 6) * (Math.PI / 2); pts.push(V(ccx + Math.cos(a) * ib, ccy - Math.sin(a) * ib)); }
    pts.push(V(0.0001, TB));
    return new THREE.LatheGeometry(pts, 128);
  }

  makeGlass() {
    // Front faces only + zero roughness: three.js blurs whatever it refracts, and a second
    // refraction through the back wall was enough to wash out the thin ink lines inside.
    const material = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, metalness: 0, roughness: 0,
      transmission: 1, thickness: 0.18, ior: 1.45,
      attenuationColor: new THREE.Color('#f4fbfa'), attenuationDistance: 3,
      specularIntensity: 1, envMapIntensity: 1.0, side: THREE.FrontSide,
    });
    return new THREE.Mesh(this.glassGeometry(), material);
  }

  makeShadow() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grd.addColorStop(0, 'rgba(0,0,0,0.30)');
    grd.addColorStop(0.45, 'rgba(0,0,0,0.12)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(GLASS.RB * 3.2, GLASS.RB * 2.4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(0.12, 0.002, 0.1);
    return m;
  }

  // --- screen <-> world on the z = 0 slice where everything lives ---
  screenToWorld(sx, sy) {
    const v = new THREE.Vector3((sx / this.w) * 2 - 1, -(sy / this.h) * 2 + 1, 0.5).unproject(this.camera);
    const dir = v.sub(this.camera.position).normalize();
    const t = -this.camera.position.z / dir.z;
    return this.camera.position.clone().addScaledVector(dir, t);
  }
  worldPerPixel(sx, sy) {
    return this.screenToWorld(sx + 1, sy).distanceTo(this.screenToWorld(sx, sy));
  }
  worldToScreen(x, y, z = 0) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x + 1) / 2 * this.w, y: (1 - v.y) / 2 * this.h };
  }

  // The glass's outline in screen px, for the ink line drawn over it in p5.
  outline() {
    const { RB, RT, H } = GLASS;
    const outer = y => RB + (RT - RB) * (y / H);
    const ring = (r, y, n = 96) => {
      const pts = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push(this.worldToScreen(Math.cos(a) * r, y, Math.sin(a) * r)); }
      return pts;
    };
    const left = [], right = [];
    for (let i = 0; i <= 24; i++) {
      const y = 0.05 + (H - 0.05) * (i / 24);
      const pts = ring(outer(y), y, 72);
      let lo = pts[0], hi = pts[0];
      for (const p of pts) { if (p.x < lo.x) lo = p; if (p.x > hi.x) hi = p; }
      left.push(lo); right.push(hi);
    }
    const base = [];
    for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI; base.push(this.worldToScreen(Math.cos(a) * RB, 0.05, Math.sin(a) * RB)); }
    return { left, right, rim: ring(RT, H), base, water: ring(innerRadiusAt(WATER_Y), WATER_Y) };
  }

  addSketch(sk, com) {
    const texture = new THREE.CanvasTexture(sk.tex);
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    const size = { w: sk.W / sk.d, h: sk.H / sk.d };
    const ang = Math.random() * Math.PI * 2;
    const material = new THREE.ShaderMaterial({
      vertexShader: SKETCH_VERT, fragmentShader: SKETCH_FRAG,
      side: THREE.DoubleSide, alphaToCoverage: true,
      uniforms: Object.assign({
        uMap: { value: texture },
        uColorMap: { value: null },
        uInk: { value: new THREE.Color(INK_HEX) },
        uTexSize: { value: new THREE.Vector2(size.w, size.h) },
        uMisreg: { value: new THREE.Vector2(Math.cos(ang) * 2.2 / size.w, Math.sin(ang) * 2.2 / size.h) },
        uOrigin: { value: new THREE.Vector2(sk.origin[0], sk.origin[1]) },
        uReveal: { value: 0 }, uDissolve: { value: 0 }, uFade: { value: 1 },
        uSeed: { value: Math.random() * 10 }, uBoil: { value: 0 }, uBoilSeed: { value: 0 },
      }, cupUniforms()),
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size.w, size.h), material);
    const offset = { x: size.w / 2 - com.x, y: -(size.h / 2 - com.y) };
    mesh.position.set(offset.x, offset.y, 0);
    const group = new THREE.Group();
    group.add(mesh);
    group.position.z = 0.014 + 0.003 * (this.layer++ % 120);
    this.scene.add(group);
    const view = new SketchView(this, group, mesh, material, texture, size, offset);
    const blank = document.createElement('canvas');
    blank.width = blank.height = 1;
    const bctx = blank.getContext('2d');
    bctx.fillStyle = PAPER_HEX; // never black, even if something shows early
    bctx.fillRect(0, 0, 1, 1);
    view.setColorMap(blank);
    return view;
  }

  // Hand a landed drawing's colors to the water.
  stamp(view, pose, amount = 1, wet = 1) {
    this.field.stamp({
      map: view.texture, colorMap: view.colorTex,
      pos: [pose.x, pose.y], angle: pose.a,
      offset: [view.offset.x * pose.s, view.offset.y * pose.s],
      size: [view.size.w * pose.s, view.size.h * pose.s],
      misreg: view.material.uniforms.uMisreg.value,
      amount, wet,
    });
  }

  render(dt) {
    this.field.step(dt);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }
}
