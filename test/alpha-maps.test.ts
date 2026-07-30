import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { WatermarkSize, WatermarkVariant } from '../src/types.js';
import { decodeBase64, getSourceAlphaMap } from '../src/alpha-maps.js';

/**
 * Expected values are printed by `tools/gen_alpha_module.py` and hardcoded
 * here, so the test compares the shipped module against the kit extraction
 * rather than against itself.
 *
 * The checkpoints are not arbitrary coordinates: the generator picks, per
 * quadrant, the pixel that changes most under the *weakest* of transpose,
 * horizontal flip and vertical flip. Each one therefore catches all three
 * on its own — which corner-ish coordinates could not, since the logo sits
 * in the middle and the corners are near-black background.
 */
const MAPS: ReadonlyArray<{
  variant: WatermarkVariant;
  size: WatermarkSize;
  edge: number;
  sha256: string;
  checkpoints: ReadonlyArray<readonly [x: number, y: number, value: number]>;
}> = [
  {
    variant: 'V1',
    size: 'small',
    edge: 48,
    sha256: '5009eebd2969e887aa29235978169f7ea21d4cf039658a9a9f590a8d2be55ccb',
    checkpoints: [
      [21, 5, 80],
      [26, 5, 96],
      [21, 42, 97],
      [42, 26, 96],
    ],
  },
  {
    variant: 'V1',
    size: 'large',
    edge: 96,
    sha256: '06f0fe1d7e23bbbb2c8700cea09b4128b6a192f2ec69daa730538a279c4ad855',
    checkpoints: [
      [40, 15, 82],
      [80, 40, 82],
      [40, 80, 65],
      [55, 80, 82],
    ],
  },
  {
    variant: 'V2',
    size: 'small',
    edge: 36,
    sha256: '557ea2a54da492948e5346c4feae073e0c764442a610e32a8c0604cd52c05d49',
    checkpoints: [
      [15, 5, 45],
      [20, 5, 53],
      [5, 20, 45],
      [30, 20, 53],
    ],
  },
  {
    variant: 'V2',
    size: 'large',
    edge: 96,
    sha256: '99b43db74b7bcb4c9460e1a674dd481e1945a5ceb58e030db01048c4f51d1394',
    checkpoints: [
      [41, 12, 24],
      [54, 12, 35],
      [41, 82, 48],
      [82, 54, 46],
    ],
  },
];

/** Recover the baked bytes from the public API's float output. */
function toBytes(alpha: Float32Array): Uint8Array {
  return Uint8Array.from(alpha, (v) => Math.round(v * 255));
}

describe.each(MAPS)('alpha source map $variant/$size', (map) => {
  const { variant, size, edge } = map;

  it(`is ${edge}x${edge}`, () => {
    expect(getSourceAlphaMap(variant, size)).toHaveLength(edge * edge);
  });

  it('matches the calibration bytes extracted from the upstream assets', () => {
    // Hashing the round-tripped bytes pins the data *and* the reversibility
    // of the /255 the getter applies: a scaling slip would break the digest.
    const digest = createHash('sha256').update(toBytes(getSourceAlphaMap(variant, size)))
      .digest('hex');
    expect(digest).toBe(map.sha256);
  });

  it('has the expected value at each transform-discriminating checkpoint', () => {
    const alpha = getSourceAlphaMap(variant, size);
    for (const [x, y, expected] of map.checkpoints) {
      const actual = alpha[y * edge + x];
      // Two assertions on purpose. The byte-space one says what the pixel
      // is; the fround one pins the exact float32, and would catch a getter
      // that returned, say, v/256. Comparing against a bare `expected / 255`
      // would fail even when correct — that is a float64 quotient, and
      // Float32Array rounds what it stores.
      //
      // What the fround assertion pins is *this* implementation's float32,
      // not upstream's. C++ multiplies by 1/255 in a float32 work type and
      // lands one ulp away on 5 of the byte values here (24, 48, 53, 96,
      // 97), which covers 7 of these 16 checkpoints — see DEVIATIONS D4 for
      // why that is inside the contract. If the getter is ever changed to
      // match C++ bit for bit, those seven go red on purpose: that is the
      // signal to update these constants, not a regression.
      expect(Math.round((actual ?? -1) * 255)).toBe(expected);
      expect(actual).toBe(Math.fround(expected / 255));
    }
  });

  it('returns a fresh array, so a caller cannot poison the cache', () => {
    const first = getSourceAlphaMap(variant, size);
    const original = first[0];
    first[0] = 999;

    const second = getSourceAlphaMap(variant, size);
    expect(second).not.toBe(first);
    expect(second[0]).toBe(original);
    expect(second[0]).not.toBe(999);
  });
});

describe('getSourceAlphaMap', () => {
  it('rejects a combination that has no source map', () => {
    expect(() =>
      getSourceAlphaMap('V3' as WatermarkVariant, 'small'),
    ).toThrow(RangeError);
    expect(() =>
      getSourceAlphaMap('V1', 'medium' as WatermarkSize),
    ).toThrow(/no alpha source map/);
  });

  it('gives V1 and V2 different data at the same size', () => {
    // Guards against the generator wiring both profiles to one capture:
    // the maps are the same length, so only the values reveal a mix-up.
    const v1 = getSourceAlphaMap('V1', 'large');
    const v2 = getSourceAlphaMap('V2', 'large');
    expect(v1).toHaveLength(v2.length);
    expect(Array.from(v1)).not.toEqual(Array.from(v2));
  });
});

describe('decodeBase64', () => {
  // ASCII-only helpers, so the suite leans on nothing but ES2022 and the
  // one declared Node import — no TextEncoder, no btoa, nothing whose
  // availability varies across the Node matrix or a browser run.
  const decode = (s: string): string =>
    Array.from(decodeBase64(s), (b) => String.fromCharCode(b)).join('');
  const asciiBytes = (s: string): number[] =>
    Array.from(s, (c) => c.charCodeAt(0));

  /** base64 of the bytes 0x00..0xff, in order. */
  const ALL_BYTES_B64 =
    'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BB' +
    'QkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKD' +
    'hIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TF' +
    'xsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/w==';

  it('decodes the empty string to an empty array', () => {
    expect(decodeBase64('')).toHaveLength(0);
  });

  // RFC 4648 section 10.
  it.each([
    ['Zg==', 'f'],
    ['Zm8=', 'fo'],
    ['Zm9v', 'foo'],
    ['Zm9vYg==', 'foob'],
    ['Zm9vYmE=', 'fooba'],
    ['Zm9vYmFy', 'foobar'],
  ])('decodes %s to %s (RFC 4648 vector)', (encoded, plain) => {
    expect(decode(encoded)).toBe(plain);
    expect(Array.from(decodeBase64(encoded))).toEqual(asciiBytes(plain));
  });

  it('decodes every byte value, including the 0x00/0xff extremes', () => {
    // Covers the whole alphabet including `+` and `/`, which only appear
    // for high byte values and would otherwise go untested.
    const all = Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(decodeBase64(ALL_BYTES_B64))).toEqual(all);
  });

  it('treats padding permissively, as the pinned contract requires', () => {
    // `=` decodes as zero bits wherever it appears and only the trailing
    // padding count sets the output length. The sole real input is the
    // trusted base64 baked into alpha-maps.ts, so this is deliberate
    // behaviour, asserted rather than tightened (see the decoder's doc
    // comment). If a future change rejects misplaced padding, that is a
    // contract change and this test should be updated knowingly.
    expect(Array.from(decodeBase64('A=A='))).toEqual([0, 0]);
    expect(Array.from(decodeBase64('===='))).toEqual([0]);
    expect(Array.from(decodeBase64('AA=='))).toEqual([0]);
  });

  it('rejects a length that is not a multiple of 4', () => {
    expect(() => decodeBase64('Zg=')).toThrow(RangeError);
    expect(() => decodeBase64('Zg=')).toThrow(/not a multiple of 4/);
  });

  it.each(['Zm9@', 'Zm9é', 'Zm9中'])(
    'rejects the invalid character in %j',
    (input) => {
      expect(() => decodeBase64(input)).toThrow(RangeError);
      expect(() => decodeBase64(input)).toThrow(/invalid base64 character/);
    },
  );
});
