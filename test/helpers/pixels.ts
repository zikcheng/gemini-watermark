/**
 * Pixel comparisons for the detection suites.
 *
 * Both live here rather than as `toEqual` on the buffers: a deep-equality
 * assertion over a 2752x1536x3 image takes tens of seconds and, when it
 * fails, prints a diff no one can read. A linear scan answers the same
 * question in milliseconds and reports the one number that helps — where.
 */
import type { ImageBuffer } from '../../src/types.js';

/**
 * Index of the first differing byte, or -1 when the two are identical.
 *
 * The safety property `processImage` promises on a skip is byte identity,
 * so this is the assertion that property deserves.
 */
export function firstDifference(
  actual: Uint8Array | Uint8ClampedArray,
  expected: Uint8Array | Uint8ClampedArray,
): number {
  if (actual.length !== expected.length) return Math.min(actual.length, expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    if (actual[i] !== expected[i]) return i;
  }
  return -1;
}

export interface RegionDiff {
  /** Largest per-channel deviation inside the rectangle. */
  insideMax: number;
  /** Channels outside it that differ at all. */
  outsideDiffering: number;
}

/**
 * Split the difference between two images by a rectangle.
 *
 * CLAUDE.md's pixel budget is asymmetric on purpose: inside the watermark
 * region the port may differ by 1 (float width against the reference's
 * float32, DEVIATIONS D4), outside it must not differ at all — a single
 * byte there means the region arithmetic wrote where it should not have.
 * Only the colour channels are compared; an RGBA buffer's A channel is
 * never touched by either side.
 */
export function compareRegion(
  actual: ImageBuffer,
  expected: ImageBuffer,
  region: { x: number; y: number; width: number; height: number },
): RegionDiff {
  let insideMax = 0;
  let outsideDiffering = 0;
  const { width, height, channels } = actual;
  for (let y = 0; y < height; y += 1) {
    const insideRow = y >= region.y && y < region.y + region.height;
    for (let x = 0; x < width; x += 1) {
      const inside = insideRow && x >= region.x && x < region.x + region.width;
      const offset = (y * width + x) * channels;
      for (let c = 0; c < 3; c += 1) {
        const delta = Math.abs((actual.data[offset + c] ?? 0) - (expected.data[offset + c] ?? 0));
        if (inside) {
          if (delta > insideMax) insideMax = delta;
        } else if (delta !== 0) {
          outsideDiffering += 1;
        }
      }
    }
  }
  return { insideMax, outsideDiffering };
}
