/**
 * The full pipeline: detect, decide, and only then touch pixels.
 *
 * Ported from GeminiWatermarkTool `src/cli/cli_app.cpp` (`process_single`,
 * the V2→V1 fallback) and `src/core/watermark_engine.cpp`
 * (`process_image`'s threshold gate, `remove_watermark`, `add_watermark`),
 * Copyright (c) 2025 Allen Kuo (allenk), MIT License.
 *
 * The shape of the thing: try the current profile, fall back to the legacy
 * one if it finds nothing, and modify the image only once something has
 * cleared the caller's threshold. Everything subtle here is about *not*
 * modifying an image — which is why the skip paths get as much attention
 * as the removal path.
 *
 * The file is `pipeline.ts` and not the name its main export suggests
 * because `tools/check-imports.mjs` scans `src/` textually for Node's
 * global of that name followed by a dot — and a relative import specifier
 * ending in that word reads as exactly that. The scanner is deliberately
 * dumb, and its allowlist is meant to stay empty, so the file moved instead
 * of the rule.
 *
 * See `docs/api-contract.md` for the promises this makes.
 */
import { removeWatermarkRegion, addWatermarkRegion } from './blend.js';
import { detectWatermark } from './detect.js';
import { effectiveAlphaMap } from './effective-alpha.js';
import { passesThreshold } from './gating.js';
import { getWatermarkConfig, getWatermarkSize, getWatermarkTopLeft } from './position.js';
import { assertImageBuffer, assertSize, assertVariant } from './validate.js';
import type {
  DetectOptions,
  DetectionResult,
  ImageBuffer,
  ProcessOptions,
  ProcessResult,
  WatermarkPosition,
  WatermarkSize,
  WatermarkVariant,
} from './types.js';

/** Upstream's default gate (`--threshold`, cli_app.cpp). */
const DEFAULT_THRESHOLD = 0.25;

/**
 * Geometry `add_watermark` uses, which is **not** `getWatermarkConfig`.
 *
 * Two differences from the removal path, both faithful: the config comes
 * from the resolved size rather than the image dimensions (so a forced
 * size moves the position too, where on the removal path it does not),
 * and only the V1 profile exists — upstream's add has no V2 branch.
 */
function addConfig(size: WatermarkSize): WatermarkPosition {
  return size === 'small'
    ? { marginRight: 32, marginBottom: 32, logoSize: 48 }
    : { marginRight: 64, marginBottom: 64, logoSize: 96 };
}

const MODES: readonly NonNullable<ProcessOptions['mode']>[] = ['remove', 'add'];

/**
 * Build the detector options.
 *
 * A helper only because `exactOptionalPropertyTypes` forbids handing over an
 * explicit `undefined` for an optional field — the key has to be absent, not
 * present and empty, and that distinction is not worth restating at each
 * call site.
 */
function detectOptions(
  variant: WatermarkVariant,
  size: WatermarkSize | undefined,
): DetectOptions {
  return size === undefined ? { variant } : { variant, size };
}

/**
 * Which of several skipped attempts is the one to report.
 *
 * The highest-scoring one, so a near miss is not masked by a hopeless retry
 * — showing 1% when the V2 attempt scored 20% is the failure upstream's own
 * comment calls out.
 *
 * **On an exact tie the later attempt wins.** Upstream replaces its reported
 * attempt only on a strict improvement (`current_attempt.confidence >
 * proc_result.confidence`, cli_app.cpp:293), and the value it starts from is
 * the V1 retry rather than the V2 try — so equality keeps V1. Scanning
 * forward with `>=` is the same rule read in the other direction, which is
 * why this is a named function with its own tests instead of an expression
 * inside the pipeline: the call site cannot distinguish the two, since the
 * argument order there always makes one of them look right.
 *
 * @throws RangeError when there is nothing to report
 */
export function reportedAttempt(attempts: readonly DetectionResult[]): DetectionResult {
  let reported = attempts[0];
  if (reported === undefined) {
    throw new RangeError('attempts is empty, expected at least one detection to report');
  }
  for (const attempt of attempts) {
    if (attempt.confidence >= reported.confidence) reported = attempt;
  }
  return reported;
}

/**
 * Erase the watermark, re-detecting first to place it.
 *
 * The second detection is upstream's, not an accident: `remove_watermark`
 * runs `detect_one_variant` again and blends at *that* region, so the V2
 * small snap applies to removal as well as to the gate. It is why a
 * forced run still refines its position, and why this pass is excluded
 * from `attempts` — it is part of removing, not of deciding.
 */
function eraseAt(
  image: ImageBuffer,
  variant: WatermarkVariant,
  size: WatermarkSize | undefined,
  logoValue: number,
): DetectionResult {
  const placement = detectWatermark(image, detectOptions(variant, size));
  const template = effectiveAlphaMap(variant, image.width, image.height, placement.size);
  removeWatermarkRegion(
    image,
    template.alpha,
    template.w,
    template.h,
    { x: placement.region.x, y: placement.region.y },
    logoValue,
  );
  return placement;
}

/**
 * Detect and remove, or composite a watermark on.
 *
 * The image is modified **in place**; the returned object carries metadata,
 * not pixels. On `'skipped'` not one byte of it has changed.
 *
 * @throws TypeError when `image` is not an object
 * @throws RangeError when the buffer shape, channels or dimensions are
 *   invalid, or an option carries a value outside its union
 */
export function processImage(image: ImageBuffer, options: ProcessOptions = {}): ProcessResult {
  assertImageBuffer(image);
  assertVariant(options.variant, 'options.variant');
  assertSize(options.size, 'options.size');

  const mode = options.mode ?? 'remove';
  if (!MODES.includes(mode)) {
    throw new RangeError(`options.mode is ${JSON.stringify(mode)}, expected 'remove' or 'add'`);
  }
  const logoValue = options.logoValue ?? 255;
  const size = options.size;

  if (mode === 'add') {
    // No gate, no fallback, no attempts: upstream's add is unconditional.
    const variant: WatermarkVariant = options.variant ?? 'V1';
    const resolved = size ?? getWatermarkSize(image.width, image.height);

    // V1 reproduces `add_watermark`. V2 has no upstream counterpart and is
    // the documented extension — it uses the V2 profile's own geometry,
    // which is what the reference binary's remove inverts (M2 verified the
    // round trip).
    const config =
      variant === 'V1'
        ? addConfig(resolved)
        : getWatermarkConfig(image.width, image.height, variant);
    const position = getWatermarkTopLeft(config, image.width, image.height);
    const template = effectiveAlphaMap(variant, image.width, image.height, resolved);
    addWatermarkRegion(image, template.alpha, template.w, template.h, position, logoValue);

    return {
      status: 'processed',
      confidence: 0,
      variant,
      size: resolved,
      region: { x: position.x, y: position.y, width: template.w, height: template.h },
      attempts: [],
    };
  }

  if (options.force === true) {
    // The gate is off, so `threshold` is ignored rather than rejected, and
    // there is no skip to trigger a fallback. The internal snap detection
    // still runs.
    const variant: WatermarkVariant = options.variant ?? 'V2';
    const placement = eraseAt(image, variant, size, logoValue);
    return {
      status: 'processed',
      confidence: 0,
      variant,
      size: placement.size,
      region: placement.region,
      attempts: [],
    };
  }

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  // Upstream pins V2 and enables the retry only when neither --legacy nor
  // --no-legacy was given; naming a variant here is the same as passing
  // one of those flags.
  const order: WatermarkVariant[] =
    options.variant !== undefined
      ? [options.variant]
      : (options.autoFallback ?? true)
        ? ['V2', 'V1']
        : ['V2'];

  const attempts: DetectionResult[] = [];
  for (const variant of order) {
    const attempt = detectWatermark(image, detectOptions(variant, size));
    attempts.push(attempt);

    if (passesThreshold(attempt.confidence, threshold)) {
      const placement = eraseAt(image, variant, size, logoValue);
      return {
        status: 'processed',
        confidence: attempt.confidence,
        variant,
        size: placement.size,
        region: placement.region,
        attempts,
      };
    }
  }

  // Every attempt skipped. `order` is never empty, so neither is `attempts`.
  const reported = reportedAttempt(attempts);

  return {
    status: 'skipped',
    confidence: reported.confidence,
    attempts,
  };
}
