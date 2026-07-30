/**
 * The input checks `docs/api-contract.md` promises, in one place.
 *
 * The contract's error table is a promise made once and owed by every
 * public entry point, so the checks live here rather than being restated
 * per module — two copies of "expected 3 (RGB) or 4 (RGBA)" are two
 * messages that can drift apart, and a caller who hits the second one
 * learns something slightly different about the same mistake.
 *
 * Nothing here is exported from `src/index.ts`. Every message names the
 * actual value before the expected one, in that order, because the actual
 * value is what the caller has to go looking for.
 */
import type { ImageBuffer, WatermarkSize, WatermarkVariant } from './types.js';

const VARIANTS: readonly WatermarkVariant[] = ['V1', 'V2'];
const SIZES: readonly WatermarkSize[] = ['small', 'large'];

/**
 * Check a pixel buffer's shape before anything reads from it.
 *
 * @throws TypeError when `image` is not an object
 * @throws RangeError when the channel count, dimensions, or buffer length
 *   disagree with each other
 */
export function assertImageBuffer(image: ImageBuffer): void {
  if (typeof image !== 'object' || image === null) {
    throw new TypeError(`image is ${image === null ? 'null' : typeof image}, expected an ImageBuffer`);
  }
  if (image.channels !== 3 && image.channels !== 4) {
    throw new RangeError(
      `image.channels is ${String(image.channels)}, expected 3 (RGB) or 4 (RGBA)`,
    );
  }
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1
  ) {
    throw new RangeError(
      `image dimensions must be positive integers, got ${image.width}x${image.height}`,
    );
  }
  const expected = image.width * image.height * image.channels;
  if (image.data.length !== expected) {
    throw new RangeError(
      `image.data holds ${image.data.length} bytes, expected ${expected} ` +
        `(${image.width}x${image.height}x${image.channels})`,
    );
  }
}

/**
 * Reject an unknown variant rather than silently treating it as V2.
 *
 * The type system already covers TypeScript callers; this is for the
 * JavaScript ones, where a typo would otherwise pick a default and process
 * the image under the wrong profile.
 */
export function assertVariant(value: WatermarkVariant | undefined, field: string): void {
  if (value !== undefined && !VARIANTS.includes(value)) {
    throw new RangeError(`${field} is ${JSON.stringify(value)}, expected 'V1' or 'V2'`);
  }
}

/** Same, for the size class. */
export function assertSize(value: WatermarkSize | undefined, field: string): void {
  if (value !== undefined && !SIZES.includes(value)) {
    throw new RangeError(`${field} is ${JSON.stringify(value)}, expected 'small' or 'large'`);
  }
}
