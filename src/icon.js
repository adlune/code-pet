// The pet's icon: a 16x16 pixel Claude, shared by the tray, toasts and the app/shortcut .ico.
// rgba(scale) rasterizes it with nearest-neighbor scaling; toIco() packs several sizes into a .ico.
const zlib = require('zlib');

const G = 16;
const O = [0xd9, 0x77, 0x57]; // body
const D = [0xb9, 0x58, 0x3c]; // shade
const K = [0x1f, 0x1a, 0x17]; // eyes
// [x, y, w, h, color] on the 16x16 grid (rows 3..12, so it sits centered)
const ART = [
  [2, 3, 12, 8, O],
  [2, 10, 12, 1, D],
  [0, 6, 2, 2, O],
  [14, 6, 2, 2, O],
  [5, 5, 1, 2, K],
  [10, 5, 1, 2, K],
  ...[3, 5, 10, 12].map((x) => [x, 11, 1, 2, O]),
];

/** Returns { width, height, rgba } at G*scale pixels square. Pass bgra=true for nativeImage bitmaps. */
function rgba(scale, bgra = false) {
  const N = G * scale;
  const buf = Buffer.alloc(N * N * 4);
  for (const [x, y, w, h, [r, g, b]] of ART)
    for (let yy = y * scale; yy < (y + h) * scale; yy++)
      for (let xx = x * scale; xx < (x + w) * scale; xx++) {
        const i = (yy * N + xx) * 4;
        buf[i] = bgra ? b : r;
        buf[i + 1] = g;
        buf[i + 2] = bgra ? r : b;
        buf[i + 3] = 255;
      }
  return { width: N, height: N, rgba: buf };
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png({ width, height, rgba: px }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// classic .ico frame: BITMAPINFOHEADER + bottom-up BGRA pixels + an (empty) AND mask
function dib({ width: N, rgba: px }) {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(N, 4);
  head.writeInt32LE(N * 2, 8); // height counts the XOR image + the AND mask
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const s = (y * N + x) * 4;
      const d = ((N - 1 - y) * N + x) * 4;
      pixels[d] = px[s + 2];
      pixels[d + 1] = px[s + 1];
      pixels[d + 2] = px[s];
      pixels[d + 3] = px[s + 3];
    }
  const mask = Buffer.alloc(Math.ceil(N / 32) * 4 * N);
  return Buffer.concat([head, pixels, mask]);
}

/** A .ico at 16, 32, 48, 64 (BMP frames) and 256 px (PNG frame); exact multiples, so it stays crisp. */
function toIco(scales = [1, 2, 3, 4, 16]) {
  const imgs = scales.map((s) => (G * s >= 256 ? png(rgba(s)) : dib(rgba(s))));
  const header = Buffer.alloc(6 + 16 * imgs.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(imgs.length, 4);
  let offset = header.length;
  imgs.forEach((img, i) => {
    const size = G * scales[i];
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(img.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([header, ...imgs]);
}

module.exports = { rgba, png, toIco };
