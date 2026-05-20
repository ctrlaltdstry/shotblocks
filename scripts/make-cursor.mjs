// Build a multi-resolution Windows .cur from a source PNG.
//
//   node scripts/make-cursor.mjs <source.png> <out.cur> [hotspot]
//
//   hotspot: "center" (default) or "x,y" as a fraction 0..1 of the
//            image (e.g. "0,0" = top-left, "0.5,0.5" = center).
//
// Self-contained — pure Node (zlib for PNG inflate), no browser, no
// ImageMagick. Decodes the PNG to RGBA, box-downscales to 32 / 48 /
// 64 px, and packs all three as classic BMP-format cursor images so
// Windows picks the sharpest for the display DPI.
//
// Used to (re)generate the slip cursor and any future tool cursors:
//   node scripts/make-cursor.mjs Cursors/Slip\ Cursor.png \
//     host/shotblocks_v2/web/public/cursors/slip.cur
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const [srcPath, outPath, hotspotArg] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error('usage: node make-cursor.mjs <source.png> <out.cur> [center|x,y]');
  process.exit(1);
}

// ---- minimal PNG decoder (8-bit RGBA / RGB, no interlace) ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} (need 8-bit RGB/RGBA)`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  // Undo per-scanline filters into a flat RGBA buffer.
  const rgba = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    raw.copy(cur, 0, rp, rp + stride);
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0; // left
      const b = prev[i];                                // up
      const c = i >= channels ? prev[i - channels] : 0; // up-left
      let v = cur[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      rgba[d] = cur[s];
      rgba[d + 1] = cur[s + 1];
      rgba[d + 2] = cur[s + 2];
      rgba[d + 3] = channels === 4 ? cur[s + 3] : 255;
    }
    cur.copy(prev);
  }
  return { width, height, rgba };
}

// ---- box-filter downscale (averaging, premultiplied alpha) ---------
function downscale(src, sw, sh, N) {
  const out = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    const y0 = Math.floor((y * sh) / N);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / N));
    for (let x = 0; x < N; x++) {
      const x0 = Math.floor((x * sw) / N);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / N));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * sw + sx) * 4;
          const al = src[s + 3] / 255;
          // premultiply so transparent pixels don't bleed colour
          r += src[s] * al;
          g += src[s + 1] * al;
          b += src[s + 2] * al;
          a += src[s + 3];
          n++;
        }
      }
      const d = (y * N + x) * 4;
      const alpha = a / n;
      const am = alpha / 255;
      out[d] = am > 0 ? Math.round(r / n / am) : 0;
      out[d + 1] = am > 0 ? Math.round(g / n / am) : 0;
      out[d + 2] = am > 0 ? Math.round(b / n / am) : 0;
      out[d + 3] = Math.round(alpha);
    }
  }
  return out;
}

// ---- one BMP-format cursor image (BITMAPINFOHEADER + BGRA + mask) --
function buildImage(rgba, N) {
  const color = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    const dstRow = N - 1 - y; // bottom-up
    for (let x = 0; x < N; x++) {
      const s = (y * N + x) * 4, d = (dstRow * N + x) * 4;
      color[d] = rgba[s + 2];     // B
      color[d + 1] = rgba[s + 1]; // G
      color[d + 2] = rgba[s];     // R
      color[d + 3] = rgba[s + 3]; // A
    }
  }
  const maskRowBytes = Math.ceil(N / 8 / 4) * 4;
  const mask = Buffer.alloc(maskRowBytes * N, 0);
  for (let y = 0; y < N; y++) {
    const dstRow = N - 1 - y;
    for (let x = 0; x < N; x++) {
      if (rgba[(y * N + x) * 4 + 3] === 0) {
        mask[dstRow * maskRowBytes + (x >> 3)] |= (0x80 >> (x & 7));
      }
    }
  }
  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0);
  bih.writeInt32LE(N, 4);
  bih.writeInt32LE(N * 2, 8); // height doubled: color + mask
  bih.writeUInt16LE(1, 12);
  bih.writeUInt16LE(32, 14);
  bih.writeUInt32LE(color.length + mask.length, 20);
  return Buffer.concat([bih, color, mask]);
}

// ---- main ----------------------------------------------------------
const { width, height, rgba } = decodePng(readFileSync(srcPath));

// Hotspot as a 0..1 fraction of the image.
//   "center"  (default) — image centre. Use for symmetric cursors.
//   "tip"               — auto-detect the arrow tip: the first
//                         opaque pixel scanning top-down, left-right.
//                         Use for pointer-style cursors.
//   "x,y"               — explicit fraction.
let hx = 0.5, hy = 0.5;
if (hotspotArg === 'tip') {
  let found = false;
  for (let y = 0; y < height && !found; y++) {
    for (let x = 0; x < width && !found; x++) {
      if (rgba[(y * width + x) * 4 + 3] > 10) {
        hx = x / width;
        hy = y / height;
        found = true;
      }
    }
  }
} else if (hotspotArg && hotspotArg !== 'center') {
  const [a, b] = hotspotArg.split(',').map(Number);
  if (Number.isFinite(a) && Number.isFinite(b)) { hx = a; hy = b; }
}

const SIZES = [32, 48, 64];
const images = SIZES.map((N) => ({
  size: N,
  hotX: Math.round(hx * N),
  hotY: Math.round(hy * N),
  image: buildImage(downscale(rgba, width, height, N), N),
}));

const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(2, 2); // type 2 = cursor
dir.writeUInt16LE(images.length, 4);

let offset = 6 + 16 * images.length;
const entries = images.map(({ size, hotX, hotY, image }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size & 0xff, 0);
  e.writeUInt8(size & 0xff, 1);
  e.writeUInt16LE(hotX, 4);          // cursor hotspot X
  e.writeUInt16LE(hotY, 6);          // cursor hotspot Y
  e.writeUInt32LE(image.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += image.length;
  return e;
});

writeFileSync(outPath, Buffer.concat([dir, ...entries, ...images.map((i) => i.image)]));

// ---- 32px PNG for the CSS data-URI cursor --------------------------
// The two-layer cursor model needs the SAME image as a CSS data-URI
// (see feedback memory tool-cursor-pattern). Encode the 32px
// downscale as a PNG and write a sidecar `<out>.cssurl.txt` holding
// the ready-to-paste `cursor:` value — so a cursor iteration is just
// this one command, no separate base64 step.
function pngCRC(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(pngCRC(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, cr]);
}
function encodePng32(rgba32) {
  const N = 32;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const rows = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    rows[y * (N * 4 + 1)] = 0; // no filter
    rgba32.copy(rows, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgba32 = downscale(rgba, width, height, 32);
const cssHotX = Math.round(hx * 32);
const cssHotY = Math.round(hy * 32);
const dataUri = 'data:image/png;base64,' + encodePng32(rgba32).toString('base64');
const cssValue = `cursor: url("${dataUri}") ${cssHotX} ${cssHotY}, default;`;
writeFileSync(outPath + '.cssurl.txt', cssValue + '\n');

console.log(`wrote ${outPath} — source ${width}x${height}, sizes ${SIZES.join('/')}`);
console.log(`  hotspot fraction ${hx.toFixed(3)},${hy.toFixed(3)}  ->  CSS hotspot: ${cssHotX} ${cssHotY}`);
console.log(`  CSS data-URI value written to ${outPath}.cssurl.txt`);
