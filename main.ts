// PNG Squeeze — lossless PNG re-encoder for the make.fun "Squeeze screenshots
// into the smallest PNG" bounty.
//
// Reads each 1280x720 RGBA screenshot from /input/<id>/image.png (stored PNG,
// colour type 6, unfiltered) and writes the same pixels back as a much smaller
// lossless PNG at /output/<id>/image.png.
//
// Strategy, per image:
//   1. Decode the stored PNG and unfilter its rows.
//   2. Analyse the pixels: how many distinct RGBA colours, whether every
//      pixel is opaque, whether the image is greyscale.
//   3. Pick the smallest colour representation that still stores every pixel
//      exactly (a fully transparent pixel's colour included):
//        - <= 256 distinct colours  -> palette (colour type 3) + tRNS if needed
//        - greyscale, all opaque    -> grey (colour type 0)
//        - greyscale with alpha     -> grey+alpha (colour type 4)
//        - colour, all opaque       -> RGB (colour type 2)
//        - otherwise                -> RGBA (colour type 6)
//   4. For each candidate filter plan (adaptive per-row choice by smallest
//      sum of |signed filtered byte|, adaptive by per-row entropy estimate,
//      adaptive over {None, Paeth} only, fixed Paeth, and each fixed filter —
//      screenshots repeat whole rows, so filter 0 can beat Paeth), compress
//      the filtered stream with zlib level 9 at memLevel 8 and keep the
//      smallest file.
//   5. Emit a minimal PNG: IHDR, PLTE/tRNS only when needed, one IDAT, IEND.
//
// Deterministic: no clock, no randomness, no environment reads. Only Node
// built-ins are used; nothing is installed.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, deflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// ---------------------------------------------------------------- PNG decode
// Input is a stored, unfiltered, colour-type-6, bit-depth-8 PNG, but the
// decoder below handles every filter type so it stays correct in general.
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
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
  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(`unsupported input PNG: bitDepth ${bitDepth} colorType ${colorType}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const rgba = Buffer.alloc(width * height * bpp);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : rgba.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const v = raw[src++];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = x >= bpp && prev ? prev[x - bpp] : 0;
      if (filter === 0) row[x] = v;
      else if (filter === 1) row[x] = (v + a) & 0xff;
      else if (filter === 2) row[x] = (v + b) & 0xff;
      else if (filter === 3) row[x] = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        row[x] = (v + pr) & 0xff;
      } else throw new Error(`bad filter ${filter}`);
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- PNG filters
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// Write one filtered row into `out` (length rowBytes + 1, byte 0 = filter id).
// Returns the sum of |signed filtered byte| over the row, used to rank filters.
function filterRow(cur, prev, bpp, filter, out) {
  out[0] = filter;
  const n = cur.length;
  let cost = 0;
  if (filter === 0) {
    for (let i = 0; i < n; i++) {
      const v = cur[i];
      out[i + 1] = v;
      cost += v >= 128 ? 256 - v : v;
    }
  } else if (filter === 1) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const v = (cur[i] - left) & 0xff;
      out[i + 1] = v;
      cost += v >= 128 ? 256 - v : v;
    }
  } else if (filter === 2) {
    for (let i = 0; i < n; i++) {
      const up = prev ? prev[i] : 0;
      const v = (cur[i] - up) & 0xff;
      out[i + 1] = v;
      cost += v >= 128 ? 256 - v : v;
    }
  } else if (filter === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const v = (cur[i] - ((left + up) >> 1)) & 0xff;
      out[i + 1] = v;
      cost += v >= 128 ? 256 - v : v;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const upLeft = i >= bpp && prev ? prev[i - bpp] : 0;
      const v = (cur[i] - paeth(left, up, upLeft)) & 0xff;
      out[i + 1] = v;
      cost += v >= 128 ? 256 - v : v;
    }
  }
  return cost;
}

// Score a filtered row (bytes 1..n of `row`) by its estimated Huffman cost:
// sum over byte values of count * log2(n / count). This tracks the real
// compressed size better than the sum of |signed byte| on photo-like rows.
function entropyCost(row, n) {
  const hist = new Uint32Array(256);
  for (let i = 1; i <= n; i++) hist[row[i]]++;
  let cost = 0;
  for (let i = 0; i < 256; i++) {
    if (hist[i]) cost += hist[i] * Math.log2(n / hist[i]);
  }
  return cost;
}

// Filter a whole plane (rowBytes bytes per row, height rows) under one plan:
//   'adaptive'     — per row, cheapest filter by sum of |signed byte|
//   'adaptive-ent' — per row, cheapest filter by entropy estimate
//   'adaptive-04'  — per row, cheapest of filter 0 / Paeth by |signed byte|
//   'paeth'        — filter 4 on every row
//   'fixedN'       — filter N on every row
function filterPlane(plane, rowBytes, height, bpp, plan) {
  const out = Buffer.alloc((rowBytes + 1) * height);
  const tmp = Buffer.alloc(rowBytes + 1);
  const tmp2 = Buffer.alloc(rowBytes + 1);
  let allowed = null;
  let metric = 'abs';
  if (plan === 'adaptive') allowed = [0, 1, 2, 3, 4];
  else if (plan === 'adaptive-ent') { allowed = [0, 1, 2, 3, 4]; metric = 'ent'; }
  else if (plan === 'adaptive-04') allowed = [0, 4];
  for (let y = 0; y < height; y++) {
    const cur = plane.subarray(y * rowBytes, (y + 1) * rowBytes);
    const prev = y === 0 ? null : plane.subarray((y - 1) * rowBytes, y * rowBytes);
    const dst = out.subarray(y * (rowBytes + 1), (y + 1) * (rowBytes + 1));
    if (allowed) {
      let best = Infinity;
      let bestFilter = 0;
      for (const f of allowed) {
        const absCost = filterRow(cur, prev, bpp, f, tmp);
        const cost = metric === 'ent' ? entropyCost(tmp, rowBytes) : absCost;
        if (cost < best) {
          best = cost;
          bestFilter = f;
          tmp.copy(tmp2);
        }
      }
      tmp2.copy(dst);
      dst[0] = bestFilter;
    } else if (plan === 'paeth') {
      filterRow(cur, prev, bpp, 4, dst);
    } else {
      filterRow(cur, prev, bpp, Number(plan.slice(5)), dst);
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG encode
function encodePng(width, height, colorType, plane, bpp, palette, trns) {
  // Every filter plan is tried for real and the smallest zlib output wins:
  // screenshots repeat whole rows, so an unfiltered row can beat Paeth, and
  // the best plan differs per image. zlib level 9 at the default memLevel 8
  // (memLevel 9 measured worse on this data).
  const plans = ['adaptive', 'adaptive-ent', 'adaptive-04', 'paeth', 'fixed0', 'fixed1', 'fixed2', 'fixed3'];
  let best = null;
  for (const plan of plans) {
    const filtered = filterPlane(plane, width * bpp, height, bpp, plan);
    const idat = deflateSync(filtered, { level: 9 });
    if (!best || idat.length < best.length) best = idat;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', palette));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', best));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- per image
function squeeze(inputPath) {
  const { width, height, rgba } = decodePng(readFileSync(inputPath));
  const pixels = width * height;

  // One pass: distinct colours (stop counting past 256), opaque?, grey?
  const seen = new Map();
  let allOpaque = true;
  let isGrey = true;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const a = rgba[o + 3];
    if (a !== 255) allOpaque = false;
    if (r !== g || g !== b) isGrey = false;
    if (seen.size <= 256) {
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      if (!seen.has(key)) seen.set(key, seen.size);
    }
  }
  const paletteSize = seen.size;

  // --- palette path (flat themes: at most 256 colours) ---
  if (paletteSize <= 256) {
    // Order 1: first occurrence. Order 2: sorted by brightness then RGB,
    // which lines neighbouring palette entries up for the row filters.
    const quads = [...seen.keys()].map((k) => [
      (k >>> 24) & 0xff, (k >>> 16) & 0xff, (k >>> 8) & 0xff, k & 0xff,
    ]);
    const orders = [quads];
    const sorted = [...quads].sort((p, q) => {
      const lp = p[0] + p[1] + p[2];
      const lq = q[0] + q[1] + q[2];
      return lp - lq || p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3];
    });
    if (sorted.some((q, i) => q !== quads[i])) orders.push(sorted);

    let bestFile = null;
    for (const order of orders) {
      const indexOf = new Map();
      order.forEach((q, i) => indexOf.set((q[0] << 24) | (q[1] << 16) | (q[2] << 8) | q[3], i));
      const plane = Buffer.alloc(pixels);
      for (let i = 0; i < pixels; i++) {
        const o = i * 4;
        plane[i] = indexOf.get((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]);
      }
      const plte = Buffer.alloc(order.length * 3);
      const alphas = Buffer.alloc(order.length);
      let needTrns = false;
      order.forEach((q, i) => {
        plte[i * 3] = q[0];
        plte[i * 3 + 1] = q[1];
        plte[i * 3 + 2] = q[2];
        alphas[i] = q[3];
        if (q[3] !== 255) needTrns = true;
      });
      let trns = null;
      if (needTrns) {
        let last = order.length - 1;
        while (last > 0 && alphas[last] === 255) last--;
        trns = alphas.subarray(0, last + 1);
      }
      const file = encodePng(width, height, 3, plane, 1, plte, trns);
      if (!bestFile || file.length < bestFile.length) bestFile = file;
    }
    return bestFile;
  }

  // --- greyscale paths ---
  if (isGrey) {
    if (allOpaque) {
      const plane = Buffer.alloc(pixels);
      for (let i = 0; i < pixels; i++) plane[i] = rgba[i * 4];
      return encodePng(width, height, 0, plane, 1, null, null);
    }
    const plane = Buffer.alloc(pixels * 2);
    for (let i = 0; i < pixels; i++) {
      plane[i * 2] = rgba[i * 4];
      plane[i * 2 + 1] = rgba[i * 4 + 3];
    }
    return encodePng(width, height, 4, plane, 2, null, null);
  }

  // --- colour paths ---
  if (allOpaque) {
    const plane = Buffer.alloc(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      plane[i * 3] = rgba[i * 4];
      plane[i * 3 + 1] = rgba[i * 4 + 1];
      plane[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return encodePng(width, height, 2, plane, 3, null, null);
  }

  // RGBA as-is, only the filters and the compressor do the work.
  return encodePng(width, height, 6, rgba, 4, null, null);
}

// ---------------------------------------------------------------- main
for (const id of readdirSync(INPUT_DIR).sort()) {
  const inFile = join(INPUT_DIR, id, 'image.png');
  const outDir = join(OUTPUT_DIR, id);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'image.png'), squeeze(inFile));
}
