// The black cat, drawn from rectangles on the same 18x13 grid as the classic pet (sprite.js), with
// the same draw(ctx, opts) contract, so every pose and animation in pet.js works for both.
// Charcoal and greys, with yellow as its one accent: the eyes, the spinner, the laptop's logo.
//
// The cat (x = grid column): low wide ears over a head rounded on top (x 4-13), yellow eyes with
// round pupils at x 6-7 / 10-11 and a small grey nose between them, paws at x 1-2 / 15-16, and a
// wide base (x 2-15) sitting right on the ground like a loaf, with the tail curling up on the right.
// It has no feet: walking is the base sliding a little toward where it's going, like a slime.
// Picked up or falling it rounds out underneath, and while held its eyes are ^^.
const CatSprite = (() => {
  const SCALE = 4;
  const GW = 18;
  const GH = 13;
  const HEAD = 9 * SCALE;
  const COLORS = {
    body: '#3B3B3F', // charcoal rather than pure black, so it still shows on dark desktops
    shade: '#2A2A2E',
    gloss: '#717176',
    inner: '#55555A', // inside of the ears
    nose: '#97979B',
    eye: '#F2D04B',
    pupil: '#141414',
    lidLine: '#88888D', // closed eyes
    lid: '#151515', // the laptop: black, with a grey edge and a yellow logo
    lidEdge: '#717176',
    lidSide: '#202020',
    deck: '#2D2D2D',
    deckBack: '#252525',
    base: '#191919',
    logo: '#F2D04B',
    glow: '#4C4A41', // screen light on the face
    glowSoft: '#45443D',
    glyph: '#F2D04B',
    alert: '#E5484D',
    zzz: '#8A8A8A',
    dust: '#8E8E8E',
  };
  const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const LAPTOP_FRAMES = 5;

  const width = GW * SCALE;
  const height = HEAD + GH * SCALE;

  // It has no feet: the body sits right on the ground, 2 rows lower than the classic pet's.
  const DROP = 2;

  // opts: the same as sprite.js, plus t (frame counter) for the tail and ear twitches.
  // There's no coffee mug: `mug` is ignored.
  function draw(ctx, o) {
    const oy = Math.round(o.oy || 0);
    const top = 3 + (o.squash || 0);
    // ground: the grid's own rows (the laptop); cat: the cat's rows, lowered onto the ground
    const ground = (x, y, w, h, color, offY = oy) => {
      ctx.fillStyle = color;
      ctx.fillRect(x * SCALE, HEAD + y * SCALE + offY, w * SCALE, h * SCALE);
    };
    const cat = (x, y, w, h, color, offY = oy) => ground(x, y + DROP, w, h, color, offY);
    ctx.clearRect(0, 0, width, height);
    if (o.turned) drawLaptop(o, cat, ground, top);
    else drawFront(o, cat, top);

    if (o.glyph) {
      const gy = top + DROP - (o.turned ? lift(o) : 0);
      ctx.save();
      ctx.fillStyle = o.glyph.color || COLORS.glyph;
      ctx.font = `${o.glyph.bold ? '800' : '700'} ${o.glyph.size || Math.round(SCALE * 3.6)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(o.glyph.ch, 14.5 * SCALE + (o.glyph.dx || 0), HEAD + gy * SCALE + oy - SCALE + (o.glyph.dy || 0));
      ctx.restore();
    }
  }

  // ^ shape, for happy eyes
  function arc(px, cx, ey, c) {
    px(cx - 1, ey + 1, 1, 1, c);
    px(cx, ey, 1, 1, c);
    px(cx + 1, ey + 1, 1, 1, c);
  }

  function drawFront(o, px, top) {
    const C = COLORS;
    const t = o.t || 0;
    // In the air (held or falling) nothing presses its base flat, so it rounds out underneath.
    const air = !!o.airborne;
    // Walking like a slime: every other step the base slides half a pixel ahead, toward where it's
    // going, and the body catches up. It never leans backward.
    const dir = o.legs && o.legs !== 'stand' && !air ? Math.sign((o.look || [0])[0]) : 0;
    const lean = o.legs === 'walkA' ? 0.5 * dir : 0;

    // tail, curling up on the right and slowly swaying
    const sway = Math.floor(t / 12) % 4;
    const tip = [17, 17, 16.5, 16.5][sway] - (air ? 1 : 0);
    const mid = [16, 16.5, 16, 15.5][sway] - (air ? 1 : 0);
    px(air ? 14 : 15 + lean, 10, 1, 1, C.shade);
    px(air ? 15 : 16 + lean, 9, 1, 1, C.body);
    px(mid, 8, 1, 1, C.body);
    px(tip, 7, 1, 1, C.body);
    px(tip, 7, 1, 0.5, C.gloss);

    // low, wide ears; the left one flicks every few seconds
    const flick = t % 170 < 7 ? -0.5 : 0;
    px(5 + flick, top - 1.5, 1.5, 0.5, C.gloss);
    px(5, top - 1, 3, 1, C.body);
    px(5.5, top - 0.5, 1.5, 0.5, C.inner);
    px(11.5, top - 1.5, 1.5, 0.5, C.body);
    px(10, top - 1, 3, 1, C.body);
    px(11, top - 0.5, 1.5, 0.5, C.inner);

    // head and body: rounded on top, spreading at the base (or round underneath, in the air)
    px(5, top, 8, 1, C.body);
    px(4, top + 1, 10, 1, C.body);
    if (air) {
      px(3, top + 2, 12, 8 - top, C.body);
      px(4, 10, 10, 1, C.shade);
    } else {
      px(3, top + 2, 12, 7 - top, C.body);
      px(2 + lean, 9, 14, 1, C.body);
      px(2 + lean, 10, 14, 1, C.shade);
    }
    px(5, top + 1, 2, 1, C.gloss);
    px(4, top + 2, 1, 1, C.gloss);

    // paws
    if (o.arms !== 'none') {
      const [la, ra] = o.arms || ['down', 'down'];
      const y = (a) => (a === 'up' ? top : 7);
      px(1, y(la), 2, 1, C.body);
      px(2, y(la) + 1, 1, 1, C.body);
      px(15, y(ra), 2, 1, C.body);
      px(15, y(ra) + 1, 1, 1, C.body);
    }
    if (o.underEyes) o.underEyes(); // the laptop screen's glow, under the face

    px(8.5, top + 4, 1, 0.5, C.nose);

    const [lx, ly] = o.look || [0, 0];
    const ey = top + 2;
    const K = C.eye;
    switch (o.held ? 'happy' : o.eyes) { // picked up: ^^
      case 'closed':
        px(6, ey + 1, 2, 0.5, C.lidLine);
        px(10, ey + 1, 2, 0.5, C.lidLine);
        break;
      case 'happy':
        arc(px, 6.5, ey, K);
        arc(px, 10.5, ey, K);
        break;
      case 'wide':
        px(6, ey, 2, 2, K);
        px(10, ey, 2, 2, K);
        px(6.5, ey + 0.5, 1, 1, C.pupil);
        px(10.5, ey + 0.5, 1, 1, C.pupil);
        break;
      default: {
        // round pupils drift toward where it's looking
        px(6, ey, 2, 2, K);
        px(10, ey, 2, 2, K);
        const dx = lx > 0 ? 1 : lx < 0 ? 0 : 0.5;
        const dy = ly < 0 ? 0 : 1;
        px(6 + dx, ey + dy, 1, 1, C.pupil);
        px(10 + dx, ey + dy, 1, 1, C.pupil);
      }
    }
  }

  // Laptop view, as in sprite.js: the cat sits back a little behind a black laptop on its
  // front-left, one paw on the keyboard deck and the other bobbing behind the lid.
  function lift(o) {
    const lp = o.laptop || 0;
    return lp >= 4 ? 2 : lp >= 2 ? 1 : 0;
  }

  // cat: draws in the cat's rows; px: in the grid's own rows (the laptop sits on the ground)
  function drawLaptop(o, cat, px, top) {
    const C = COLORS;
    const lidH = Math.min(5, o.laptop || 0);
    const typing = lidH === 5;
    const up = lift(o);
    const [hn, hf] = o.hands || [1, 1];

    const back = (x, y, w, h, c) => cat(x, y - up, w, h, c);
    const [lx] = o.look || [0, 0];
    const glow = () => {
      // just above the lid, wherever the face is
      px(3, 9 - up, 6, 1, C.glow);
      px(4, 8 - up, 4, 1, C.glowSoft);
    };
    drawFront({ ...o, look: [lx, typing ? 1 : 0], arms: typing ? 'none' : o.arms, underEyes: typing ? glow : null }, back, top);

    if (typing) {
      px(1, 7 + hf - up, 2, 2, C.body); // far paw bobbing just behind the lid's edge
      back(15, 6, 2, 2, C.body);
    }

    const lidTop = 13 - lidH;
    if (lidH >= 3) {
      px(9, 10, 3, 1, C.deckBack, 0);
      px(9, 11, 4, 1, C.deck, 0);
      px(9, 12, 3, 1, C.base, 0);
    }
    px(0, lidTop, 9, lidH, C.lid, 0);
    px(0, lidTop, 9, 1, C.lidEdge, 0);
    if (lidH > 1) px(8, lidTop + 1, 1, lidH - 1, C.lidSide, 0);
    if (lidH === 5) {
      // three yellow claw scratches on the lid, in half-size pixels
      for (const sx of [3, 3.75, 4.5]) for (const k of [0, 1, 2]) px(sx + k / 2, 9.5 + k / 2, 0.5, 0.5, C.logo, 0);
    }

    if (typing) {
      // near paw on the deck, lifting between keystrokes
      px(9, 9 + hn, 3, 1, C.shade, 0);
      px(9, 8 + hn, 3, 1, C.body, 0);
    }
  }

  return { draw, width, height, SCALE, HEAD, GH, COLORS, SPIN, LAPTOP_FRAMES };
})();
