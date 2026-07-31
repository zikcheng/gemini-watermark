/**
 * RGBA buffers, synthesized — because the reference kit has none.
 *
 * `docs/api-contract.md` promises that the alpha channel of an RGBA buffer
 * "is never read and never written; it passes through byte for byte". That
 * is two claims, and neither can be tested with the committed data: every
 * kit image is 8-bit truecolour RGB, since the reference binary reads
 * through `cv::imread(..., IMREAD_COLOR)` and has no alpha to record.
 *
 * So the A channel is manufactured here rather than measured. That is sound
 * for this particular promise, because the oracle is not the A values —
 * it is the *relationship* between an RGB run and an RGBA run of the same
 * pixels: the colour channels must come out identical (nothing was read
 * from A) and the A bytes must come out untouched (nothing was written to
 * it). Both hold for any A pattern, so an invented one costs nothing.
 *
 * The pattern is deliberately not constant. A uniform fill would survive
 * being overwritten with the same value, and a zero fill would survive
 * being overwritten by anything that happened to write zeros.
 */
import type { ImageBuffer } from '../../src/types.js';

/**
 * The A value planted at a given pixel index.
 *
 * Varies per pixel and takes both endpoints, so a write anywhere in the
 * range is visible. Coprime with 3 and 4 so it cannot align with a channel
 * stride and hide a one-channel-off bug.
 */
export function plantedAlpha(pixelIndex: number): number {
  return (pixelIndex * 7 + 13) % 256;
}

/** Widen an RGB buffer to RGBA, planting a varying alpha channel. */
export function toRgba(image: ImageBuffer): ImageBuffer {
  if (image.channels !== 3) {
    throw new RangeError(`image.channels is ${image.channels}, expected 3 (RGB)`);
  }
  const pixels = image.width * image.height;
  const data = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i += 1) {
    data[i * 4] = image.data[i * 3] ?? 0;
    data[i * 4 + 1] = image.data[i * 3 + 1] ?? 0;
    data[i * 4 + 2] = image.data[i * 3 + 2] ?? 0;
    data[i * 4 + 3] = plantedAlpha(i);
  }
  return { data, width: image.width, height: image.height, channels: 4 };
}

/** The colour channels of an RGBA buffer, as an RGB buffer. */
export function dropAlpha(image: ImageBuffer): ImageBuffer {
  if (image.channels !== 4) {
    throw new RangeError(`image.channels is ${image.channels}, expected 4 (RGBA)`);
  }
  const pixels = image.width * image.height;
  const data = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    data[i * 3] = image.data[i * 4] ?? 0;
    data[i * 3 + 1] = image.data[i * 4 + 1] ?? 0;
    data[i * 3 + 2] = image.data[i * 4 + 2] ?? 0;
  }
  return { data, width: image.width, height: image.height, channels: 3 };
}

/**
 * Index of the first A byte that moved, or -1.
 *
 * Compares against {@link plantedAlpha} rather than against a saved copy,
 * so the expectation cannot drift with the buffer it is checking.
 */
export function firstDisturbedAlpha(image: ImageBuffer): number {
  if (image.channels !== 4) {
    throw new RangeError(`image.channels is ${image.channels}, expected 4 (RGBA)`);
  }
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i += 1) {
    if (image.data[i * 4 + 3] !== plantedAlpha(i)) return i;
  }
  return -1;
}
