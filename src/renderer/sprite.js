// Pixel Claude, drawn from rectangles on an 18x13 grid. Tweak shapes, colors and SCALE here.
//
// FRONT VIEW                                LAPTOP VIEW (typing; mirrored to put the laptop on the right)
//   ..................                        ...BBBBBBBBBBBB...  the pet sits 2 rows further back
//   ...BBBBBBBBBBBB...  body x 3-14, y 3-10   ...BB.BBBB.BBB....  eyes look down at the screen
//   ...BB.BBBB.BBB....  eyes x 6 / 11         .AABB.BBBB.BBBBAA.
//   .AABBBBBBBBBBBBAA.  arms x 1-2 / 15-16    ...hhBBBBBBBBBBB..  far hand h taps over the lid's top edge
//   ...BBBBBBBBBBBB...                        =========HHHsss...  lid back x 0-8 (y 8-12), near hand H on the deck
//   ....L.L....L.L....  legs x 4,6,11,13      ===.#.===dd...L...  logo # on the lid, deck d angling away
const Sprite = (() => {
  const SCALE = 4; // screen pixels per grid cell. 5 = a bit bigger, 3 = tiny.
  const GW = 18;
  const GH = 13;
  const HEAD = 9 * SCALE; // headroom above the sprite for jumps and the status glyph
  const COLORS = {
    body: '#D97757',
    shade: '#B9583C',
    eye: '#1F1A17',
    lid: '#2B2A2E', // back of the laptop lid
    lidEdge: '#5E5B64', // its top edge (light enough to outline the laptop on dark desktops)
    lidSide: '#4A4850', // its right side
    logo: '#E6E0D6',
    glow: '#E68D6C', // screen light on the face
    glowSoft: '#E08264',
    mug: '#EFE6D8',
    mugShade: '#CDBFA9',
    coffee: '#4B2F24',
    steam: '#D9D0C6',
    deck: '#6A6770', // keyboard deck
    deckBack: '#57545D', // its far end, in shadow under the pet's hand
    base: '#45434B', // deck's front edge
    glyph: '#D97757',
    alert: '#E5484D',
    zzz: '#8A7F74',
  };
  const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const LAPTOP_FRAMES = 5; // 0 = hidden, 1 = closed on the ground, 2..5 = lid rising

  const width = GW * SCALE;
  const height = HEAD + GH * SCALE;

  /**
   * opts: {
   *   oy: vertical body offset in px (negative = up)
   *   eyes: 'open' | 'closed' | 'wide' | 'happy'
   *   look: [dx, dy] eye offset in grid cells
   *   arms: [left, right] each 'down' | 'up'
   *   legs: 'stand' | 'walkA' | 'walkB'
   *   squash: 0 | 1 (breathing: body top drops one row)
   *   turned: true = laptop view (mirror the canvas to put the laptop on the right)
   *   laptop: 0..LAPTOP_FRAMES (opening animation; laptop view only)
   *   hands: [near, far] 0 = lifted, 1 = on the keys (only when the laptop is fully open)
   *   glyph: { ch, color, size, dx, dy } drawn above the head
   * }
   */
  function draw(ctx, o) {
    const oy = Math.round(o.oy || 0);
    const top = 3 + (o.squash || 0);
    const px = (x, y, w, h, color, offY = oy) => {
      ctx.fillStyle = color;
      ctx.fillRect(x * SCALE, HEAD + y * SCALE + offY, w * SCALE, h * SCALE);
    };
    ctx.clearRect(0, 0, width, height);
    if (o.turned) drawLaptop(o, px, top);
    else drawFront(o, px, top);

    // status glyph (spinner / ! / zzz) above the head
    if (o.glyph) {
      const gy = top - (o.turned ? lift(o) : 0);
      ctx.save();
      ctx.fillStyle = o.glyph.color || COLORS.glyph;
      ctx.font = `${o.glyph.bold ? '800' : '700'} ${o.glyph.size || Math.round(SCALE * 3.6)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(o.glyph.ch, 14.5 * SCALE + (o.glyph.dx || 0), HEAD + gy * SCALE + oy - SCALE + (o.glyph.dy || 0));
      ctx.restore();
    }
  }

  function legs(o, px, xs) {
    xs.forEach((x, i) => {
      const short = (o.legs === 'walkA' && i % 2 === 0) || (o.legs === 'walkB' && i % 2 === 1);
      px(x, 11, 1, short ? 1 : 2, COLORS.body);
    });
  }

  function drawFront(o, px, top) {
    legs(o, px, [4, 6, 11, 13]);
    px(3, top, 12, 11 - top, COLORS.body);
    px(3, 10, 12, 1, COLORS.shade);

    if (o.arms !== 'none') {
      const armY = (a) => (a === 'up' ? top - 1 : 6);
      const [la, ra] = o.arms || ['down', 'down'];
      px(1, armY(la), 2, 2, COLORS.body);
      px(15, armY(ra), 2, 2, COLORS.body);
    }
    if (o.underEyes) o.underEyes(); // e.g. the laptop's screen glow, so it never covers the eyes

    const [lx, ly] = o.look || [0, 0];
    const ey = top + 2;
    const K = COLORS.eye;
    switch (o.eyes) {
      case 'closed':
        px(5 + lx, ey + 1, 2, 1, K);
        px(11 + lx, ey + 1, 2, 1, K);
        break;
      case 'wide':
        px(5, ey, 2, 2, K);
        px(11, ey, 2, 2, K);
        break;
      case 'happy':
        for (const cx of [6, 11]) {
          px(cx - 1, ey + 1, 1, 1, K);
          px(cx, ey, 1, 1, K);
          px(cx + 1, ey + 1, 1, 1, K);
        }
        break;
      default:
        px(6 + lx, ey + ly, 1, 2, K);
        px(11 + lx, ey + ly, 1, 2, K);
    }
  }

  // Laptop view: the pet still faces you and sits back a little behind a laptop on its front-left.
  // You see the back of the lid (with a small logo), the keyboard deck angling away on its right,
  // one hand on the deck and the other arm bobbing down behind the lid's top edge. The screen
  // casts a faint glow on the pet's lower face. Optional coffee mug: on the ground, or in hand.
  function lift(o) {
    const lp = o.laptop || 0;
    return lp >= 4 ? 2 : lp >= 2 ? 1 : 0; // rows the body moves up (= further back) as the lid opens
  }

  function drawLaptop(o, px, top) {
    const L = COLORS;
    const lidH = Math.min(5, o.laptop || 0); // lid rows, rising from the ground
    const typing = lidH === 5;
    const up = lift(o);
    const [hn, hf] = o.hands || [1, 1];
    const sipping = typing && o.mug === 2;

    // the pet itself: the normal front view, moved back, eyes down on the screen while typing
    const back = (x, y, w, h, c) => px(x, y - up, w, h, c);
    const [lx] = o.look || [0, 0];
    const eyes = sipping && o.eyes === 'open' ? 'happy' : o.eyes;
    const glow = () => {
      // faint light from the screen on the lower face, just above the lid
      back(3, 9, 6, 1, L.glow);
      back(4, 8, 4, 1, L.glowSoft);
    };
    drawFront({ ...o, eyes, look: [lx, typing && !sipping ? 1 : 0], arms: typing ? 'none' : o.arms, underEyes: typing ? glow : null }, back, top);

    if (typing) {
      // far arm bobs down toward the keys, stopping just above the lid's edge
      back(1, 7 + hf, 2, 2, L.body);
      if (!sipping) back(15, 6, 2, 2, L.body); // near arm (its hand is on the deck)
    }

    // laptop on the ground; it doesn't bob with the body
    const lidTop = 13 - lidH;
    if (lidH >= 3) {
      // keyboard deck, running back toward the pet on the right of the lid
      px(9, 10, 3, 1, L.deckBack, 0);
      px(9, 11, 4, 1, L.deck, 0);
      px(9, 12, 3, 1, L.base, 0);
    }
    px(0, lidTop, 9, lidH, L.lid, 0); // back of the lid
    px(0, lidTop, 9, 1, L.lidEdge, 0); // top edge
    if (lidH > 1) px(8, lidTop + 1, 1, lidH - 1, L.lidSide, 0); // right side
    if (lidH === 5) {
      // a small logo on the lid, in half-size pixels so it stays delicate
      for (const [x, y] of [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]]) px(3.75 + x / 2, 9.75 + y / 2, 0.5, 0.5, L.logo, 0);
    }

    if (typing && !sipping) {
      // near hand on the keyboard deck, lifting a row between keystrokes
      px(9, 9 + hn, 3, 1, L.shade, 0);
      px(9, 8 + hn, 3, 1, L.body, 0);
    }

    // coffee: 1 = on the ground beside the laptop, 2 = held up in the near hand for a sip
    if (lidH >= 3 && o.mug === 1) mug(px, 15, 10, 0, o.steam, true);
    if (sipping) {
      mug(px, 16, 4 - up, undefined, o.steam, false); // held out at the side
      back(15, 7, 1, 2, L.body); // the hand holding it (covers the handle)
    }
  }

  // 2x3 mug with a little steam; offY 0 = on the ground (doesn't bob)
  function mug(px, x, y, offY, steam = 0, handle = true) {
    const L = COLORS;
    px(x, y, 2, 1, L.coffee, offY);
    px(x, y + 1, 2, 2, L.mug, offY);
    px(x, y + 2, 2, 1, L.mugShade, offY);
    if (handle) px(x + 2, y + 1, 1, 1, L.mug, offY);
    // two wisps rising and swaying, in half-size pixels
    for (const k of [0, 3]) {
      const p = (Math.floor(steam / 5) + k) % 6;
      const sway = [0, 0.5, 0.5, 0, -0.5, -0.5][p];
      px(x + 0.5 + sway, y - 0.5 - p * 0.5, 0.5, 0.5, L.steam, offY);
    }
  }

  return { draw, width, height, SCALE, HEAD, GH, COLORS, SPIN, LAPTOP_FRAMES };
})();
