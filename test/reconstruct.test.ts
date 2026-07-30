import { describe, expect, it } from 'vitest';

import type { ImageBuffer } from '../src/types.js';
import { reconstructImage, type CaseMeta } from './helpers/reconstruct.js';
import meta from './data/cases/v2-small-1024x572/meta.json';

/**
 * Compile-time contract between the generator's output and {@link CaseMeta}.
 *
 * Every field is read through, so dropping one from `make_patches.py` stops
 * this compiling — which a blanket `as CaseMeta` would have silently
 * absorbed. The narrowing casts are confined to the fields TypeScript
 * widens when importing JSON (string literals become `string`); those are
 * checked at runtime in the test below instead.
 */
function asCaseMeta(m: typeof meta): CaseMeta {
  return {
    name: m.name,
    original_size: m.original_size,
    input_format: m.input_format as CaseMeta['input_format'],
    eligible_for: m.eligible_for as CaseMeta['eligible_for'],
    fixture: m.fixture as NonNullable<CaseMeta['fixture']>,
    patch: {
      bbox: m.patch.bbox,
      channels: m.patch.channels as CaseMeta['patch']['channels'],
      files: m.patch.files,
    },
    blend: {
      bbox: m.blend.bbox,
      watermark_region_in_crop: m.blend.watermark_region_in_crop,
      files: m.blend.files,
    },
  };
}

/** A patch whose pixels encode their own position, so misplacement shows. */
function makePatch(w: number, h: number, channels: 3 | 4): ImageBuffer {
  const data = new Uint8Array(w * h * channels);
  for (let i = 0; i < data.length; i += 1) data[i] = (i % 255) + 1;
  return { data, width: w, height: h, channels };
}

describe('reconstructImage', () => {
  const placement = {
    original_size: { width: 20, height: 10 },
    patch: { bbox: { x: 4, y: 3, w: 5, h: 2 } },
  };

  it('returns a buffer of the original size, not the patch size', () => {
    const out = reconstructImage(makePatch(5, 2, 3), placement);
    expect(out.width).toBe(20);
    expect(out.height).toBe(10);
    expect(out.channels).toBe(3);
    expect(out.data.length).toBe(20 * 10 * 3);
  });

  it('places the patch at the bbox origin and zero-fills everything else', () => {
    const patch = makePatch(5, 2, 3);
    const out = reconstructImage(patch, placement);

    for (let row = 0; row < 2; row += 1) {
      const from = row * 5 * 3;
      const to = ((3 + row) * 20 + 4) * 3;
      expect(Array.from(out.data.subarray(to, to + 5 * 3))).toEqual(
        Array.from(patch.data.subarray(from, from + 5 * 3)),
      );
    }

    // Every byte outside the placed rows/columns stays zero.
    let nonZero = 0;
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 20; x += 1) {
        const inside = x >= 4 && x < 9 && y >= 3 && y < 5;
        if (inside) continue;
        const at = (y * 20 + x) * 3;
        nonZero += out.data.subarray(at, at + 3).some((v) => v !== 0) ? 1 : 0;
      }
    }
    expect(nonZero).toBe(0);
  });

  it('preserves the A channel of an RGBA patch byte for byte', () => {
    const patch = makePatch(5, 2, 4);
    const out = reconstructImage(patch, placement);
    expect(out.channels).toBe(4);
    const to = (3 * 20 + 4) * 4;
    expect(out.data[to + 3]).toBe(patch.data[3]);
  });

  it('rejects a patch buffer whose length disagrees with its dimensions', () => {
    const bad: ImageBuffer = { data: new Uint8Array(10), width: 5, height: 2, channels: 3 };
    expect(() => reconstructImage(bad, placement)).toThrow(RangeError);
    expect(() => reconstructImage(bad, placement)).toThrow(/10 bytes, expected 30/);
  });

  it('rejects a patch whose size disagrees with the bbox', () => {
    expect(() => reconstructImage(makePatch(4, 2, 3), placement)).toThrow(
      /patch is 4x2, but bbox is 5x2/,
    );
  });

  it('rejects a bbox that does not fit inside the original image', () => {
    const overflowing = {
      original_size: { width: 6, height: 4 },
      patch: { bbox: { x: 4, y: 3, w: 5, h: 2 } },
    };
    expect(() => reconstructImage(makePatch(5, 2, 3), overflowing)).toThrow(
      /does not fit inside 6x4/,
    );
  });

  it('drives a committed meta.json, and its widened fields hold their unions', () => {
    const committed = asCaseMeta(meta);
    const patch = makePatch(committed.patch.bbox.w, committed.patch.bbox.h, 3);
    const out = reconstructImage(patch, committed);
    expect(out.width).toBe(committed.original_size.width);
    expect(out.height).toBe(committed.original_size.height);
    expect(committed.blend?.watermark_region_in_crop.w).toBe(
      committed.fixture?.logo_size,
    );

    // The unions asCaseMeta had to narrow by hand, checked for real.
    expect(['png', 'jpg']).toContain(committed.input_format);
    expect([3, 4]).toContain(committed.patch.channels);
    expect(['V1', 'V2']).toContain(committed.fixture?.variant);
    for (const tag of committed.eligible_for) {
      expect([
        'force_remove',
        'add_v1',
        'add_v2_ext',
        'detection',
        'default_e2e',
        'forced_size',
      ]).toContain(tag);
    }
  });
});
