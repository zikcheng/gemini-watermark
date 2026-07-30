/**
 * Equivalence against what the reference binary actually did, case by case.
 *
 * This is the milestone's point: the binary's own `-v` log is the oracle,
 * and the port has to reach the same verdicts from the same pixels.
 * Decisions are exact — skip or process, which variant, which region, the
 * position removal happened at. Scores get PLAN.md's 2e-3, which is simply
 * the precision the log was printed at.
 *
 * Images are rebuilt from the committed detection patches, so this runs in
 * CI on a bare checkout. `test/golden/detect-full.test.ts` repeats the same
 * assertions on full-size kit images and adds the pixel comparison.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectWatermark } from '../src/detect.js';
import { processImage, reportedAttempt } from '../src/pipeline.js';
import type { DetectionResult, ImageBuffer } from '../src/types.js';
import {
  detectionCases,
  expectDetectionMatches,
  expectPipelineMatches,
  splitDetections,
  wasProcessed,
  type ManifestCase,
} from './helpers/manifest.js';
import { firstDifference } from './helpers/pixels.js';
import { decodePng } from './helpers/png.js';
import { reconstructImage, type CaseMeta } from './helpers/reconstruct.js';

const CASES_DIR = join(import.meta.dirname, 'data', 'cases');

const cases = detectionCases();

/** Manifest tally, so a shrunk corpus fails instead of passing quietly. */
const EXPECTED_CASES = 14;
const EXPECTED_DETECTIONS = 30;

/**
 * Rebuild the full-size image from the case's committed patch.
 *
 * Never hand the patch itself to the engine: every geometry decision comes
 * from the image dimensions, so a 94x130 crop would be analysed as a
 * 94x130 image (see `helpers/reconstruct.ts`).
 */
function rebuild(name: string): ImageBuffer {
  const meta = JSON.parse(readFileSync(join(CASES_DIR, name, 'meta.json'), 'utf8')) as CaseMeta;
  const patch = decodePng(
    new Uint8Array(readFileSync(join(CASES_DIR, name, 'patch-watermarked.png'))),
  );
  return reconstructImage(patch, meta);
}

/**
 * Every logged detection is a `detect_one_variant` call on the *unmodified*
 * image — removal blends only after detecting, and the V1 retry re-reads
 * the file — so the internal re-detection is as assertable as the gate
 * attempts, and only it carries the post-snap region in the log.
 */
describe('detectWatermark vs every detection the binary logged', () => {
  let asserted = 0;

  for (const entry of cases) {
    const { all } = splitDetections(entry);

    it(`${entry.name} reproduces all ${all.length} detections`, () => {
      const image = rebuild(entry.name);
      for (const [index, expected] of all.entries()) {
        const actual = detectWatermark(image, { variant: expected.variant });
        expectDetectionMatches(actual, expected, `${entry.name} detection ${index}`);
        asserted += 1;
      }
    });
  }

  it('covered every detection-eligible case and every logged detection', () => {
    expect(cases).toHaveLength(EXPECTED_CASES);
    expect(cases.reduce((n, c) => n + splitDetections(c).all.length, 0)).toBe(EXPECTED_DETECTIONS);
    expect(asserted).toBe(EXPECTED_DETECTIONS);
  });
});

describe('processImage vs the binary, end to end', () => {
  const executed: string[] = [];

  for (const entry of cases) {
    const processed = wasProcessed(entry);
    executed.push(entry.name);

    it(`${entry.name} ${processed ? 'processes' : 'skips'} exactly as upstream did`, () => {
      const image = rebuild(entry.name);
      const before = Uint8Array.from(image.data);

      const result = processImage(image);
      expectPipelineMatches(result, entry);

      const changedAt = firstDifference(image.data, before);
      if (processed) {
        // Something must have moved, or "processed" would be a lie the
        // decision assertions on their own cannot catch.
        expect(changedAt, `${entry.name} left every pixel alone`).not.toBe(-1);
      } else {
        // The safety property the whole gate exists for: a skipped image
        // comes back byte for byte as it went in.
        expect(changedAt, `${entry.name} modified byte ${changedAt}`).toBe(-1);
      }
    });
  }

  it('ran every detection-eligible case', () => {
    expect(executed).toHaveLength(EXPECTED_CASES);
    expect(new Set(executed).size).toBe(EXPECTED_CASES);
  });
});

/**
 * The gate is the caller's threshold and nothing else.
 *
 * Two cases sit just above the default gate, at confidence 0.324 and 0.327,
 * and upstream's internal 0.35 label calls neither of them detected. If
 * that label leaked into the decision both would skip at every threshold;
 * if the comparison were `>` rather than `>=` the boundary would move. A
 * threshold between the two must therefore separate them, and one above
 * both must skip both.
 */
describe('threshold regression', () => {
  const lower = 'v2-small-1376x768'; // conf 0.324
  const higher = 'v2-small-1024x572'; // conf 0.327

  it('the two cases straddle 0.326 and neither is internally labelled', () => {
    for (const [name, confidence] of [
      [lower, 0.324],
      [higher, 0.327],
    ] as const) {
      const entry = cases.find((c) => c.name === name) as ManifestCase;
      const passing = splitDetections(entry).gates.at(-1);
      expect(passing?.confidence, `${name} manifest confidence`).toBe(confidence);
      expect(passing?.detected, `${name} sits below the internal 0.35 label`).toBe(false);
    }
  });

  it('separates them at 0.326', () => {
    expect(processImage(rebuild(lower), { threshold: 0.326 }).status).toBe('skipped');
    expect(processImage(rebuild(higher), { threshold: 0.326 }).status).toBe('processed');
  });

  it('skips both at 0.40', () => {
    for (const name of [lower, higher]) {
      expect(processImage(rebuild(name), { threshold: 0.4 }).status, name).toBe('skipped');
    }
  });

  it('processes both at the default 0.25', () => {
    for (const name of [lower, higher]) {
      expect(processImage(rebuild(name)).status, name).toBe('processed');
    }
  });
});

/**
 * The rule on its own, away from the pipeline.
 *
 * At the call site the tie rule is unobservable: `attempts` is always
 * `[V2, V1]`, so "keep the later" and "keep the earlier" differ only in
 * which of two equal numbers is returned, and both spellings produce a
 * green run. The rule is only testable by constructing the tie directly —
 * which is the whole reason `reportedAttempt` is a named function.
 */
describe('reportedAttempt', () => {
  const attempt = (variant: 'V1' | 'V2', confidence: number): DetectionResult => ({
    variant,
    size: 'small',
    region: { x: 0, y: 0, width: 36, height: 36 },
    confidence,
    scores: { spatial: 0, gradient: 0, variance: 0 },
    circuitBreaker: false,
    internalDetected: false,
  });

  it('keeps the later attempt on an exact tie', () => {
    const first = attempt('V2', 0.1);
    const second = attempt('V1', 0.1);
    // Identity, not equality: the two are indistinguishable by value, and
    // that is exactly the confusion this rule has to survive.
    expect(reportedAttempt([first, second])).toBe(second);
  });

  it('keeps the higher score regardless of position', () => {
    const low = attempt('V1', 0.089);
    const high = attempt('V2', 0.164);
    expect(reportedAttempt([high, low])).toBe(high);
    expect(reportedAttempt([low, high])).toBe(high);
  });

  it('handles a single attempt and negative confidences', () => {
    const only = attempt('V2', -0.087);
    expect(reportedAttempt([only])).toBe(only);
    // Circuit-broken confidences are unclamped, so the comparison has to
    // work below zero too (DEVIATIONS D2).
    const worse = attempt('V1', -0.174);
    expect(reportedAttempt([worse, only])).toBe(only);
    expect(reportedAttempt([only, worse])).toBe(only);
  });

  it('throws rather than inventing a report from nothing', () => {
    expect(() => reportedAttempt([])).toThrow(RangeError);
  });
});

describe('the tie between skipped attempts', () => {
  it('reports the later attempt when both score identically', () => {
    // `clean-1024x572` scores exactly 0.000 on both V2 and V1. Upstream
    // replaces its reported attempt only on a strict improvement
    // (`current_attempt.confidence > proc_result.confidence`,
    // cli_app.cpp:293), and the value it starts from is the V1 retry — so a
    // tie keeps V1. Getting this backwards is invisible in the reported
    // confidence, which is why the manifest values are asserted first: they
    // are what makes this case a tie rather than an ordinary comparison.
    const entry = cases.find((c) => c.name === 'clean-1024x572') as ManifestCase;
    const { gates } = splitDetections(entry);
    expect(gates.map((g) => g.confidence)).toEqual([0, 0]);
    expect(gates.map((g) => g.variant)).toEqual(['V2', 'V1']);

    const result = processImage(rebuild('clean-1024x572'));
    expect(result.status).toBe('skipped');
    expect(result.confidence).toBe(0);
    expect(result.attempts.at(-1)?.variant, 'the retry is the one kept').toBe('V1');
  });

  it('reports the earlier attempt when it scored strictly higher', () => {
    // `v2-large-2752x1536-hard` is the mirror image: V2 scores 0.164 and the
    // V1 retry only 0.089, so the strict comparison does fire and the V2
    // number is the one reported. Without it a caller would be told 0.089
    // and lose how close the current profile came.
    const entry = cases.find((c) => c.name === 'v2-large-2752x1536-hard') as ManifestCase;
    const { gates } = splitDetections(entry);
    expect(gates.map((g) => g.variant)).toEqual(['V2', 'V1']);
    expect((gates[0]?.confidence ?? 0) > (gates[1]?.confidence ?? 0)).toBe(true);

    const result = processImage(rebuild('v2-large-2752x1536-hard'));
    expect(result.status).toBe('skipped');
    expect(result.confidence).toBe(result.attempts[0]?.confidence);
  });
});

/**
 * Which variants get tried, and how many times.
 *
 * `v1-small-800x600` is the case that can tell these apart: its default run
 * needs the fallback, trying V2 (which skips) and then V1 (which processes).
 * So every switch that turns the fallback off has to turn a processed image
 * into a skipped one — and each has to do it after exactly one attempt,
 * because an attempt that runs is a detector pass the caller is paying for.
 *
 * Upstream reaches the same three states through `--legacy` (variant pinned
 * to V1), `--no-legacy` (pinned to V2, no retry) and no flag at all
 * (V2 with the retry armed) — cli_app.cpp L718-746.
 */
describe('the fallback switches', () => {
  const name = 'v1-small-800x600';

  it('tries V2 then V1 by default, and processes on the retry', () => {
    const result = processImage(rebuild(name));
    expect(result.status).toBe('processed');
    expect(result.attempts.map((a) => a.variant)).toEqual(['V2', 'V1']);
    expect(result.variant).toBe('V1');
  });

  it('an explicit V1 skips straight to V1, without a wasted V2 pass', () => {
    const result = processImage(rebuild(name), { variant: 'V1' });
    expect(result.status).toBe('processed');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.variant).toBe('V1');
    expect(result.variant).toBe('V1');
  });

  it('an explicit V2 disables the retry, so the image is left alone', () => {
    const image = rebuild(name);
    const before = Uint8Array.from(image.data);
    const result = processImage(image, { variant: 'V2' });

    expect(result.status).toBe('skipped');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.variant).toBe('V2');
    expect(firstDifference(image.data, before)).toBe(-1);
  });

  it('autoFallback: false does the same without naming a variant', () => {
    const result = processImage(rebuild(name), { autoFallback: false });
    expect(result.status).toBe('skipped');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.variant).toBe('V2');
  });

  it('autoFallback is ignored once a variant is named', () => {
    // The contract says the flag applies "only when `variant` is unset", so
    // asking for both must not resurrect the second attempt.
    const result = processImage(rebuild(name), { variant: 'V1', autoFallback: true });
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.variant).toBe('V1');
  });
});

/**
 * `force` and `add` bypass the gate, and the contract says what that costs:
 * no attempts, a zero confidence, and — for force — the internal snap
 * detection still running, so the removal position is still refined.
 */
describe('the gate-free paths', () => {
  it('force removes a case the default run skips, reporting no attempts', () => {
    const image = rebuild('v2-large-2752x1536-hard');
    const before = Uint8Array.from(image.data);
    const result = processImage(image, { force: true, threshold: 0.9 });

    expect(result.status).toBe('processed');
    expect(result.attempts).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(firstDifference(image.data, before), 'force left every pixel alone').not.toBe(-1);
  });

  it('add reports processed without detecting anything', () => {
    const image = rebuild('clean-800x600');
    const before = Uint8Array.from(image.data);
    const result = processImage(image, { mode: 'add' });

    expect(result.status).toBe('processed');
    expect(result.variant).toBe('V1');
    expect(result.attempts).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(firstDifference(image.data, before), 'add left every pixel alone').not.toBe(-1);
  });

  it('add places the watermark by the resolved size, not the dimensions', () => {
    // This is the one asymmetry between adding and removing, and it is
    // upstream's: `add_watermark` builds its config from the size actually
    // used (`{64, 64, 96}` for large), while `remove_watermark` keeps the
    // dimension-derived position and only swaps the template — the quirk in
    // DEVIATIONS D3. Forcing large on an 800x600 image separates the two,
    // because the position is the only thing that moves.
    const forced = rebuild('clean-800x600');
    const result = processImage(forced, { mode: 'add', size: 'large' });
    // 800 - 64 - 96, 600 - 64 - 96. A dimension-derived config would place
    // the same 96px template at 800 - 32 - 48 = 720, 600 - 32 - 48 = 520.
    expect(result.size).toBe('large');
    expect(result.region).toEqual({ x: 640, y: 440, width: 96, height: 96 });

    const natural = rebuild('clean-800x600');
    const small = processImage(natural, { mode: 'add' });
    expect(small.size).toBe('small');
    expect(small.region).toEqual({ x: 720, y: 520, width: 48, height: 48 });
  });
});

/**
 * The contract's error table, made true.
 *
 * These are the JavaScript caller's failures — TypeScript already rejects
 * most of them — and each one has to throw rather than default, because the
 * defaults here are "process as V2" and "remove", which would modify an
 * image the caller never asked to have modified.
 */
describe('invalid input', () => {
  const valid: ImageBuffer = { data: new Uint8Array(4 * 3), width: 2, height: 2, channels: 3 };

  it('throws RangeError when the buffer length disagrees with the shape', () => {
    expect(() => processImage({ ...valid, data: new Uint8Array(11) })).toThrow(RangeError);
    expect(() => processImage({ ...valid, data: new Uint8Array(11) })).toThrow(
      /holds 11 bytes, expected 12/,
    );
  });

  it('throws RangeError on an unsupported channel count', () => {
    expect(() => processImage({ ...valid, channels: 2 as unknown as 3 })).toThrow(/channels is 2/);
  });

  it('throws RangeError on non-integer dimensions', () => {
    expect(() => processImage({ ...valid, width: 2.5 })).toThrow(
      /dimensions must be positive integers/,
    );
  });

  it('throws TypeError when the image is not an object', () => {
    expect(() => processImage(null as unknown as ImageBuffer)).toThrow(TypeError);
    expect(() => processImage(undefined as unknown as ImageBuffer)).toThrow(TypeError);
  });

  it('throws RangeError on a value outside one of the option unions', () => {
    const bad = [
      { variant: 'v2' as unknown as 'V2' },
      { size: 'Small' as unknown as 'small' },
      { mode: 'REMOVE' as unknown as 'remove' },
    ];
    for (const options of bad) {
      expect(() => processImage({ ...valid }, options), JSON.stringify(options)).toThrow(RangeError);
    }
    // Detection takes the same two unions and rejects them the same way.
    expect(() => detectWatermark(valid, { variant: 'v1' as unknown as 'V1' })).toThrow(RangeError);
    expect(() => detectWatermark(valid, { size: 'LARGE' as unknown as 'large' })).toThrow(
      /expected 'small' or 'large'/,
    );
  });
});
