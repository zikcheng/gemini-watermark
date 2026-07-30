import { describe, expect, expectTypeOf, it } from 'vitest';

import * as api from '../src/index.js';
import type {
  DetectOptions,
  DetectionResult,
  DetectionScores,
  ImageBuffer,
  ProcessOptions,
  ProcessResult,
  ProcessStatus,
  Rect,
  WatermarkPosition,
  WatermarkSize,
  WatermarkVariant,
} from '../src/index.js';

/**
 * The public surface, locked.
 *
 * `docs/api-contract.md` is the prose; this is the part a compiler can
 * check. It fails when an export appears or disappears, and when a shape
 * drifts — both of which are the kind of change that should require
 * deciding, not just typing.
 *
 * Adding something here is cheap; removing something later is not, because
 * consumers will have taken it. That asymmetry is the whole reason the
 * contract was frozen before `detect.ts` was written.
 *
 * Note where each half is enforced. The runtime assertions fail under
 * `npm run test`; the `expectTypeOf` assertions are erased before the
 * runner sees them and fail under `tsc` instead. `npm run check` runs
 * both, so it is the gate that actually holds the contract — a green
 * `vitest run` on its own does not.
 */
describe('public exports', () => {
  it('is exactly the contracted set of runtime exports', () => {
    // Types are erased at runtime, so this covers functions and values
    // only. The type-level assertions below cover the rest.
    expect(Object.keys(api).sort()).toEqual([
      'addWatermarkRegion',
      'getSourceAlphaMap',
      'getWatermarkConfig',
      'getWatermarkSize',
      'getWatermarkTopLeft',
      'passesThreshold',
      'removeWatermarkRegion',
    ]);
  });

  it('keeps the porting internals out of the surface', () => {
    // Named individually rather than checked as a group: each is a
    // deliberate exclusion, and a future contributor re-exporting one
    // should have to delete a line that says why.
    for (const internal of [
      'roundHalfAwayFromZero', // rounding law, not domain API
      'roundHalfToEven',
      'quantizeU8',
      'toGrayscale', // OpenCV-compatible primitives
      'meanStdDev',
      'sobelMagnitude',
      'matchTemplateCcoeffNormed',
      'resizeArea',
      'resizeBilinear',
      'resizeAreaIntegerFactor',
      'effectiveAlphaMap', // detection-internal alpha resolution
      'decodeBase64',
    ]) {
      expect(Object.keys(api)).not.toContain(internal);
    }
  });
});

describe('exported function signatures', () => {
  it('position helpers', () => {
    expectTypeOf(api.getWatermarkSize).toBeCallableWith(1024, 572);
    expectTypeOf(api.getWatermarkSize).returns.toEqualTypeOf<WatermarkSize>();

    expectTypeOf(api.getWatermarkConfig).toBeCallableWith(1024, 572, 'V2');
    expectTypeOf(api.getWatermarkConfig).returns.toEqualTypeOf<WatermarkPosition>();
  });

  it('blend takes an ImageBuffer and returns nothing', () => {
    expectTypeOf(api.removeWatermarkRegion).returns.toEqualTypeOf<void>();
    expectTypeOf(api.addWatermarkRegion).returns.toEqualTypeOf<void>();
    expectTypeOf(api.removeWatermarkRegion).parameter(0).toEqualTypeOf<ImageBuffer>();
  });

  it('getSourceAlphaMap returns a Float32Array', () => {
    expectTypeOf(api.getSourceAlphaMap).toBeCallableWith('V2', 'large');
    expectTypeOf(api.getSourceAlphaMap).returns.toEqualTypeOf<Float32Array>();
  });

  it('passesThreshold compares with >=, so equality passes', () => {
    expectTypeOf(api.passesThreshold).toEqualTypeOf<
      (confidence: number, threshold: number) => boolean
    >();
    // The boundary is the whole point of exporting it: a caller re-applying
    // the gate must land on the same side as the pipeline did.
    expect(api.passesThreshold(0.25, 0.25)).toBe(true);
    expect(api.passesThreshold(0.2499999, 0.25)).toBe(false);
    expect(api.passesThreshold(0.2500001, 0.25)).toBe(true);
    // Circuit-broken confidences are unclamped and can be negative; the
    // comparison must stay ordinary rather than special-casing them.
    expect(api.passesThreshold(-0.087, 0.25)).toBe(false);
    expect(api.passesThreshold(-0.087, -0.1)).toBe(true);
  });
});

describe('contracted shapes', () => {
  it('ImageBuffer accepts either byte array and only 3 or 4 channels', () => {
    expectTypeOf<ImageBuffer['data']>().toEqualTypeOf<Uint8Array | Uint8ClampedArray>();
    expectTypeOf<ImageBuffer['channels']>().toEqualTypeOf<3 | 4>();
  });

  it('DetectionResult carries scores as a nested object, not flat fields', () => {
    expectTypeOf<DetectionResult>().toEqualTypeOf<{
      variant: WatermarkVariant;
      size: WatermarkSize;
      region: Rect;
      confidence: number;
      scores: DetectionScores;
      circuitBreaker: boolean;
      internalDetected: boolean;
    }>();
    expectTypeOf<DetectionScores>().toEqualTypeOf<{
      spatial: number;
      gradient: number;
      variance: number;
    }>();
  });

  it('ProcessStatus has no error member', () => {
    // Invalid input throws; upstream's exit code 2 is a CLI concept with
    // no meaning for a function that takes a pixel buffer.
    expectTypeOf<ProcessStatus>().toEqualTypeOf<'processed' | 'skipped'>();
  });

  it('ProcessResult reports the outcome, and pixels stay in the buffer', () => {
    expectTypeOf<ProcessResult>().toEqualTypeOf<{
      status: ProcessStatus;
      confidence: number;
      variant?: WatermarkVariant;
      size?: WatermarkSize;
      region?: Rect;
      attempts: DetectionResult[];
    }>();
    // `attempts` is required even when empty: a caller should never have
    // to distinguish "no attempts" from "field missing".
    expectTypeOf<ProcessResult>().toHaveProperty('attempts').toEqualTypeOf<DetectionResult[]>();
  });

  it('options are all optional, so both calls are valid', () => {
    expectTypeOf<DetectOptions>().toEqualTypeOf<{
      variant?: WatermarkVariant;
      size?: WatermarkSize;
    }>();
    expectTypeOf<ProcessOptions>().toEqualTypeOf<{
      mode?: 'remove' | 'add';
      threshold?: number;
      autoFallback?: boolean;
      force?: boolean;
      variant?: WatermarkVariant;
      size?: WatermarkSize;
      logoValue?: number;
    }>();
  });

  it('Rect is the region type, distinct from the top-left-only Point', () => {
    expectTypeOf<Rect>().toEqualTypeOf<{
      x: number;
      y: number;
      width: number;
      height: number;
    }>();
    expectTypeOf<api.Point>().toEqualTypeOf<{ x: number; y: number }>();
  });

  it('the two variants and two size classes are closed unions', () => {
    expectTypeOf<WatermarkVariant>().toEqualTypeOf<'V1' | 'V2'>();
    expectTypeOf<WatermarkSize>().toEqualTypeOf<'small' | 'large'>();
  });
});
