// Pixel Claude, drawn from rectangles on an 18x13 grid. Tweak shapes, colors and SCALE here.
//
// FRONT VIEW                                THREE-QUARTER VIEW (typing; mirrored when facing left)
//   ..................                        ..................
//   ...BBBBBBBBBBBB...  body x 3-14, y 3-10   ...sBBBBBBBBBB....  body x 3-13, far side s = x 3
//   ...BB.BBBB.BBB....  eyes x 6 / 11         ...sBBBB.BB.g...#.  eyes x 8 / 11, face glow x 13
//   .AABBBBBBBBBBBBAA.  arms x 1-2 / 15-16    ..asBBBBBBBBg..F##  far arm a, screen edge F x 15, lid back x 16-17
//   ...BBBBBBBBBBBB...                        ...sBBBBBBBBhHHF##  near hand H x 13-14, far hand h x 12
//   ....L.L....L.L....  legs x 4,6,11,13      ....L.L..L.L.====.  deck x 13-16 (y 11), front edge x 12-17 (y 12)
const Sprite = (() => {
  const SCALE = 4; // screen pixels per grid cell. 5 = a bit bigger, 3 = tiny.
  const GW = 18;
  const GH = 13;
  const HEAD = 9 * SCALE; // headroom above the sprite for jumps and the status glyph
  const COLORS = {
    body: '#D97757',
    shade: '#B9583C',
    sidePlane: '#C6684B', // the far side of the body, visible in the three-quarter view
    eye: '#1F1A17',
    glow: '#EDA287',
    lid: '#B9B2A9',
    lidEdge: '#DDD8D1',
    screen: '#FBF4E8',
    cursor: '#D97757',
    base: '#8F877E',
    deck: '#C9C2B9',
    glyph: '#D97757',
    alert: '#E5484D',
    zzz: '#8A7F74',
  };
  const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const LAPTOP_FRAMES = 5; // 0 = hidden, 1 = keyboard only, 2..5 = lid rising

  const width = GW * SCALE;
  const height = HEAD + GH * SCALE;

  /**
   * opts: {
   *   oy: vertical body offset in px (negative = up)
   *   eyes: 'open' | 'closed' | 'wide' | 'happy'
   *   look: [dx, dy] eye offset in grid cells (front view)
   *   arms: [left, right] each 'down' | 'up' (front view; turned view uses the near arm)
   *   legs: 'stand' | 'walkA' | 'walkB'
   *   squash: 0 | 1 (breathing: body top drops one row)
   *   turned: true = three-quarter view turned to the right (mirror the canvas to face left)
   *   laptop: 0..LAPTOP_FRAMES (opening animation; turned view only)
   *   hands: [near, far] 0 = lifted, 1 = on the keys (only when the laptop is fully open)
   *   screenRow: 0..3 which line of the screen the cursor is on
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
    if (o.turned) drawTurned(o, px, top);
    else drawFront(o, px, top);

    // status glyph (spinner / ! / zzz) above the head
    if (o.glyph) {
      ctx.save();
      ctx.fillStyle = o.glyph.color || COLORS.glyph;
      ctx.font = `${o.glyph.bold ? '800' : '700'} ${o.glyph.size || Math.round(SCALE * 3.6)}px "Segoe UI Symbol", "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      const gx = o.turned ? 12.5 : 14.5;
      ctx.fillText(o.glyph.ch, gx * SCALE + (o.glyph.dx || 0), HEAD + top * SCALE + oy - SCALE + (o.glyph.dy || 0));
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

  // Three-quarter view: turned partly toward a laptop at its front-right. Both eyes still show
  // (shifted toward the laptop), the far side of the body is a darker strip, and the laptop is
  // seen at an angle: deck, back of the lid, and a lit sliver of screen facing the pet.
  function drawTurned(o, px, top) {
    const lp = o.laptop || 0;
    const lidH = Math.max(0, Math.min(4, lp - 1)); // lid rows visible (rises from the hinge)
    const typing = lidH === 4;
    const [hn, hf] = o.hands || [1, 1];
    const up = (a) => a === 'up';
    const [farArm, nearArm] = o.arms || ['down', 'down'];

    // far arm peeks out behind the body, in shade
    px(2, up(farArm) ? top - 1 : 6, 1, 2, COLORS.shade);

    legs(o, px, [4, 6, 9, 11]);
    px(3, top, 11, 11 - top, COLORS.body);
    px(3, top, 1, 10 - top, COLORS.sidePlane); // far side of the body
    px(3, 10, 11, 1, COLORS.shade);
    if (typing) px(13, top + 1, 1, 4, COLORS.glow); // screen light on the face

    // both eyes, shifted toward the laptop and a little closer together
    const ey = top + 2;
    const K = COLORS.eye;
    switch (o.eyes) {
      case 'closed':
        px(7, ey + 1, 2, 1, K);
        px(10, ey + 1, 2, 1, K);
        break;
      case 'wide':
        px(7, ey, 2, 2, K);
        px(10, ey, 2, 2, K);
        break;
      case 'happy':
        for (const cx of [8, 11]) {
          px(cx - 1, ey + 1, 1, 1, K);
          px(cx, ey, 1, 1, K);
          px(cx + 1, ey + 1, 1, 1, K);
        }
        break;
      default:
        px(8, ey, 1, 2, K);
        px(11, ey, 1, 2, K);
    }

    // laptop on the ground, at an angle; it doesn't bob with the body
    if (lp > 0) {
      px(13, 11, 5, 1, COLORS.deck, 0); // keyboard deck (top surface)
      px(12, 12, 5, 1, COLORS.base, 0); // front edge, shifted toward the viewer
      if (lidH > 0) {
        px(17, 10 - lidH, 1, lidH + 1, COLORS.lid, 0); // lid back, outer edge (a row taller: slant)
        px(16, 11 - lidH, 1, lidH, COLORS.lid, 0); // lid back
        px(17, 10 - lidH, 1, 1, COLORS.lidEdge, 0); // top corner highlight
      }
      if (lidH > 1) {
        px(15, 11 - lidH, 1, lidH - 1, COLORS.screen, 0); // lit screen edge, facing the pet
        if (typing) px(15, 7 + ((o.screenRow || 0) % 3), 1, 1, COLORS.cursor, 0);
      }
    }

    if (typing) {
      px(15, 10 + hf, 1, 1, COLORS.shade, 0); // far hand, reaching past the near one
      px(13, 10 + hn, 2, 1, COLORS.body, 0); // near hand
    } else {
      px(14, up(nearArm) ? top - 1 : 6, 1, 2, COLORS.body); // near arm nub
    }
  }

  return { draw, width, height, SCALE, HEAD, GH, COLORS, SPIN, LAPTOP_FRAMES };
})();
