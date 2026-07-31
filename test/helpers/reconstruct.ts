/**
 * Rebuild a full-size image from a committed detection patch.
 *
 * The committed test data holds only the pixels the engine touches, but a
 * bare crop must never be handed to the engine as an image: every geometry
 * decision (size class, margin, logo size, position) is inferred from the
 * image dimensions, so a 115x151 crop of a 1024x572 image would be
 * analysed as a 115x151 image and land nowhere near the watermark. Tests
 * therefore rebuild a zero-filled buffer of the original size and place the
 * patch back at its recorded origin — the "patch + reconstruction" data
 * format.
 *
 * The zero fill is deliberate: pixels outside the patch are not part of any
 * oracle, and leaving them black makes an accidental dependency on them
 * show up as an obvious failure rather than a subtle one.
 *
 * Decoding is out of scope here — callers supply already-decoded pixels,
 * so this helper stays free of any PNG/JPEG dependency.
 */
import type { ImageBuffer, Point, WatermarkVariant } from '../../src/types.js';

/** A crop rectangle in original-image coordinates. */
export interface PatchBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** Which downstream suite consumes a case (manifest `eligible_for`). */
export type EligibleTag =
  | 'force_remove'
  | 'add_v1'
  | 'add_v2_ext'
  | 'detection'
  | 'default_e2e'
  | 'forced_size';

/** One emitted image, with the identity of its decoded pixels. */
export interface PatchFileEntry {
  file: string;
  decoded_pixel_sha256: string;
}

/**
 * Roles present depend on the case: `golden_default` only when the default
 * run processed the image (a skipped case has none), `original` only when
 * the kit has ground truth, `golden_forced_size` only for forced-size cases.
 */
export type PatchRole =
  | 'watermarked'
  | 'original'
  | 'golden_default'
  | 'golden_force'
  | 'golden_forced_size';

export type BlendRole = 'watermarked' | 'original' | 'golden_force';

export interface PatchInfo {
  bbox: PatchBbox;
  channels: 3 | 4;
  files: Partial<Record<PatchRole, PatchFileEntry>>;
}

export interface BlendInfo {
  bbox: PatchBbox;
  /** The watermark region in crop coordinates, for region-math calls. */
  watermark_region_in_crop: PatchBbox;
  files: Partial<Record<BlendRole, PatchFileEntry>>;
}

export interface CaseFixture {
  variant: WatermarkVariant;
  margin: number;
  logo_size: number;
  position: Point;
}

/** The shape of `test/data/cases/<name>/meta.json`. */
export interface CaseMeta {
  name: string;
  original_size: ImageSize;
  input_format: 'png' | 'jpg';
  eligible_for: EligibleTag[];
  /** Null for negatives (clean images carry no watermark geometry). */
  fixture: CaseFixture | null;
  patch: PatchInfo;
  /** Null when the case has no watermark region to crop. */
  blend: BlendInfo | null;
}

/** The minimum a caller must supply; a full {@link CaseMeta} satisfies it. */
export interface ReconstructMeta {
  original_size: ImageSize;
  patch: { bbox: PatchBbox };
}

/**
 * Place `patch` into a zero-filled buffer of the original image size.
 *
 * @param patch decoded patch pixels, matching `meta.patch.bbox` exactly
 * @param meta the case's `meta.json` (or any object with the same shape)
 * @throws RangeError when the buffer shape, the patch size, or the bbox
 *   placement disagrees with the metadata
 */
export function reconstructImage(patch: ImageBuffer, meta: ReconstructMeta): ImageBuffer {
  const { width, height } = meta.original_size;
  const { bbox } = meta.patch;
  const { channels } = patch;

  const expectedPatchBytes = patch.width * patch.height * channels;
  if (patch.data.length !== expectedPatchBytes) {
    throw new RangeError(
      `patch buffer is ${patch.data.length} bytes, expected ${expectedPatchBytes} ` +
        `(${patch.width}x${patch.height}x${channels})`,
    );
  }
  if (patch.width !== bbox.w || patch.height !== bbox.h) {
    throw new RangeError(
      `patch is ${patch.width}x${patch.height}, but bbox is ${bbox.w}x${bbox.h}`,
    );
  }
  if (
    bbox.x < 0 ||
    bbox.y < 0 ||
    bbox.x + bbox.w > width ||
    bbox.y + bbox.h > height
  ) {
    throw new RangeError(
      `bbox ${bbox.w}x${bbox.h} at (${bbox.x}, ${bbox.y}) does not fit inside ` +
        `${width}x${height}`,
    );
  }

  const data = new Uint8Array(width * height * channels);
  const rowBytes = bbox.w * channels;
  // Row-wise copy: subarray/set keeps the checker satisfied under
  // noUncheckedIndexedAccess without per-pixel indexing.
  for (let row = 0; row < bbox.h; row += 1) {
    const from = row * rowBytes;
    const to = ((bbox.y + row) * width + bbox.x) * channels;
    data.set(patch.data.subarray(from, from + rowBytes), to);
  }

  return { data, width, height, channels };
}
