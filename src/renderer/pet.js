// Pet behaviour: mood from session state, idle wandering, drag/throw physics, bubbles, session panel.
const api = window.pet;
const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const bubbleEl = document.getElementById('bubble');
const bubbleProject = document.getElementById('bubble-project');
const bubbleText = document.getElementById('bubble-text');
const panelEl = document.getElementById('panel');

// The sprite is drawn flat into an offscreen canvas, then composited with squash/stretch/tilt.
const S = Sprite.SCALE;
const MARGIN = 6 * S; // room on each side for squash and tilt
const FOOT_PAD = 16; // transparent room below the feet so tilted poses aren't clipped (must match main.js)
const off = document.createElement('canvas');
off.width = Sprite.width;
off.height = Sprite.height;
const octx = off.getContext('2d');
// The design being drawn (tray → Pet design): the black cat or the classic pet. Both share the
// same grid and size, so only drawing, colors and glyphs change.
const DESIGNS = { cat: CatSprite, classic: Sprite };
let sprite = CatSprite;
canvas.width = Sprite.width + 2 * MARGIN;
canvas.height = Sprite.height + FOOT_PAD;
ctx.imageSmoothingEnabled = false;
document.documentElement.style.setProperty('--pet-h', `${canvas.height}px`);

const FPS = 30;
const SLEEP_AFTER_MS = 4 * 60 * 1000;
const TTL = { activity: 4500, hello: 3000, bye: 2500, done: 15000, waiting: Infinity };
const PRIO = { activity: 1, hello: 1, bye: 1, done: 2, waiting: 3 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let settings = { bubbles: true, wander: true };
let sessions = [];
let t = 0;
let lastEventAt = Date.now();
let happyUntil = 0;
let waveUntil = 0;
let nextBlink = 60;

// action: idle | walk | drag | fall | land
let action = 'fall';
let walkDir = 1;
let walkTicks = 0;
let vx = 0;
let vy = 0;
let landTicks = 0;
let laptop = 0; // laptop animation frame; > 0 means the pet is sitting behind its laptop, typing
let laptopHoldUntil = 0;
let facing = 1; // laptop side: 1 = laptop on the left, -1 = mirrored, laptop on the right

// drag velocity, measured from cursor movement (px per tick)
let dragAccX = 0;
let dragAccY = 0;
let dragVx = 0;
let dragVy = 0;
let lastSX = 0;
let lastSY = 0;

// ---------- springs (squash/stretch and tilt) ----------
const spring = (v, k, damping) => ({ v, vel: 0, target: v, k, damping });
const stepSpring = (s) => {
  s.vel = (s.vel + (s.target - s.v) * s.k) * s.damping;
  s.v += s.vel;
};
const stretch = spring(1, 0.3, 0.7); // vertical scale; horizontal is derived (volume-ish preserving)
const tilt = spring(0, 0.16, 0.82); // radians, positive = clockwise

// ---------- dust particles ----------
let dust = [];
function puff(n) {
  const feet = Sprite.height - 2;
  for (let i = 0; i < n; i++) {
    const dir = i % 2 ? 1 : -1;
    dust.push({
      x: canvas.width / 2 + dir * (Sprite.width * 0.3 + Math.random() * 4),
      y: feet - Math.random() * 3,
      vx: dir * (0.8 + Math.random() * 1.8),
      vy: -(0.2 + Math.random() * 0.8),
      life: 12 + Math.floor(Math.random() * 6),
      size: Math.random() < 0.5 ? S : Math.ceil(S * 0.75),
    });
  }
}

// ---------- bubbles state ----------
let bubble = null; // { kind, text, project, sessionId, until, prio }
let panelOpen = false;
let panelTimer = null;

// Hooks for the optional local AI assistant (assistant.js fills them in; they do nothing without it).
const extras = {
  mood: () => null, // 'alert' or 'thinking' while it waits on you or on the model
  bubbleShown() {},
  bubbleHidden(_was) {},
  bubbleExpired(_b) {},
  bubbleClick: (_b) => true, // false keeps the bubble open
  panelClosed() {},
};

// ---------- mood ----------
function mood() {
  const st = new Set(sessions.map((s) => s.status));
  const extra = extras.mood();
  if (st.has('waiting') || extra === 'alert') return 'alert';
  if (st.has('working')) return 'working';
  if (st.has('thinking') || extra === 'thinking') return 'thinking';
  if (Date.now() < happyUntil) return 'happy';
  if (Date.now() - lastEventAt > SLEEP_AFTER_MS) return 'sleep';
  return 'idle';
}

// ---------- window movement: coalesce sub-pixel moves, one IPC call in flight ----------
const pend = { dx: 0, dy: 0 };
let inflight = false;
function queueMove(dx, dy) {
  pend.dx += dx;
  pend.dy += dy;
  flush();
}
async function flush() {
  if (inflight) return;
  const dx = Math.trunc(pend.dx);
  const dy = Math.trunc(pend.dy);
  if (!dx && !dy) return;
  pend.dx -= dx;
  pend.dy -= dy;
  inflight = true;
  try {
    onMoved(await api.moveBy(dx, dy));
  } finally {
    inflight = false;
    if (Math.abs(pend.dx) >= 1 || Math.abs(pend.dy) >= 1) flush();
  }
}
function onMoved(r) {
  if (!r) return;
  if (action === 'walk' && r.hitX) walkDir *= -1;
  if (action === 'fall') {
    if (r.hitX) {
      vx = -vx * 0.55; // bounce off the screen edge
      tilt.vel += vx * 0.012;
      stretch.v = 0.9;
    }
    if (r.hitTop && vy < 0) vy = 0;
    if (r.onGround && vy >= 0) land();
  }
}

function land() {
  const impact = vy;
  vx = 0;
  vy = 0;
  pend.dx = pend.dy = 0;
  if (impact > 5) {
    stretch.v = 1 - clamp(impact * 0.02, 0.12, 0.4); // squash on impact; the spring bounces back
    stretch.vel = 0;
    tilt.vel += (Math.random() - 0.5) * 0.1;
    puff(clamp(Math.round(impact / 3), 3, 10));
    action = 'land';
    landTicks = 18;
  } else {
    action = 'idle';
  }
}

function updateMovement(m) {
  if (action === 'drag') {
    // smooth the per-tick cursor delta into a velocity
    dragVx = dragVx * 0.55 + dragAccX * 0.45;
    dragVy = dragVy * 0.55 + dragAccY * 0.45;
    dragAccX = dragAccY = 0;
    return;
  }
  if (action === 'fall') {
    vy = Math.min(vy + 1.5, 26);
    vx *= 0.97;
    queueMove(vx, vy);
    return;
  }
  if (action === 'land') {
    if (--landTicks <= 0) action = 'idle';
    return;
  }
  if (action === 'idle' && m === 'idle' && laptop === 0 && settings.wander && !panelOpen && Math.random() < 0.004) {
    action = 'walk';
    walkDir = Math.random() < 0.5 ? -1 : 1;
    walkTicks = 45 + Math.floor(Math.random() * 120);
  }
  if (action === 'walk') {
    if (m !== 'idle' || --walkTicks <= 0) {
      action = 'idle';
      return;
    }
    queueMove(walkDir * 1.5, 0);
  }
}

function updateFx(m) {
  // squash/stretch + tilt targets per action
  if (action === 'drag') {
    stretch.target = 1.1 + clamp(Math.abs(dragVy) * 0.004, 0, 0.08); // dangling
    tilt.target = clamp(dragVx * 0.035, -0.5, 0.5); // swings behind the motion
  } else if (action === 'fall') {
    stretch.target = 1 + clamp(Math.abs(vy) * 0.008, 0, 0.2);
    tilt.target = clamp(vx * 0.03, -0.45, 0.45);
  } else {
    stretch.target = 1;
    tilt.target = 0;
  }
  stepSpring(stretch);
  stepSpring(tilt);

  // laptop opens while working, lingers briefly, folds away when interrupted
  if (m === 'working' && action === 'idle') laptopHoldUntil = t + 45;
  const calm = action === 'idle' && (m === 'working' || m === 'thinking' || m === 'idle');
  const want = calm && t < laptopHoldUntil ? sprite.LAPTOP_FRAMES : 0;
  const before = laptop;
  if (action === 'drag' || action === 'fall') laptop = 0;
  else if (t % 2 === 0 && laptop !== want) laptop += Math.sign(want - laptop);
  if (before === 0 && laptop > 0) {
    // pull the laptop out on the side away from a nearby screen edge (1 = left, -1 = mirrored to the right)
    facing = edges.left > 0 ? -1 : edges.right > 0 ? 1 : Math.random() < 0.5 ? -1 : 1;
    stretch.v = 0.88; // little hop as it turns
  } else if (before > 0 && laptop === 0 && action === 'idle') {
    stretch.v = 0.9; // and as it turns back to face you
  }

  // dust
  for (const p of dust) {
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.9;
    p.vy += 0.05;
    p.life--;
  }
  dust = dust.filter((p) => p.life > 0);
}

// ---------- pose for this frame ----------
function pose(m) {
  // with the laptop out, the classic pet has a coffee mug beside it (mug: 1 = on the ground, 2 = in hand)
  const o = { oy: 0, eyes: 'open', look: [0, 0], arms: ['down', 'down'], legs: 'stand', squash: 0, glyph: null, laptop, turned: laptop > 0, mug: 1, steam: t, t };
  const step = (n) => Math.floor(t / n);

  if (action === 'drag') {
    o.eyes = Math.abs(dragVx) > 14 ? 'closed' : 'wide'; // eyes squeezed shut when swung hard
    o.arms = ['up', 'up'];
    o.legs = step(2) % 2 ? 'walkA' : 'walkB'; // kicking
    o.held = true; // designs may show this their own way (the cat: ^^ eyes, round bottom)
    o.airborne = true;
    return o;
  }
  if (action === 'fall') {
    o.airborne = true;
    o.eyes = 'wide';
    o.arms = ['up', 'up'];
    o.legs = step(3) % 2 ? 'walkA' : 'walkB';
    return o;
  }
  if (action === 'land') {
    o.eyes = landTicks > 9 ? 'closed' : 'happy';
    o.arms = landTicks > 9 ? ['down', 'down'] : ['up', 'up'];
    return o;
  }
  if (action === 'walk') {
    o.legs = step(4) % 2 ? 'walkA' : 'walkB';
    o.look = [walkDir, 0];
    o.oy = step(4) % 2 ? -1 : 0;
    return o;
  }

  switch (m) {
    case 'alert': {
      const p = t % 22;
      const air = p < 11;
      o.oy = air ? -Math.round(Math.sin((p / 11) * Math.PI) * S * 2.7) : 0;
      o.eyes = 'wide';
      o.arms = air ? ['up', 'up'] : ['down', 'down'];
      o.glyph = { ch: '!', color: sprite.COLORS.alert, bold: true, size: Math.round(S * 4.5) };
      break;
    }
    case 'working': {
      // typing in bursts, with little pauses to read the screen
      const burst = step(18) % 5 !== 4;
      o.hands = burst ? (step(2) % 2 ? [0, 1] : [1, 0]) : [1, 1];
      if (!burst) o.squash = 1; // leans back a little while reading
      if (!burst && step(90) % 2) o.mug = 2; // every other pause: a sip of coffee
      o.glyph = { ch: sprite.SPIN[step(3) % sprite.SPIN.length] };
      break;
    }
    case 'thinking':
      o.look = [(step(36) % 3) - 1, -1];
      o.squash = step(24) % 2;
      o.glyph = { ch: sprite.SPIN[step(4) % sprite.SPIN.length] };
      break;
    case 'happy': {
      const p = t % 16;
      o.oy = -Math.round(Math.sin((p / 16) * Math.PI) * S * 1.4);
      o.eyes = 'happy';
      o.arms = ['up', 'up'];
      o.glyph = { ch: '♪', dy: -Math.round(Math.sin(((t % 30) / 30) * Math.PI) * S) };
      break;
    }
    case 'sleep': {
      o.eyes = 'closed';
      o.squash = step(45) % 2;
      const p = t % 60;
      o.glyph = { ch: p < 30 ? 'z' : 'Z', color: sprite.COLORS.zzz, size: Math.round(S * 2.6) + Math.floor(p / 15), dy: -Math.floor(p / 4), dx: Math.floor(p / 8) };
      break;
    }
    default:
      o.squash = step(40) % 2;
  }
  if ((m === 'idle' || m === 'working' || m === 'thinking') && t >= nextBlink) {
    o.eyes = 'closed';
    if (t >= nextBlink + 3) nextBlink = t + 70 + Math.floor(Math.random() * 120);
  }
  if (Date.now() < waveUntil) o.arms = ['down', step(5) % 2 ? 'up' : 'down'];
  return o;
}

// ---------- render ----------
function render(m) {
  const o = pose(m);
  sprite.draw(octx, o);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const sy = stretch.v;
  const sx = 1 + (1 - sy) * 0.9;
  const feetY = Sprite.height;
  const cx = canvas.width / 2;
  const cy = Sprite.HEAD + 7 * S; // tilt pivots around the body's middle
  ctx.save();
  ctx.translate(cx, feetY); // scale anchored at the feet
  ctx.scale(sx, sy);
  ctx.translate(0, cy - feetY);
  ctx.rotate(tilt.v);
  ctx.translate(-cx, -cy);
  if (o.turned && facing < 0) {
    ctx.translate(cx, 0); // mirror the laptop view to put the laptop on the right
    ctx.scale(-1, 1);
    ctx.translate(-cx, 0);
  }
  ctx.drawImage(off, MARGIN, 0);
  ctx.restore();

  for (const p of dust) {
    ctx.globalAlpha = Math.min(1, p.life / 8) * 0.8;
    ctx.fillStyle = sprite.COLORS.dust || '#B8AEA3';
    ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
  }
  ctx.globalAlpha = 1;
}

function tick() {
  t++;
  const m = mood();
  updateMovement(m);
  updateFx(m);
  render(m);
  if (bubble && Date.now() > bubble.until) {
    extras.bubbleExpired(bubble);
    hideBubble();
  }
}
setInterval(tick, 1000 / FPS);

// ---------- bubbles ----------
// When the window hangs off a screen edge, shrink/shift bubbles to stay in the visible part.
let edges = { left: 0, right: 0 };
const UI_MAX = 272;
function fitUi(el) {
  const W = window.innerWidth;
  const avail = W - edges.left - edges.right - 12;
  el.style.maxWidth = `${Math.max(120, Math.min(UI_MAX, avail))}px`;
  const w = el.offsetWidth;
  const centered = (W - w) / 2;
  const left = clamp(centered, edges.left + 6, W - edges.right - 6 - w);
  el.style.setProperty('--shift', `${Math.round(left - centered)}px`);
}

function showBubble(kind, text, project, sessionId) {
  if (!settings.bubbles && kind !== 'waiting') return;
  const prio = PRIO[kind] || 1;
  if (bubble && bubble.prio > prio && Date.now() < bubble.until) return;
  bubble = { kind, text, project, sessionId, prio, until: Date.now() + (TTL[kind] || 4000) };
  bubbleProject.textContent = project || '';
  bubbleProject.style.display = project ? '' : 'none';
  bubbleText.textContent = kind === 'done' ? `✓ ${text}` : text;
  bubbleEl.className = `ui ${kind}`;
  fitUi(bubbleEl);
  if (panelOpen) closePanel();
  extras.bubbleShown();
}
function hideBubble() {
  const was = bubble;
  bubble = null;
  bubbleEl.className = 'ui hidden';
  extras.bubbleHidden(was);
}
bubbleEl.addEventListener('click', () => {
  if (extras.bubbleClick(bubble) === false) return;
  hideBubble();
});

// ---------- session panel ----------
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
function renderPanel() {
  panelEl.replaceChildren();
  const h = document.createElement('h1');
  h.textContent = sessions.length ? `Claude Code · ${sessions.length} session${sessions.length > 1 ? 's' : ''}` : 'Claude Code';
  panelEl.append(h);
  if (!sessions.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No active sessions. Start one and I’ll keep you posted!';
    panelEl.append(e);
    return;
  }
  for (const s of sessions.slice(0, 6)) {
    const row = document.createElement('div');
    row.className = 'row';
    const dot = document.createElement('span');
    dot.className = `dot ${s.status}`;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.project;
    const when = document.createElement('span');
    when.className = 'ago';
    when.textContent = `${s.status} · ${ago(s.updated)}`;
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = s.activity || '';
    row.append(dot, name, when, what);
    panelEl.append(row);
  }
}
function openPanel() {
  hideBubble();
  renderPanel();
  panelOpen = true;
  panelEl.className = 'ui';
  fitUi(panelEl);
  clearTimeout(panelTimer);
  panelTimer = setTimeout(closePanel, 8000);
}
function closePanel() {
  panelOpen = false;
  panelEl.className = 'ui hidden';
  extras.panelClosed();
}

// ---------- mouse: click-through, drag, click, menu ----------
let ignoring = true;
function setIgnore(v) {
  if (v !== ignoring) {
    ignoring = v;
    api.setIgnore(v);
  }
}
function overPet(e) {
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(e.clientX - r.left);
  const y = Math.floor(e.clientY - r.top);
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
  const pad = 4;
  const x0 = Math.max(0, x - pad);
  const y0 = Math.max(0, y - pad);
  const w = Math.min(canvas.width - x0, pad * 2 + 1);
  const hh = Math.min(canvas.height - y0, pad * 2 + 1);
  const d = ctx.getImageData(x0, y0, w, hh).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  return false;
}
function overUi(e) {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  return !!(el && el.closest('.ui:not(.hidden)'));
}

let press = null;
document.addEventListener('mousemove', (e) => {
  if (action === 'drag') {
    if (e.buttons === 0) return endDrag();
    dragAccX += e.screenX - lastSX;
    dragAccY += e.screenY - lastSY;
    lastSX = e.screenX;
    lastSY = e.screenY;
    return;
  }
  if (press && (Math.abs(e.screenX - press.x) > 3 || Math.abs(e.screenY - press.y) > 3)) return startDrag(e);
  setIgnore(!(overPet(e) || overUi(e)));
});
document.addEventListener('mouseleave', () => {
  if (action !== 'drag' && !press) setIgnore(true);
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !overPet(e)) return;
  press = { x: e.screenX, y: e.screenY };
});
window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (action === 'drag') return endDrag();
  if (press) {
    press = null;
    stretch.v = 0.86; // boop
    panelOpen ? closePanel() : openPanel();
  }
});

function startDrag(e) {
  action = 'drag';
  press = null;
  pend.dx = pend.dy = 0;
  vx = vy = 0;
  dragAccX = dragAccY = dragVx = dragVy = 0;
  lastSX = e.screenX;
  lastSY = e.screenY;
  stretch.v = 0.8; // squish when picked up, then boing into a stretch
  stretch.vel = 0;
  canvas.classList.add('dragging');
  api.dragStart();
}
function endDrag() {
  press = null;
  canvas.classList.remove('dragging');
  api.dragEnd();
  // keep the throw momentum
  vx = clamp(dragVx, -34, 34);
  vy = clamp(dragVy, -24, 12);
  action = 'fall';
}
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (overPet(e)) api.showMenu();
});

// ---------- events from main ----------
api.setMetrics({ halfWidth: 8 * S, height: canvas.height }); // body + arms span grid x 1..16 around the centre
api.onEdges((e) => {
  edges = e;
  fitUi(bubbleEl);
  fitUi(panelEl);
});
api.onSettings((s) => {
  settings = s;
  sprite = DESIGNS[s.design] || CatSprite;
});
api.onFall(() => {
  if (action !== 'drag') (action = 'fall'), (vx = 0), (vy = 0);
});
api.onSessions((list) => {
  sessions = list;
  if (bubble && bubble.kind === 'waiting') {
    const s = sessions.find((x) => x.id === bubble.sessionId);
    if (!s || s.status !== 'waiting') hideBubble();
  }
  if (panelOpen) renderPanel();
});
api.onEvent((ev) => {
  lastEventAt = Date.now();
  switch (ev.type) {
    case 'hello':
      waveUntil = Date.now() + 2500;
      showBubble('hello', ev.text, ev.project, ev.sessionId);
      break;
    case 'bye':
      showBubble('bye', ev.text, ev.project, ev.sessionId);
      break;
    case 'activity':
      showBubble('activity', ev.text, ev.project, ev.sessionId);
      break;
    case 'waiting':
      showBubble('waiting', ev.text, ev.project, ev.sessionId);
      break;
    case 'resolved':
      if (bubble && bubble.kind === 'waiting' && bubble.sessionId === ev.sessionId) hideBubble();
      break;
    case 'done':
      happyUntil = Date.now() + 2200;
      showBubble('done', ev.text, ev.project, ev.sessionId);
      break;
  }
});
