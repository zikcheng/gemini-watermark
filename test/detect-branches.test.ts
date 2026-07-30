/**
 * Branch coverage matrix for the detector and the orchestration around it.
 *
 * The manifest suite proves the port agrees with the reference binary on
 * the fourteen cases the binary was run against. That is the equivalence
 * bar, but it is not coverage: several branches are either not reached by
 * any fixture, or reached in a way that cannot tell a right implementation
 * from a wrong one. This file names every branch and pins at least one case
 * per row.
 *
 * | Branch | Case | Oracle |
 * |---|---|---|
 * | V2 passes directly, no fallback | `v2-large-2752x1536` | manifest |
 * | V2 skips → V1 passes | `v1-small-800x600`, `v1-large-1500x1200` | manifest |
 * | Both skip, the V2 attempt scored higher | `clean-800x600` | manifest |
 * | Both skip, the V1 retry scored higher | `clean-2752x1536` | manifest |
 * | Both skip on an exact tie | `clean-1024x572` | manifest |
 * | Circuit breaker fires | `clean-*`, the V2 gate on the V1 fixtures | manifest |
 * | Circuit breaker withheld just above the line | `v2-large-2752x1536-hard` (spatial 0.265) | manifest |
 * | Rescue fires, fusion below the 0.35 label | `v2-small-1024x572`, `v2-small-1376x768` | manifest + fusion arithmetic |
 * | Rescue withheld (spatial below 0.30) | `v2-large-2752x1536-hard` | manifest + fusion arithmetic |
 * | Stage 3 gate at `ref_h > 8`, at 8 / 9 / 10 | synthetic 200x88, 200x89, 200x90 | behaviour |
 * | Stage 3 skipped, reference strip too short | synthetic 60x60 | behaviour |
 * | Stage 3 scores under a forced size | synthetic 800x600 forced large | behaviour |
 * | Reference strip height comes from the config, not the template | synthetic 800x600 forced large, two noise bands | behaviour (relational) |
 * | Snap adopts a real offset | synthetic 1024x572, watermark 1px off | behaviour |
 * | Snap rejected, formula position stands | synthetic 1024x572, noisy background | behaviour |
 * | ROI clamped left and top | synthetic 60x60 | behaviour |
 * | ROI clamped on all four edges | synthetic 36x36 | behaviour |
 * | ROI entirely outside the image | synthetic 32x32 | behaviour |
 * | ROI clamped right and bottom | synthetic 800x600 forced large | behaviour |
 * | Forced size, all three golden runs | manifest `forced_size` | manifest + committed golden pixels |
 *
 * **Which rows get a number and which get a property.** A row backed by the
 * manifest asserts the binary's own scores. A row marked *behaviour* has no
 * reference value — no fixture in the kit reaches it, so there is nothing to
 * compare against — and inventing one would be worse than useless, since the
 * invented number would then be the thing under test. Those rows instead
 * assert a property that follows from the upstream source: a strip shorter
 * than 9 rows means stage 3 never runs; a spatial score under 0.60 means the
 * formula position stands; an ROI with no overlap returns zeros. Each says
 * which line of `watermark_engine.cpp` it is reading.
 *
 * The snap rows are the weakest of those, and DEVIATIONS D7 says why: they
 * pin the port against this repository's reading of the sweep rather than
 * against a measurement, because no fixture displaces its watermark. A kit
 * fixture that did would turn them into equivalence rows — recorded there as
 * the one piece of incremental kit work M4 found worth doing, deferred to M7.
 *
 * **Every row was checked by injection.** A coverage matrix that cannot fail
 * is decoration, so each row above was confirmed by breaking the thing it
 * claims to guard — swapping the strip height for the template's, moving a
 * threshold, narrowing the snap pad, dropping the out-of-bounds return — and
 * checking that the row, and only that row, went red.
 *
 * **No kit fixture was added.** `tools/reference/gen_golden.py` aborts on any
 * `Detection:` line whose shape it does not recognise, rather than skipping
 * it — a dropped attempt would be indistinguishable in the manifest from one
 * that never ran. "Detection: ROI out of bounds" is one of the shapes that
 * guard would catch, and its comment asks that the regex for it be added
 * together with the first fixture that triggers it, so that the manifest
 * representation is decided against real data. No such fixture exists here:
 * the out-of-bounds branch is covered by a synthetic image instead, the
 * binary is never asked to log the line, and the guard is untouched.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSourceAlphaMap } from '../src/alpha-maps.js';
import { addWatermarkRegion } from '../src/blend.js';
import { detectWatermark } from '../src/detect.js';
import { effectiveAlphaMap } from '../src/effective-alpha.js';
import { fuseConfidence } from '../src/gating.js';
import { processImage } from '../src/pipeline.js';
import { getWatermarkConfig, getWatermarkTopLeft } from '../src/position.js';
import type {
  DetectionResult,
  ImageBuffer,
  WatermarkSize,
  WatermarkVariant,
} from '../src/types.js';
import {
  detectionCases,
  expectScoreMatches,
  splitDetections,
  type ManifestCase,
} from './helpers/manifest.js';
import { compareRegion, firstDifference } from './helpers/pixels.js';
import { decodePng } from './helpers/png.js';
import { reconstructImage, type CaseMeta } from './helpers/reconstruct.js';

const CASES_DIR = join(import.meta.dirname, 'data', 'cases');

const readMeta = (name: string): CaseMeta =>
  JSON.parse(readFileSync(join(CASES_DIR, name, 'meta.json'), 'utf8')) as CaseMeta;

function rebuild(name: string, role: 'watermarked' | 'golden-forced-size'): ImageBuffer {
  const meta = readMeta(name);
  const file = role === 'watermarked' ? 'patch-watermarked.png' : 'patch-golden-forced-size.png';
  return reconstructImage(
    decodePng(new Uint8Array(readFileSync(join(CASES_DIR, name, file)))),
    meta,
  );
}

const cases = detectionCases();
const findCase = (name: string): ManifestCase => {
  const entry = cases.find((c) => c.name === name);
  if (entry === undefined) throw new Error(`no manifest case named ${name}`);
  return entry;
};

// —— Synthetic image builders ——————————————————————————————————————————

/**
 * A deterministic, mildly textured background.
 *
 * Flat fill would be worse than useless for the ROI rows: a clamping
 * mistake that read the wrong pixels would read the *same* value and score
 * identically, so the test would pass either way. The pattern is coprime in
 * both axes so no row or column repeats within a template.
 */
function textured(width: number, height: number): ImageBuffer {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = 40 + ((x * 3) % 11) + ((y * 5) % 7);
      const offset = (y * width + x) * 3;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
    }
  }
  return { data, width, height, channels: 3 };
}

/** Flat fill, for the cases that must stay degenerate on purpose. */
function flat(width: number, height: number, value: number): ImageBuffer {
  return {
    data: new Uint8Array(width * height * 3).fill(value),
    width,
    height,
    channels: 3,
  };
}

/**
 * Uniform grey with pseudo-random noise, strong enough to pull the spatial
 * correlation below a chosen gate. The generator is a fixed-seed LCG so the
 * image — and therefore every score computed from it — is identical on
 * every machine and every run.
 */
function noisy(width: number, height: number, amplitude: number): ImageBuffer {
  const image = flat(width, height, 120);
  let seed = 12345;
  for (let i = 0; i < image.data.length; i += 3) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const value = 120 + ((seed >> 8) % amplitude) - amplitude / 2;
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
  }
  return image;
}

/** Where the formula puts the watermark, and how big the template is. */
function placement(
  width: number,
  height: number,
  variant: WatermarkVariant,
  size?: WatermarkSize,
): { x: number; y: number; edge: number; logoSize: number } {
  const config = getWatermarkConfig(width, height, variant);
  const { x, y } = getWatermarkTopLeft(config, width, height);
  const template = effectiveAlphaMap(variant, width, height, size);
  return { x, y, edge: template.w, logoSize: config.logoSize };
}

// —— Orchestration branches ————————————————————————————————————————————

describe('which variants run, and which result is reported', () => {
  it('V2 passing directly means no fallback attempt at all', () => {
    const result = processImage(rebuild('v2-large-2752x1536', 'watermarked'));
    expect(result.status).toBe('processed');
    expect(result.attempts.map((a) => a.variant)).toEqual(['V2']);
    expect(result.variant).toBe('V2');
  });

  it.each(['v1-small-800x600', 'v1-large-1500x1200'])(
    '%s reaches V1 only through the fallback',
    (name) => {
      const result = processImage(rebuild(name, 'watermarked'));
      expect(result.status).toBe('processed');
      expect(result.attempts.map((a) => a.variant)).toEqual(['V2', 'V1']);
      // The V2 attempt has to have genuinely failed the gate, or the retry
      // would never have been the reason V1 ran.
      const [v2, v1] = result.attempts as [DetectionResult, DetectionResult];
      expect(v2.confidence).toBeLessThan(0.25);
      expect(v1.confidence).toBeGreaterThanOrEqual(0.25);
      expect(result.variant).toBe('V1');
    },
  );

  it.each([
    ['clean-800x600', 0],
    ['clean-2752x1536', 1],
  ])('%s reports attempt %i, the higher-scoring one', (name, winner) => {
    const result = processImage(rebuild(name, 'watermarked'));
    expect(result.status).toBe('skipped');
    expect(result.attempts.map((a) => a.variant)).toEqual(['V2', 'V1']);

    const [v2, v1] = result.attempts as [DetectionResult, DetectionResult];
    const [high, low] = winner === 0 ? [v2, v1] : [v1, v2];
    // Strictly higher, so the case genuinely exercises the comparison
    // rather than the tie rule.
    expect(high.confidence).toBeGreaterThan(low.confidence);
    expect(result.confidence).toBe(high.confidence);
  });

  it('reports the later attempt when the two tie exactly', () => {
    const result = processImage(rebuild('clean-1024x572', 'watermarked'));
    expect(result.status).toBe('skipped');
    expect(result.attempts.map((a) => a.confidence)).toEqual([0, 0]);
    expect(result.attempts.at(-1)?.variant).toBe('V1');
  });
});

// —— Stage branches ————————————————————————————————————————————————————

describe('the circuit breaker', () => {
  it('fires below 0.25 and leaves stages 2 and 3 unmeasured', () => {
    // watermark_engine.cpp:452 — the breaker returns spatial * 0.5 without
    // clamping, so the confidence here is negative.
    const detection = detectWatermark(rebuild('clean-2752x1536', 'watermarked'));
    expect(detection.circuitBreaker).toBe(true);
    expect(detection.scores.spatial).toBeLessThan(0.25);
    expect(detection.scores.gradient).toBe(0);
    expect(detection.scores.variance).toBe(0);
    expect(detection.confidence).toBe(detection.scores.spatial * 0.5);
    expect(detection.confidence).toBeLessThan(0);
  });

  it('is withheld just above the line, and all three stages run', () => {
    // `v2-large-2752x1536-hard` is the only fixture that clears the breaker
    // without clearing the gate: spatial 0.265 is 0.015 above the constant.
    const detection = detectWatermark(rebuild('v2-large-2752x1536-hard', 'watermarked'));
    expect(detection.circuitBreaker).toBe(false);
    expect(detection.scores.spatial).toBeGreaterThan(0.25);
    expect(detection.scores.spatial).toBeLessThan(0.3);
    expect(detection.scores.gradient).toBeGreaterThan(0);
    expect(detection.scores.variance).toBeGreaterThan(0);
  });
});

describe('the spatial rescue', () => {
  /**
   * The rescue is invisible in a score on its own — it only shows as the
   * gap between the weighted fusion and the reported confidence. So each
   * case recomputes the fusion from the binary's own three stage scores and
   * checks that the manifest confidence can only be explained one way.
   */
  it.each([
    ['v2-small-1024x572', 0.327],
    ['v2-small-1376x768', 0.324],
  ])('%s is carried by the rescue, with the fusion far below the 0.35 label', (name, expected) => {
    const detection = splitDetections(findCase(name)).gates.at(-1);
    expect(detection).toBeDefined();
    const { spatial, gradient = 0, variance = 0 } = detection as {
      spatial: number;
      gradient?: number;
      variance?: number;
    };

    const fused = spatial * 0.5 + gradient * 0.3 + variance * 0.2;
    expect(spatial, 'clears the rescue threshold').toBeGreaterThanOrEqual(0.3);
    expect(fused, 'the weighted fusion alone would not even reach the label').toBeLessThan(0.35);
    // Which is what makes this row worth having: without the rescue the
    // confidence would be the fusion, and the case would fall under the
    // default 0.25 gate and skip.
    expect(fused).toBeLessThan(0.25);
    expect(fuseConfidence(spatial, gradient, variance)).toBe(spatial);
    // The literal in the table is the manifest's own confidence, asserted
    // rather than trusted so the two cannot drift apart silently.
    expect(detection?.confidence).toBe(expected);
    expectScoreMatches(fuseConfidence(spatial, gradient, variance), expected, `${name} rescued`);
  });

  it('is withheld below 0.30, leaving the fusion to stand', () => {
    const detection = splitDetections(findCase('v2-large-2752x1536-hard')).gates[0];
    expect(detection).toBeDefined();
    const { spatial, gradient = 0, variance = 0 } = detection as {
      spatial: number;
      gradient?: number;
      variance?: number;
    };

    expect(spatial, 'below the rescue threshold').toBeLessThan(0.3);
    const fused = spatial * 0.5 + gradient * 0.3 + variance * 0.2;
    // Exact, not approximate: with the rescue withheld and the sum inside
    // [0, 1] the clamp is a no-op, so `fuseConfidence` evaluates the same
    // expression in the same order and must return the same double.
    expect(fuseConfidence(spatial, gradient, variance)).toBe(fused);
    // The reported confidence is the fusion, not the (higher) spatial score.
    expect(fuseConfidence(spatial, gradient, variance)).toBeLessThan(spatial);
    expectScoreMatches(
      fuseConfidence(spatial, gradient, variance),
      detection?.confidence ?? NaN,
      'hard fusion',
    );
  });
});

// —— Stage 3 and the reference strip ——————————————————————————————————

describe('the stage 3 reference strip', () => {
  /**
   * `ref_h = std::min(y1, config.logo_size)`, and stage 3 runs only when
   * that exceeds 8 (watermark_engine.cpp:485-487). Both halves matter, and
   * the second one names `config`, not the template — a distinction nothing
   * in the kit can see, because a forced size is the only way to make the
   * two differ and every forced-size fixture in the manifest either circuit
   * breaks before stage 3 or resolves to a template the same size as the
   * config's logo.
   */
  const width = 800;
  const height = 600;
  const { x, y, logoSize } = placement(width, height, 'V1');

  /**
   * A flat watermark region under a fully noisy strip, sized so that `y1`
   * itself is the binding term in `min(y1, config.logo_size)`.
   *
   * V1 small puts the watermark at `height - 32 - 48`, so the image height
   * chooses `ref_h` directly: 88 gives 8 and 89 gives 9, straddling the
   * `ref_h > 8` gate. The region is flat and the strip is not, so a strip
   * that runs scores well above zero and one that does not scores exactly
   * zero — the two outcomes are not near each other.
   */
  function shortStrip(imageHeight: number): ImageBuffer {
    const image = flat(200, imageHeight, 128);
    const spot = placement(200, imageHeight, 'V1');
    for (let row = 0; row < spot.y; row += 1) {
      for (let col = 0; col < 200; col += 1) {
        const value = (col + row) % 2 === 0 ? 0 : 255;
        const offset = (row * 200 + col) * 3;
        image.data[offset] = value;
        image.data[offset + 1] = value;
        image.data[offset + 2] = value;
      }
    }
    const template = effectiveAlphaMap('V1', 200, imageHeight);
    addWatermarkRegion(image, template.alpha, template.w, template.h, spot);
    return image;
  }

  it.each([
    [88, 8, 'skipped'],
    [89, 9, 'scored'],
    [90, 10, 'scored'],
  ])('a %ipx image gives a %i-row strip, which is %s', (imageHeight, expectedRefHeight) => {
    const spot = placement(200, imageHeight, 'V1');
    expect(Math.min(spot.y, spot.logoSize), 'ref_h').toBe(expectedRefHeight);

    const detection = detectWatermark(shortStrip(imageHeight), { variant: 'V1' });
    expect(detection.circuitBreaker, 'stage 3 was reachable').toBe(false);
    if (expectedRefHeight > 8) {
      expect(detection.scores.variance).toBeGreaterThan(0);
    } else {
      expect(detection.scores.variance).toBe(0);
    }
  });

  it('is skipped when there is no room above the watermark', () => {
    // A 60x60 image puts the formula position at (-20, -20), so y1 clamps
    // to 0 and ref_h = min(0, 48) = 0 — not greater than 8.
    const image = textured(60, 60);
    const template = effectiveAlphaMap('V1', 60, 60);
    const spot = placement(60, 60, 'V1');
    expect(spot.y, 'the formula position is above the top edge').toBeLessThan(0);
    addWatermarkRegion(image, template.alpha, template.w, template.h, spot);

    const detection = detectWatermark(image, { variant: 'V1' });
    expect(detection.circuitBreaker, 'stages 2 and 3 were reached').toBe(false);
    expect(detection.scores.spatial).toBeGreaterThan(0.9);
    expect(detection.scores.variance, 'no strip, no score').toBe(0);
  });

  /**
   * Two images identical except for which 48-row band above the watermark
   * carries the noise. The config's logo is 48px and the forced template is
   * 96px, so a config-derived strip sees exactly one band and a
   * template-derived one would span both — and could not tell them apart.
   */
  function withNoiseBand(band: 'far' | 'near'): ImageBuffer {
    const image = flat(width, height, 128);
    const from = band === 'far' ? y - 96 : y - 48;
    const to = band === 'far' ? y - 48 : y;
    for (let row = from; row < to; row += 1) {
      for (let col = x - 20; col < width; col += 1) {
        const value = (col + row) % 2 === 0 ? 0 : 255;
        const offset = (row * width + col) * 3;
        image.data[offset] = value;
        image.data[offset + 1] = value;
        image.data[offset + 2] = value;
      }
    }
    const source = getSourceAlphaMap('V1', 'large');
    addWatermarkRegion(image, source, 96, 96, { x, y });
    return image;
  }

  const detectBand = (band: 'far' | 'near'): DetectionResult =>
    detectWatermark(withNoiseBand(band), { variant: 'V1', size: 'large' });

  it('reaches stage 3 at all under a forced size', () => {
    // The combination the manifest has no case for: a forced size *and* a
    // spatial score high enough that stage 3 actually gets to score.
    expect(logoSize, 'the config logo and the forced template differ').not.toBe(96);
    for (const band of ['far', 'near'] as const) {
      const detection = detectBand(band);
      expect(detection.circuitBreaker, `${band} reached stage 3`).toBe(false);
      expect(detection.scores.spatial, `${band} spatial`).toBeGreaterThan(0.9);
    }
    expect(detectBand('near').scores.variance, 'stage 3 scored').toBeGreaterThan(0);
  });

  it('takes its height from the config logo, not the forced template', () => {
    const far = detectBand('far');
    const near = detectBand('near');
    // Noise in the far band sits outside a 48-row strip, so the strip is
    // flat, its deviation fails the `s_ref > 5.0` gate, and the score is
    // exactly zero. A 96-row strip would reach the noise and score.
    expect(far.scores.variance).toBe(0);
    // And the two constructions must disagree. This is the assertion that
    // needs no reference number: a template-derived strip spans both bands
    // and therefore returns the *same* score for both images, whatever that
    // score happens to be.
    expect(near.scores.variance).not.toBe(far.scores.variance);
  });
});

// —— The V2 small snap —————————————————————————————————————————————————

describe('the V2 small snap', () => {
  /**
   * Every V2 small fixture in the kit carries its watermark at exactly the
   * formula position, so the sweep always finds offset zero and the trusted
   * and rejected paths return the same rectangle. Only a deliberately
   * displaced watermark can tell them apart.
   */
  const width = 1024;
  const height = 572;
  const formula = placement(width, height, 'V2');

  it.each([
    [1, 1],
    [-2, 3],
    [3, -3],
  ])('adopts an offset of (%i, %i) when the correlation is strong', (dx, dy) => {
    const image = flat(width, height, 120);
    const source = getSourceAlphaMap('V2', 'small');
    addWatermarkRegion(image, source, 36, 36, { x: formula.x + dx, y: formula.y + dy });

    const detection = detectWatermark(image);
    expect(detection.scores.spatial, 'clears the trust gate').toBeGreaterThanOrEqual(0.6);
    expect(detection.region).toEqual({
      x: formula.x + dx,
      y: formula.y + dy,
      width: 36,
      height: 36,
    });
  });

  it('stays inside the ±3px pad and never reaches further', () => {
    // The sweep cannot find a watermark 4px away; it is bounded by the pad,
    // and what it returns instead has to be inside it.
    const image = flat(width, height, 120);
    const source = getSourceAlphaMap('V2', 'small');
    addWatermarkRegion(image, source, 36, 36, { x: formula.x + 4, y: formula.y });

    const detection = detectWatermark(image);
    expect(Math.abs(detection.region.x - formula.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(detection.region.y - formula.y)).toBeLessThanOrEqual(3);
  });

  it('discards the offset when the correlation is too weak to trust', () => {
    // Same 1px displacement, but on a background noisy enough to pull the
    // spatial score under 0.60. The sweep still finds the displaced
    // watermark; the trust gate is what refuses to believe it
    // (watermark_engine.cpp:443-447).
    const image = noisy(width, height, 140);
    const source = getSourceAlphaMap('V2', 'small');
    addWatermarkRegion(image, source, 36, 36, { x: formula.x + 1, y: formula.y + 1 });

    const detection = detectWatermark(image);
    // Asserted, not assumed: if the noise ever stopped being enough, this
    // would fail rather than silently testing the trusted path instead.
    expect(detection.scores.spatial, 'below the trust gate').toBeLessThan(0.6);
    expect(detection.circuitBreaker, 'but well clear of the breaker').toBe(false);
    expect(detection.region).toEqual({ x: formula.x, y: formula.y, width: 36, height: 36 });
  });
});

// —— ROI clamping ——————————————————————————————————————————————————————

describe('the ROI against the image edges', () => {
  it('clamps the left and top edges and crops the template to match', () => {
    // 60x60, V1 small: the formula position is (-20, -20), so the ROI is
    // [0, 28) on both axes and the alpha map is cropped by the same amount
    // (the `alpha_roi` branch, watermark_engine.cpp:420-424).
    const image = textured(60, 60);
    const template = effectiveAlphaMap('V1', 60, 60);
    const spot = placement(60, 60, 'V1');
    expect(spot).toMatchObject({ x: -20, y: -20, edge: 48 });
    addWatermarkRegion(image, template.alpha, template.w, template.h, spot);

    const detection = detectWatermark(image, { variant: 'V1' });
    expect(detection.scores.spatial, 'the cropped template still matches').toBeGreaterThan(0.9);
    // V1 never snaps, so the reported region stays the formula rectangle
    // even though most of it lies outside the image.
    expect(detection.region).toEqual({ x: -20, y: -20, width: 48, height: 48 });
  });

  it('clamps all four edges at once', () => {
    // 36x36, V2 small: margin 2 and logo 36 put the formula position at
    // (-2, -2), and the ±3px pad pushes the far edge to 37 — so both ends
    // of both axes clamp, and the ROI is the whole image.
    const image = textured(36, 36);
    const template = effectiveAlphaMap('V2', 36, 36);
    const spot = placement(36, 36, 'V2');
    expect(spot).toMatchObject({ x: -2, y: -2, edge: 36 });
    expect(spot.x - 3, 'the padded ROI starts left of the image').toBeLessThan(0);
    expect(spot.x + spot.edge + 3, 'and ends right of it').toBeGreaterThan(36);
    addWatermarkRegion(image, template.alpha, template.w, template.h, spot);

    const detection = detectWatermark(image, { variant: 'V2' });
    expect(detection.scores.spatial).toBeGreaterThan(0.6);
    // The ROI is exactly template-sized, so the sweep has one placement and
    // the snapped region is the image's own top-left corner.
    expect(detection.region).toEqual({ x: 0, y: 0, width: 36, height: 36 });
  });

  it('clamps the right and bottom edges under a forced size', () => {
    // 800x600 with a forced large template: 720 + 96 overruns the width and
    // 520 + 96 the height, so the ROI is 80x80 and the alpha is cropped from
    // the far side instead of the near one.
    const image = textured(800, 600);
    const source = getSourceAlphaMap('V1', 'large');
    const spot = placement(800, 600, 'V1');
    expect(spot.x + 96, 'overruns the right edge').toBeGreaterThan(800);
    expect(spot.y + 96, 'overruns the bottom edge').toBeGreaterThan(600);
    addWatermarkRegion(image, source, 96, 96, spot);

    const detection = detectWatermark(image, { variant: 'V1', size: 'large' });
    expect(detection.scores.spatial).toBeGreaterThan(0.9);
    expect(detection.region).toEqual({ x: spot.x, y: spot.y, width: 96, height: 96 });
  });

  it('returns zeros when the ROI lies entirely outside the image', () => {
    // 32x32, V1 small: margin 32 and logo 48 put the formula position at
    // (-48, -48), so x2 lands on 0 and the ROI is empty. Upstream logs
    // "Detection: ROI out of bounds" and returns the zeroed result before
    // stage 1 (watermark_engine.cpp:396-399) — note `circuitBreaker` is
    // false, because the breaker is a stage-1 verdict and stage 1 never ran.
    const image = textured(32, 32);
    const detection = detectWatermark(image, { variant: 'V1' });

    expect(detection.confidence).toBe(0);
    expect(detection.scores).toEqual({ spatial: 0, gradient: 0, variance: 0 });
    expect(detection.circuitBreaker).toBe(false);
    expect(detection.internalDetected).toBe(false);
    expect(detection.region).toEqual({ x: -48, y: -48, width: 48, height: 48 });
  });

  it('leaves the ROI alone when nothing overruns', () => {
    // The control: without a clamp the region is the formula rectangle and
    // the ROI is the padded template, which is what every manifest case does.
    const image = textured(200, 200);
    const template = effectiveAlphaMap('V1', 200, 200);
    const spot = placement(200, 200, 'V1');
    expect(spot).toMatchObject({ x: 120, y: 120 });
    addWatermarkRegion(image, template.alpha, template.w, template.h, spot);

    const detection = detectWatermark(image, { variant: 'V1' });
    expect(detection.scores.spatial).toBeGreaterThan(0.9);
    expect(detection.region).toEqual({ x: 120, y: 120, width: 48, height: 48 });
  });
});

// —— Forced size ———————————————————————————————————————————————————————

/**
 * The three runs the kit recorded with `--force` plus a size override.
 *
 * The behaviour is a quirk and is reproduced as one (DEVIATIONS D3): the
 * override picks the template, while the position still comes from the
 * dimension-derived config, so the two can disagree — and on
 * `v2-large-2752x1536` the override is a no-op, because the config's own
 * logo is already 96px and the interpolation returns the source unchanged.
 */
describe('forced size', () => {
  const runs: Array<[string, WatermarkVariant, WatermarkSize]> = [
    ['v1-small-800x600', 'V1', 'large'],
    ['v2-large-2752x1536', 'V2', 'small'],
    ['v2-small-1024x572', 'V2', 'large'],
  ];
  const executed: string[] = [];

  for (const [name, variant, size] of runs) {
    const entry = findCase(name);
    const run = entry.runs.forced_size;
    executed.push(name);

    it(`${name} --force-${size} reproduces the recorded run`, () => {
      expect(run, `${name} has a forced_size run`).toBeDefined();
      const expected = run?.detections?.[0];
      expect(expected, 'which logged exactly one detection').toBeDefined();
      if (run === undefined || expected === undefined) return;

      const image = rebuild(name, 'watermarked');
      const result = processImage(image, { force: true, variant, size });

      // Forcing bypasses the gate, so nothing is attempted and there is no
      // confidence to report — but the internal snap detection still ran,
      // and its region is where removal happened.
      expect(result.status).toBe('processed');
      expect(result.attempts).toEqual([]);
      expect(result.confidence).toBe(0);
      expect(result.variant).toBe(run.removal_variant);
      expect(result.size).toBe(size);
      expect(run.removal_size, 'the binary recorded the same size').toBe(
        size === 'small' ? 'Small' : 'Large',
      );
      expect({ x: result.region?.x, y: result.region?.y }).toEqual(run.removal_position);
      expect({ width: result.region?.width, height: result.region?.height }).toEqual({
        width: run.alpha_map?.width,
        height: run.alpha_map?.height,
      });

      // The internal detection is the same call on the same unmodified
      // pixels, so its scores are assertable directly.
      const internal = detectWatermark(rebuild(name, 'watermarked'), { variant, size });
      expect(internal.circuitBreaker).toBe(expected.circuit_breaker);
      expectScoreMatches(internal.scores.spatial, expected.spatial, `${name} forced spatial`);
      expectScoreMatches(internal.confidence, expected.confidence, `${name} forced confidence`);

      // And the pixels the binary wrote for this run are committed.
      const golden = rebuild(name, 'golden-forced-size');
      const { insideMax, outsideDiffering } = compareRegion(
        image,
        golden,
        result.region as NonNullable<typeof result.region>,
      );
      expect(outsideDiffering, `${name} changed pixels outside the region`).toBe(0);
      expect(insideMax, `${name} deviation inside the region`).toBeLessThanOrEqual(1);
    });
  }

  it('the size override is a no-op exactly where D3 says it is', () => {
    // `--force-small` on a large V2 image resolves back to the 96px
    // template, so the output is byte-identical to the plain forced run.
    const name = 'v2-large-2752x1536';
    const forcedSmall = rebuild(name, 'watermarked');
    processImage(forcedSmall, { force: true, variant: 'V2', size: 'small' });
    const plain = rebuild(name, 'watermarked');
    processImage(plain, { force: true, variant: 'V2' });
    expect(firstDifference(forcedSmall.data, plain.data)).toBe(-1);

    // Whereas on the other two the override does change the template.
    for (const [other, variant] of [
      ['v1-small-800x600', 'V1'],
      ['v2-small-1024x572', 'V2'],
    ] as const) {
      const overridden = rebuild(other, 'watermarked');
      processImage(overridden, { force: true, variant, size: 'large' });
      const natural = rebuild(other, 'watermarked');
      processImage(natural, { force: true, variant });
      expect(firstDifference(overridden.data, natural.data), other).not.toBe(-1);
    }
  });

  it('covers every forced_size case in the manifest', () => {
    const tagged = cases.filter((c) => c.eligible_for.includes('forced_size')).map((c) => c.name);
    expect(tagged).toHaveLength(3);
    expect(executed.slice().sort()).toEqual(tagged.slice().sort());
  });
});
