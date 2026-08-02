# Public API contract (v0.1.0)

Frozen at M4 commit 1, before any detection code existed — deliberately,
so the contract is designed rather than back-formed from an
implementation. Everything below is either a direct port of
GeminiWatermarkTool v0.3.2 behaviour or an explicitly marked extension.

Changes after this point are limited to two kinds: corrections verified
against upstream behaviour, recorded with evidence, and naming tweaks. New
capabilities belong to a later version.

## What is public

`src/index.ts` exports exactly:

| Export | Kind | Since |
|---|---|---|
| `WatermarkVariant`, `WatermarkSize`, `WatermarkPosition`, `Point`, `Rect`, `ImageBuffer` | types | M0/M1 |
| `DetectionScores`, `DetectionResult`, `ProcessStatus`, `ProcessResult`, `DetectOptions`, `ProcessOptions` | types | M4 |
| `getWatermarkSize`, `getWatermarkConfig`, `getWatermarkTopLeft` | functions | M0 |
| `getSourceAlphaMap` | function | M1 |
| `removeWatermarkRegion`, `addWatermarkRegion` | functions | M2 |
| `passesThreshold` | function | M4 (commit 1) |
| `detectWatermark`, `processImage` | functions | M4 (commits 2–3) |

Everything else is internal, importable only by tests through module
paths. That includes the three rounding laws
(`roundHalfAwayFromZero`, `roundHalfToEven`, `quantizeU8`), the image
primitives (`toGrayscale`, `meanStdDev`, `sobelMagnitude`,
`matchTemplateCcoeffNormed`), the resampling kernels, `effectiveAlphaMap`,
and the pure gate predicates. They are porting details: publishing them
would freeze OpenCV-compatibility decisions as API promises, and a caller
who needs them is really asking for a different library.

## Image data

```ts
interface ImageBuffer {
  data: Uint8Array | Uint8ClampedArray;  // interleaved, row-major
  width: number;
  height: number;
  channels: 3 | 4;                       // RGB or RGBA
}
```

**RGB, not BGR.** OpenCV works in BGR and this port does not; a caller
handing over BGR pixels gets wrong luma and therefore wrong detection
scores. Nothing in the API can detect that mistake, which is why it is
stated here first.

The alpha channel of an RGBA buffer is never read and never written. It
passes through byte for byte.

## Detection

```ts
interface DetectionScores {
  spatial: number;    // stage 1: NCC against the alpha template
  gradient: number;   // stage 2: NCC of Sobel magnitudes
  variance: number;   // stage 3: texture dampening ratio
}

interface DetectionResult {
  variant: WatermarkVariant;
  size: WatermarkSize;
  region: Rect;              // post-snap when the trust gate passed
  confidence: number;
  scores: DetectionScores;
  circuitBreaker: boolean;
  internalDetected: boolean;
}

function detectWatermark(image: ImageBuffer, options?: DetectOptions): DetectionResult;

interface DetectOptions {
  variant?: WatermarkVariant;  // default 'V2'
  size?: WatermarkSize;        // default: derived from the image dimensions
}
```

One variant per call — this is upstream's `detect_one_variant`, not the
fallback orchestration. Trying V2 then V1 is `processImage`'s job.

Field-by-field:

- **`region`** is where the watermark was found, which is not always where
  the formula predicts. For V2 small the detector sweeps ±3px and adopts
  the best offset **only when `scores.spatial >= 0.60`**; below that the
  formula position stands, because on busy backgrounds a weak correlation
  drifts toward content edges.
- **`confidence`** is `0.50·spatial + 0.30·gradient + 0.20·variance`,
  clamped to [0, 1], then raised to `spatial` if `spatial >= 0.30` (the
  position-anchored rescue for backgrounds where stages 2 and 3 collapse).
  On the circuit-breaker path it is `spatial × 0.5` instead — **not
  clamped**, so it can be negative.
- **`circuitBreaker`** marks the early exit at `spatial < 0.25`. Stages 2
  and 3 never ran, so `scores.gradient` and `scores.variance` are `0` —
  absence of evidence, not measurements of zero.
- **`internalDetected`** is upstream's `confidence >= 0.35` label. It is
  **informational only**. The gate that decides whether an image is
  modified is `processImage`'s `threshold`, and upstream is explicit that
  OR-ing the internal label into that gate would make any threshold above
  0.35 a no-op.

## Gating

```ts
function passesThreshold(confidence: number, threshold: number): boolean;  // >=
```

Public, and the only gate in the API. Comparison is `>=`, so a confidence
exactly equal to the threshold passes. It is exported so a caller holding
a `ProcessResult` can re-apply the same comparison at a different
threshold and get the same answer the pipeline would — a decision that
should not have to be re-derived from prose.

`DetectionResult.internalDetected` is *not* this gate; see the note under
Detection.

The detector's own stage predicates — circuit breaker, spatial rescue,
score fusion, snap trust — stay internal. They are steps inside one
algorithm, not decisions a caller makes.

The four constants those predicates use are `0.25` (circuit breaker),
`0.30` (spatial rescue), `0.35` (internal label) and `0.60` (snap trust).
They are copied from the C++ source, never re-tuned, and tested at `<`,
`==` and `>`.

## Orchestration

```ts
type ProcessStatus = 'processed' | 'skipped';

interface ProcessResult {
  status: ProcessStatus;
  confidence: number;
  variant?: WatermarkVariant;   // set when processed
  size?: WatermarkSize;         // set when processed
  region?: Rect;                // set when processed
  attempts: DetectionResult[];
}

function processImage(image: ImageBuffer, options?: ProcessOptions): ProcessResult;

interface ProcessOptions {
  mode?: 'remove' | 'add';      // default 'remove'
  threshold?: number;           // default 0.25; gates removal only
  autoFallback?: boolean;       // default true; only when `variant` is unset
  force?: boolean;              // default false
  variant?: WatermarkVariant;   // explicit choice disables the fallback
  size?: WatermarkSize;         // forced size; reproduces the upstream quirk
  logoValue?: number;           // default 255
}
```

### Semantics

**In place.** The buffer passed in is the buffer modified; the result
object carries metadata, not pixels.

**A skipped image is untouched.** When `status` is `'skipped'`, every byte
of `image.data` is exactly as it was. This is the safety property the
whole gate exists for: feeding a holiday photo to a batch job must not
alter it.

**`attempts` records the gate detections only** — the V2 attempt, then the
V1 attempt if the fallback ran — in the order they were tried. Upstream
also re-runs detection inside removal to fix the snap position; that
internal pass is not an attempt and does not appear here.

**When every attempt skips, `confidence` is the highest of them** — so a
near miss is not masked by a hopeless retry. Only `confidence` is filled
in: `variant`, `size` and `region` describe an image that was modified,
and on a skip none was, so they stay `undefined`. Which attempt scored
what is in `attempts`, in try order.

**`confidence` is 0 when no gate ran.** With `force: true`, or in
`'add'` mode, detection is bypassed entirely and there is nothing to
report; `attempts` is empty. Upstream initialises the same field to zero
on those paths.

**`force` skips the gate, and that is not an error.** `threshold` is
ignored rather than rejected — upstream's `--force` simply turns detection
off. Two consequences worth stating: the internal snap detection still
runs, so the removal position is still refined; and no V1 fallback is
attempted, because there is no skip to trigger it.

**`size` reproduces a quirk rather than fixing it.** Forcing a size picks
the *template*, while the removal *position* still comes from the
dimension-derived config. The two can disagree, and upstream's own
`--force-small` on a large V2 image is a no-op for a related reason. This
is faithful behaviour, recorded in `docs/plan/DEVIATIONS.md` D3; do not
use `size` expecting a well-defined resize.

**`add` has no detection concept.** Upstream's add is unconditional, so
`threshold`, `autoFallback` and `force` do not apply. `status` is always
`'processed'`.

### Errors

Invalid input throws; there is no error status.

| Condition | Error |
|---|---|
| `data.length !== width * height * channels` | `RangeError` |
| `channels` not 3 or 4 | `RangeError` |
| non-integer position or dimensions | `RangeError` |
| unknown `variant` / `size` / `mode` value | `RangeError` |
| `image` not an object with the required fields | `TypeError` |

Messages state the actual and the expected value, in that order.

There is deliberately **no `'error'` status**. Upstream's exit code 2
covers file I/O and CLI misuse, neither of which exists in a library that
takes pixel buffers.

## Extension: forward add for V2

`processImage(image, { mode: 'add', variant: 'V2' })` has no upstream
counterpart. Upstream's CLI cannot add a watermark at all, and its engine's
`add_watermark` implements only the V1 geometry — so there is nothing to be
equivalent to.

It is verified by round trip instead: the reference C++ binary must be able
to remove what this port adds and recover the original within ±1 per
channel. That proves the forward blend inverts the reverse one; it does
**not** claim Gemini or upstream would produce the same watermarked image.

`mode: 'add'` with `variant: 'V1'` (the default) *is* upstream-equivalent.

## Extension: Veo video removal

Added after v0.1.2 as a new capability (the contract's "new capabilities
belong to a later version" clause). No upstream counterpart exists;
`docs/plan/DEVIATIONS.md` D8 records the measurements this rests on.

Exports: `VIDEO_LOGO_SIZE` (48), `VIDEO_MARGIN` (96),
`getVideoWatermarkConfig`, `createVideoCalibrator`,
`removeVideoWatermark`, and types `VideoWatermarkConfig`,
`VideoCalibrator`, `VideoCalibration`, `VideoCalibrationSource`,
`VideoRemoveOptions`.

Semantics:

- `getVideoWatermarkConfig(width, height)` is pure geometry: the 48px
  logo box inset 96px from the right and bottom edges, plus the 140px
  calibration window centered on it. Throws `RangeError` when either
  dimension is below 190 (the window would leave the frame) or
  non-integral.
- `createVideoCalibrator(width, height).addFrame(frame)` accepts RGB and
  RGBA `ImageBuffer`s of exactly those dimensions and accumulates the
  calibration window's temporal sums; it never retains the frame.
  `calibrate()` estimates the per-video alpha map from the temporal
  mean, and reports how via `source`: `'estimated'` when the estimate
  correlates with the V1-48 source map at NCC ≥ 0.98, `'template'` when
  it fell back to that map scaled by the least-squares gain. The
  fallback is itself gated: below NCC 0.5 — or without a positive
  fitted gain — nothing watermark-shaped is in the corner, and
  `calibrate()` throws `RangeError` rather than hand back an alpha that
  would blend a ghost sparkle *into* a clean video. It also throws
  `RangeError` with no frames.
- `removeVideoWatermark(frame, calibration, options?)` reverse-blends in
  place via the same arithmetic as `removeWatermarkRegion` (alpha-skip
  threshold, MAX_ALPHA clamp, A channel untouched) and throws
  `RangeError` when the frame's geometry disagrees with the
  calibration's. By default it then smooths the sparkle's thin edge band
  — the codec noise there is amplified by `1/(1−alpha)` — touching only
  the logo box grown by 4px; `{ smoothEdges: false }` yields the pure
  algebraic inversion, whose writes stay inside the logo box exactly.
- Determinism: same frames in, same calibration and pixels out. There is
  no randomness and no time dependence.

What is **not** promised: geometry above/below 720p-class frames (the
gate exists precisely because only 720p was measured), any file or
container handling, and the numeric identity of `templateNcc`/
`templateGain` across library versions — they are diagnostics, not
oracle-checked scores.

## Implementation notes (not contract)

Behaviour that the contract does not promise but the port must still get
right, recorded where the implementer will look.

**Ties between skipped attempts.** Upstream replaces the reported attempt
only on a strict improvement — `current_attempt.confidence >
proc_result.confidence` (`cli_app.cpp:293`), where `proc_result` is the V1
retry and `current_attempt` the earlier V2 try. So on an exact tie the
**later attempt (V1) is kept**. This is unobservable through the contract,
since a skip exposes no variant, which is why it lives here rather than
above — but it is observable in `attempts` ordering and in the reported
confidence's provenance, and getting it backwards would show up as a
manifest mismatch. `clean-1024x572` is a ready-made case: both attempts
score exactly `0.000`. M4 commit 3 must pin it.

## Out of scope for v0.1.0

Region and snap search, Soft Inpaint residual cleanup, NS/TELEA/AI
denoising, and all file I/O. The compatibility matrix in the README is the
authority on what this version promises.
