# gemini-watermark

Detect, remove, and add Gemini visible image watermarks via deterministic
**reverse alpha blending**. A faithful TypeScript port of
[GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool) by
Allen Kuo.

Zero dependencies and environment-agnostic: the core has no DOM, no Node
APIs and no file I/O, so it works wherever you can hand it a pixel buffer.
Browsers and **Node ≥ 20** are the environments CI tests, and the only two
the package promises.

Try it online at [gemini-watermark.org](https://gemini-watermark.org).

## How it works

Gemini applies its visible watermark with standard alpha blending against a
white logo:

```
watermarked = α × 255 + (1 − α) × original
```

The alpha map `α` is a fixed, calibrated pattern. Removal inverts the
equation exactly:

```
original = (watermarked − α × 255) / (1 − α)
```

No generative inpainting, no hallucination — pixels are reconstructed
mathematically. See the original author's write-up:
[Removing Gemini AI Watermarks: A Deep Dive into Reverse Alpha Blending](https://allenkuo.medium.com/removing-gemini-ai-watermarks-a-deep-dive-into-reverse-alpha-blending-bbbd83af2a3f).

## Install

```bash
npm install gemini-watermark
```

## Usage

The library takes pixels and returns pixels. Decoding and encoding are
yours to choose, which is what keeps the core identical in both
environments.

### Node

```js
import sharp from 'sharp';                       // your decoder, not a dependency of ours
import { processImage } from 'gemini-watermark';

const { data, info } = await sharp('gemini.png')
  .raw()
  .toBuffer({ resolveWithObject: true });

// `data` is a Node Buffer, which is a Uint8Array — pass it directly.
// Pass `info.channels` through rather than hardcoding it. sharp's `.raw()`
// normalises to sRGB, so it reports 3 or 4 whatever the file was —
// grayscale, palette and CMYK sources all arrive as 3. A decoder that hands
// back a single grayscale channel is rejected with a `RangeError`.
const image = {
  data,
  width: info.width,
  height: info.height,
  channels: info.channels,   // 3 or 4
};

const result = processImage(image);   // rewrites `image.data` in place

if (result.status === 'processed') {
  console.log(`removed a ${result.variant} watermark, confidence ${result.confidence}`);
  await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .png()
    .toFile('clean.png');
} else {
  console.log(`no watermark found (confidence ${result.confidence}) — image untouched`);
}
```

### Browser

```js
import { processImage } from 'gemini-watermark';

// `colorSpaceConversion: 'none'` is required, not stylistic: the default
// converts the embedded colour profile while decoding, which changes pixel
// values and breaks both detection and removal.
const bitmap = await createImageBitmap(file, {
  colorSpaceConversion: 'none',
  imageOrientation: 'from-image',
});

const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
const context = canvas.getContext('2d');
context.drawImage(bitmap, 0, 0);

const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
const result = processImage({
  data: imageData.data,
  width: canvas.width,
  height: canvas.height,
  channels: 4,
});

if (result.status === 'processed') {
  context.putImageData(imageData, 0, 0);        // same array, rewritten in place
  const blob = await canvas.convertToBlob({ type: 'image/png' });
}
```

## API

Full semantics are in [`docs/api-contract.md`](docs/api-contract.md). The
exported surface is exactly:

```ts
// The pipeline, and the gate it applies.
function processImage(image: ImageBuffer, options?: ProcessOptions): ProcessResult;
function detectWatermark(image: ImageBuffer, options?: DetectOptions): DetectionResult;
function passesThreshold(confidence: number, threshold: number): boolean;

// Geometry: where a watermark goes for a given image size.
function getWatermarkSize(imageWidth: number, imageHeight: number): WatermarkSize;
function getWatermarkConfig(imageWidth: number, imageHeight: number, variant?: WatermarkVariant): WatermarkPosition;
function getWatermarkTopLeft(config: WatermarkPosition, imageWidth: number, imageHeight: number): Point;

// Region-level blend, for callers driving placement themselves.
function getSourceAlphaMap(variant: WatermarkVariant, size: WatermarkSize): Float32Array;
function removeWatermarkRegion(image: ImageBuffer, alpha: Float32Array, alphaWidth: number, alphaHeight: number, position: Point, logoValue?: number): void;
function addWatermarkRegion(image: ImageBuffer, alpha: Float32Array, alphaWidth: number, alphaHeight: number, position: Point, logoValue?: number): void;
```

Every type those signatures mention is exported too, so a caller can name
one without redeclaring it:

```ts
import type {
  DetectOptions, DetectionResult, DetectionScores,
  ImageBuffer, Point, Rect,
  ProcessOptions, ProcessResult, ProcessStatus,
  WatermarkPosition, WatermarkSize, WatermarkVariant,
} from 'gemini-watermark';
```

Everything else is internal — the rounding laws, the OpenCV-compatible
image primitives, the resampling kernels, the stage predicates. They exist
to match one specific OpenCV build, and publishing them would freeze
compatibility decisions as API promises.

### `ImageBuffer`

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
scores. Nothing in the API can detect that mistake. The alpha channel of an
RGBA buffer is never read and never written — it passes through byte for
byte.

### `processImage`

```ts
interface ProcessOptions {
  mode?: 'remove' | 'add';      // default 'remove'
  threshold?: number;           // default 0.25; gates removal only
  autoFallback?: boolean;       // default true; only when `variant` is unset
  force?: boolean;              // default false
  variant?: WatermarkVariant;   // explicit choice disables the fallback
  size?: WatermarkSize;         // forced size; reproduces the upstream quirk
  logoValue?: number;           // default 255
}

interface ProcessResult {
  status: 'processed' | 'skipped';
  confidence: number;
  variant?: WatermarkVariant;   // set when processed
  size?: WatermarkSize;         // set when processed
  region?: Rect;                // set when processed
  attempts: DetectionResult[];
}
```

The properties worth knowing before relying on it:

- **In place.** The buffer passed in is the buffer modified; the result
  object carries metadata, not pixels.
- **A skipped image is untouched** — every byte of `image.data` is exactly
  as it was. This is the safety property the gate exists for: feeding a
  holiday photo to a batch job must not alter it.
- **`attempts` records the gate detections only**, in try order: the V2
  attempt, then the V1 attempt if the fallback ran. The re-detection that
  removal runs internally to fix the snap position is not an attempt.
- **When every attempt skips, `confidence` is the highest of them**, so a
  near miss is not masked by a hopeless retry. `variant`, `size` and
  `region` describe an image that was modified, so on a skip they stay
  `undefined`.
- **`confidence` is 0 when no gate ran** — with `force: true` or in `'add'`
  mode, detection is bypassed and `attempts` is empty.
- **`force` skips the gate, and that is not an error.** `threshold` is
  ignored rather than rejected. The internal snap detection still runs, and
  no V1 fallback is attempted, because there is no skip to trigger one.
- **`size` reproduces a quirk rather than fixing it.** Forcing a size picks
  the *template*, while the removal *position* still comes from the
  dimension-derived config. Recorded in `docs/plan/DEVIATIONS.md` D3; do not
  use it expecting a well-defined resize.
- **`add` has no detection concept.** Upstream's add is unconditional, so
  `threshold`, `autoFallback` and `force` do not apply and `status` is
  always `'processed'`.

### `detectWatermark`

One variant per call — this is upstream's `detect_one_variant`, not the
fallback orchestration. Trying V2 then V1 is `processImage`'s job.

```ts
interface DetectionResult {
  variant: WatermarkVariant;
  size: WatermarkSize;
  region: Rect;              // post-snap when the trust gate passed
  confidence: number;
  scores: { spatial: number; gradient: number; variance: number };
  circuitBreaker: boolean;
  internalDetected: boolean;
}
```

- **`region`** is where the watermark was found, which is not always where
  the formula predicts. For V2 small the detector sweeps ±3px and adopts the
  best offset **only when `scores.spatial >= 0.60`**.
- **`confidence`** is `0.50·spatial + 0.30·gradient + 0.20·variance`,
  clamped to [0, 1], then raised to `spatial` if `spatial >= 0.30`. On the
  circuit-breaker path it is `spatial × 0.5` instead — **not clamped**, so
  it can be negative.
- **`circuitBreaker`** marks the early exit at `spatial < 0.25`. Stages 2
  and 3 never ran, so `gradient` and `variance` are `0` — absence of
  evidence, not measurements of zero.
- **`internalDetected`** is upstream's `confidence >= 0.35` label, and is
  **informational only**. The gate that decides whether an image is modified
  is `processImage`'s `threshold`.

### Errors

Invalid input throws; there is no error status.

| Condition | Error |
|---|---|
| `data.length !== width * height * channels` | `RangeError` |
| `channels` not 3 or 4 | `RangeError` |
| non-integer position or dimensions | `RangeError` |
| unknown `variant` / `size` / `mode` value | `RangeError` |
| `image` not an object with the required fields | `TypeError` |

## Scope and port fidelity

v0.1.0 targets **subset equivalence**: a defined subset of
GeminiWatermarkTool v0.3.2's behavior, reproduced exactly, with the
boundary stated rather than left to inference.

| Upstream capability | v0.1.0 | Notes |
|---|---|---|
| Auto detection (three stages + circuit breaker + rescue + snap) | ✅ equivalent | |
| V2→V1 fallback, threshold gate, skip semantics | ✅ equivalent | |
| Reverse removal (V1 + V2, all profiles, incl. the forced-size quirk) | ✅ equivalent | `force` keeps the internal snap detection |
| Forward add V1 | ✅ equivalent | |
| Forward add V2 | ⚠️ TypeScript extension | not upstream equivalence — see below |
| Region/snap search, Soft Inpaint | ❌ not in v0.1.0 | planned, later |
| NS/TELEA/AI denoise, file I/O | ❌ excluded by design | the core takes and returns pixel buffers |
| Runtime environments | Node ≥ 20 + browsers | both CI-tested; nothing else promised |

**Forward add for V2 is an extension, not a port.** Upstream's CLI cannot
add a watermark at all, and its engine's `add_watermark` implements only the
V1 geometry — there is no upstream behavior to match. It is verified by
round trip instead: the reference C++ binary must restore the original from
what this port adds, within ±1 per channel. That proves the forward blend
inverts the reverse one; it does **not** claim Gemini or upstream would
produce the same watermarked image. Forward add for **V1** is
upstream-equivalent.

**How equivalence is checked.** Each ported module ships with tests against
oracles generated from the reference C++ binary (v0.3.2, pinned by SHA256).
Decisions — detect vs skip, circuit breaker, chosen variant, region, and the
resulting status — must match **exactly**. Pixels the removal rewrites match
within **±1 per 8-bit channel**; everything it should not touch is
**byte-exact**, both outside the watermark region and on the alpha channel
of an RGBA buffer. Upstream quirks are reproduced rather than corrected:
that includes a busy-background fixture its own detector misses, which this
port must also skip.

## Limitations

- **SynthID is untouched.** This removes the *visible* overlay only. Gemini
  images also carry Google's invisible SynthID watermark, which is a
  different mechanism entirely and is not affected by anything here.
- **Colour management breaks detection.** Both stages read exact pixel
  values, so any colour transform between the file and the buffer — a
  browser applying an embedded ICC profile, a decoder converting to a
  display profile — lowers the confidence score and leaves a residue where
  the watermark was. In browsers, pass
  `colorSpaceConversion: 'none'` to `createImageBitmap`.
- **JPEG decoders disagree.** Two decoders can produce different pixels for
  the same JPEG, and detection scores move with them. The port never
  decodes anything itself, so the decoder you choose is part of your
  result; expect a lossy source to score lower than its PNG equivalent.
- **The fixture corpus is synthetic.** Equivalence is proven against
  generated fixtures processed by the reference binary, not against a
  collection of real Gemini output. Real-sample coverage is a known gap.
- **Not every upstream capability is here.** See the scope matrix above.

## Status

| Module | Status |
|---|---|
| Position config (V1/V2, canonical inference) | ✅ ported + tested |
| Alpha maps (baked calibration data) | ✅ ported + tested |
| Reverse alpha blend (remove / add) | ✅ ported + tested |
| Three-stage NCC detection | ✅ ported + tested |
| Guided multi-scale detection (snap) | ❌ M7 (not in v0.1.0) |
| Soft inpaint residual cleanup | ❌ M7 (not in v0.1.0) |

Everything v0.1.0 promises is implemented and shipped: `detectWatermark`
runs the three weighted stages with the circuit breaker, the spatial rescue
and the V2 small snap, and `processImage` wraps them in the V2→V1 fallback,
the confidence gate and the removal itself.

Underneath the detector are primitives checked against measured output of
the pinned OpenCV rather than against a textbook formula: grayscale, Sobel
magnitude, mean/standard deviation, normalized cross-correlation and the
two resampling kernels that derive the non-canonical alpha sizes.

The equivalence infrastructure all of it is tested against is in place too:
`tools/reference/` regenerates the reference kit from the pinned C++ binary
and validates it, and `test/data/` carries the committed oracle — geometry
fixtures, the detection/score manifest, per-case image patches for CI, and
the cv2 operator dumps. Detection is held against that manifest case by
case, and against a branch matrix for the paths no fixture reaches.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: this is a port,
so the C++ reference is the authority on behavior, `test/data/` is
regenerated rather than edited, and tolerances are never loosened to make a
test pass.

Version history, including which upstream release each version tracks, is in
[CHANGELOG.md](CHANGELOG.md).

## License & attribution

MIT. The algorithm, calibrated alpha-map data, and position formulas are
derived from [GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool)
(MIT, Copyright © 2025 Allen Kuo). See [LICENSE](LICENSE).

This tool removes **visible** watermarks only. It does not affect SynthID
invisible watermarks. Use responsibly and in compliance with applicable laws
and terms of service.
