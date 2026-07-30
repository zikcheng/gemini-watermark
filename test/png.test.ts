import { crc32, deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decodePng, encodePng } from './helpers/png.js';

/**
 * Unit tests for the PNG helper's unfilter logic.
 *
 * `test/blend-crops.test.ts` already checks the decoder against all 80
 * committed images and the hashes cv2 recorded for them, which is the
 * strongest evidence available — but it only exercises one code path:
 * every scanline our generator emits uses filter type 1 (Sub). The other
 * four reconstruction filters are dead in that corpus, so a fault in them
 * would go unnoticed until some future regeneration started using them.
 *
 * These build PNGs for each filter type directly, so all five branches are
 * exercised on data whose expected output is known by construction.
 */
const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(out.length - 4, crc32(out.subarray(4, out.length - 4)));
  return out;
}

/** Apply one PNG filter to raw RGB rows, producing the encoder's view. */
function filterRows(
  pixels: Uint8Array,
  width: number,
  height: number,
  type: number,
): Uint8Array {
  const stride = width * 3;
  const out = new Uint8Array(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    out[row * (stride + 1)] = type;
    for (let i = 0; i < stride; i += 1) {
      const raw = pixels[row * stride + i] ?? 0;
      const a = i >= 3 ? (pixels[row * stride + i - 3] ?? 0) : 0;
      const b = row > 0 ? (pixels[(row - 1) * stride + i] ?? 0) : 0;
      const c = row > 0 && i >= 3 ? (pixels[(row - 1) * stride + i - 3] ?? 0) : 0;
      let value: number;
      switch (type) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw - a;
          break;
        case 2:
          value = raw - b;
          break;
        case 3:
          value = raw - ((a + b) >> 1);
          break;
        default: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = raw - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
        }
      }
      out[row * (stride + 1) + 1 + i] = value & 0xff;
    }
  }
  return out;
}

function buildPng(pixels: Uint8Array, width: number, height: number, filter: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);

  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(filterRows(pixels, width, height, filter)))),
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

// Content with horizontal and vertical structure plus wrap-around values,
// so every predictor sees a non-trivial neighbourhood.
const WIDTH = 5;
const HEIGHT = 4;
const PIXELS = Uint8Array.from({ length: WIDTH * HEIGHT * 3 }, (_, i) => (i * 37 + (i % 7) * 11) % 256);

describe('decodePng', () => {
  it.each([
    [0, 'None'],
    [1, 'Sub'],
    [2, 'Up'],
    [3, 'Average'],
    [4, 'Paeth'],
  ])('reconstructs filter type %i (%s)', (filter) => {
    const decoded = decodePng(buildPng(PIXELS, WIDTH, HEIGHT, filter));
    expect(decoded.width).toBe(WIDTH);
    expect(decoded.height).toBe(HEIGHT);
    expect(Array.from(decoded.data)).toEqual(Array.from(PIXELS));
  });

  it('round-trips through the encoder', () => {
    const decoded = decodePng(encodePng({ data: PIXELS, width: WIDTH, height: HEIGHT }));
    expect(Array.from(decoded.data)).toEqual(Array.from(PIXELS));
  });

  it('joins pixel data split across several IDAT chunks', () => {
    // Real encoders split large images; cv2 does it for ours. Splitting a
    // deflate stream mid-way is legal and the reader must concatenate
    // before inflating.
    const whole = buildPng(PIXELS, WIDTH, HEIGHT, 1);
    const idatStart = 8 + 25; // signature + IHDR chunk
    const idatLength = new DataView(whole.buffer).getUint32(idatStart);
    const body = whole.subarray(idatStart + 8, idatStart + 8 + idatLength);
    const half = Math.floor(body.length / 2);

    const parts = [
      SIGNATURE,
      whole.subarray(8, idatStart),
      chunk('IDAT', body.subarray(0, half)),
      chunk('IDAT', body.subarray(half)),
      chunk('IEND', new Uint8Array(0)),
    ];
    const split = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      split.set(part, at);
      at += part.length;
    }
    expect(Array.from(decodePng(split).data)).toEqual(Array.from(PIXELS));
  });

  it('refuses formats outside the dialect it was written for', () => {
    expect(() => decodePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/bad signature/);

    const sixteenBit = buildPng(PIXELS, WIDTH, HEIGHT, 0);
    sixteenBit[8 + 8 + 8] = 16; // IHDR bit depth
    expect(() => decodePng(sixteenBit)).toThrow(/expected 8-bit samples, got 16/);

    const rgba = buildPng(PIXELS, WIDTH, HEIGHT, 0);
    rgba[8 + 8 + 9] = 6; // IHDR colour type: truecolor + alpha
    expect(() => decodePng(rgba)).toThrow(/expected truecolor RGB \(2\), got 6/);

    const interlaced = buildPng(PIXELS, WIDTH, HEIGHT, 0);
    interlaced[8 + 8 + 12] = 1; // IHDR interlace method
    expect(() => decodePng(interlaced)).toThrow(/interlaced/);
  });
});
