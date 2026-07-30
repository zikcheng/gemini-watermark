/**
 * A minimal PNG reader for the committed test data.
 *
 * The golden comparisons need pixels, and the committed oracle is PNG.
 * Bringing in an npm decoder would put a third-party package between the
 * port and its oracle for no benefit, and pre-decoding into raw buffers
 * would multiply `test/data` several times over for files that are already
 * small. So this decodes the narrow dialect our own generator emits, and
 * refuses anything else rather than guessing.
 *
 * Every PNG under `test/data/` is 8-bit truecolor RGB, non-interlaced,
 * with the standard deflate/adaptive-filter methods — they all come from
 * one `cv2.imwrite` call in `tools/reference/make_patches.py`. The header
 * assertions below state exactly that, so a future generator change that
 * alters the format fails loudly here instead of silently decoding wrong.
 *
 * Tests may use Node APIs freely; only `src/` must stay
 * environment-agnostic (tools/check-imports.mjs enforces that).
 */
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Bytes per pixel for the only colour type accepted here. */
const BYTES_PER_PIXEL = 3;

export interface DecodedPng {
  data: Uint8Array;
  width: number;
  height: number;
  /** Always 3: the reader accepts truecolor RGB only. */
  channels: 3;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`PNG: ${message}`);
}

/**
 * Undo one scanline's filter, in place, per PNG spec section 9.
 *
 * `line` is the filtered scanline; `previous` is the already-reconstructed
 * line above it (zeroes for the first row).
 */
function unfilter(
  type: number,
  line: Uint8Array,
  previous: Uint8Array,
  bpp: number,
): void {
  switch (type) {
    case 0: // None
      break;
    case 1: // Sub
      for (let i = bpp; i < line.length; i += 1) {
        line[i] = ((line[i] ?? 0) + (line[i - bpp] ?? 0)) & 0xff;
      }
      break;
    case 2: // Up
      for (let i = 0; i < line.length; i += 1) {
        line[i] = ((line[i] ?? 0) + (previous[i] ?? 0)) & 0xff;
      }
      break;
    case 3: // Average
      for (let i = 0; i < line.length; i += 1) {
        const left = i >= bpp ? (line[i - bpp] ?? 0) : 0;
        line[i] = ((line[i] ?? 0) + ((left + (previous[i] ?? 0)) >> 1)) & 0xff;
      }
      break;
    case 4: // Paeth
      for (let i = 0; i < line.length; i += 1) {
        const a = i >= bpp ? (line[i - bpp] ?? 0) : 0;
        const b = previous[i] ?? 0;
        const c = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = ((line[i] ?? 0) + predictor) & 0xff;
      }
      break;
    default:
      assert(false, `unknown filter type ${type}`);
  }
}

/**
 * Decode an 8-bit truecolor PNG to interleaved RGB bytes.
 *
 * @throws Error when the file is not the narrow dialect described above
 */
export function decodePng(file: Uint8Array): DecodedPng {
  assert(
    SIGNATURE.every((byte, i) => file[i] === byte),
    'not a PNG (bad signature)',
  );

  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];

  let offset = SIGNATURE.length;
  while (offset < file.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...file.subarray(offset + 4, offset + 8));
    const body = offset + 8;

    if (type === 'IHDR') {
      width = view.getUint32(body);
      height = view.getUint32(body + 4);
      const [depth, colorType, compression, filterMethod, interlace] = [
        file[body + 8],
        file[body + 9],
        file[body + 10],
        file[body + 11],
        file[body + 12],
      ];
      assert(depth === 8, `expected 8-bit samples, got ${String(depth)}`);
      assert(colorType === 2, `expected truecolor RGB (2), got ${String(colorType)}`);
      assert(compression === 0, `unexpected compression method ${String(compression)}`);
      assert(filterMethod === 0, `unexpected filter method ${String(filterMethod)}`);
      assert(interlace === 0, 'interlaced PNGs are not supported');
    } else if (type === 'IDAT') {
      // Encoders may split the pixel stream over several IDAT chunks; the
      // deflate stream spans all of them and must be joined before inflate.
      idat.push(file.subarray(body, body + length));
    } else if (type === 'IEND') {
      break;
    }

    offset = body + length + 4; // skip the chunk's trailing CRC
  }

  assert(width > 0 && height > 0, 'missing or empty IHDR');
  assert(idat.length > 0, 'no IDAT data');

  const compressed = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of idat) {
    compressed.set(chunk, at);
    at += chunk.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));

  const stride = width * BYTES_PER_PIXEL;
  assert(
    raw.length === height * (stride + 1),
    `inflated ${raw.length} bytes, expected ${height * (stride + 1)} ` +
      `(${width}x${height} plus one filter byte per row)`,
  );

  const data = new Uint8Array(height * stride);
  let previous = new Uint8Array(stride);
  for (let row = 0; row < height; row += 1) {
    const start = row * (stride + 1);
    const line = raw.slice(start + 1, start + 1 + stride);
    unfilter(raw[start] ?? 0, line, previous, BYTES_PER_PIXEL);
    data.set(line, row * stride);
    previous = line;
  }

  return { data, width, height, channels: 3 };
}

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/**
 * Encode interleaved RGB bytes as an 8-bit truecolor PNG.
 *
 * Only used to hand images to the reference C++ binary in the add-V2
 * round trip, so it takes the simplest correct route: filter type 0 on
 * every row and let deflate do the work. The binary re-decodes it, so
 * nothing here needs to match any particular encoder byte for byte.
 */
export function encodePng(image: {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}): Uint8Array {
  const { data, width, height } = image;
  const stride = width * BYTES_PER_PIXEL;
  if (data.length !== height * stride) {
    throw new RangeError(
      `PNG: ${data.length} bytes for ${width}x${height} RGB, expected ${height * stride}`,
    );
  }

  const raw = new Uint8Array(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0; // filter: None
    raw.set(data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolor, deflate, adaptive, non-interlaced

  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
