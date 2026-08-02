# CLAUDE.md

Guidance for AI agents (and human contributors) working in this repository.

## What this project is

`gemini-watermark` is a **faithful TypeScript port** of
[GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool) v0.3.2
(C++, MIT, Allen Kuo): a deterministic engine that detects, removes, and adds
Gemini visible image watermarks via reverse alpha blending.

The single most important property of this codebase: **the C++ reference
implementation is the sole authority on behavior.** This port does not
"improve" the algorithm, tune thresholds, or fix perceived quirks — it
reproduces them. A deviation from the reference is a bug even when the
deviation looks better. Algorithm changes happen upstream first, then get
ported with a version-bump note.

One module is exempt because it has no upstream to defer to:
**`src/video.ts`, the Veo video extension.** Upstream v0.3.2 has no video
path, so its authority there is **measurement**: every constant and
algorithmic choice traces to experiments on real Veo sample videos,
recorded in `docs/plan/DEVIATIONS.md` D8 (and its quality addendum). The
extension has its own rules below — the porting rules still bind it
wherever it calls into ported code (`removeWatermarkRegion`,
`quantizeU8`, the source alpha maps).

## Reference materials

You only need the upstream C++ source when **porting a new algorithm
module**. Contributions to docs, tests, tooling, or already-ported code
work entirely from this repository — the committed fixtures and the rules
below carry the required semantics.

| Resource | How to get it | Role |
|---|---|---|
| Upstream C++ source | `git clone https://github.com/allenk/GeminiWatermarkTool` at tag `v0.3.2` (commit `7c6a99f`) | Line-level porting reference. The module plan below names the exact upstream function each module ports. |
| Reference kit | Generation scripts live in `tools/reference/` (see its README); regenerate the kit locally from the upstream release binary into `GWT_REFERENCE_DIR`. | Golden outputs + `manifest.json` with per-stage detection scores, for local pixel-level equivalence runs |
| Committed fixtures | `test/data/fixtures.json` (in repo) | Geometry expectations (dims → variant/margin/logo/position) validated against the reference binary |
| Video measurements | `docs/plan/DEVIATIONS.md` D8 + addendum (in repo) | The video extension's "upstream": geometry, blend law, per-video opacity, and the experiment table behind every `src/video.ts` constant. Measured from Veo 720p samples; the sample videos themselves are not committed. |

## Architecture and module plan

Core rule: `src/` is **environment-agnostic**. No DOM, no Node APIs, no
`canvas`, no file I/O — pixels enter and leave as `ImageBuffer`
(typed array + width/height/channels, defined in `src/types.ts`). Anything
environment-specific (canvas decode, file loading) belongs in a future
explicitly-named entry point, never in the core.

| Module | Ports (upstream function, file) | Status |
|---|---|---|
| `src/types.ts` | types from `watermark_engine.hpp` | ✅ |
| `src/position.ts` | `get_watermark_config` / `get_watermark_size` / `v2_small_config_from_dims` (`watermark_engine.cpp`) | ✅ |
| `src/alpha-maps.ts` | the four calibrated **source** BG captures (V1-48/V1-96/V2-36/V2-96), baked as data, no PNG decode at runtime (`blend_modes.cpp`) — derived sizes belong to `effectiveAlphaMap` below | ✅ |
| `src/blend.ts` | `remove_watermark_alpha_blend` / `add_watermark_alpha_blend` (`blend_modes.cpp`) | ✅ |
| `src/imageops.ts` + `src/resize.ts` | minimal primitives the detector needs: grayscale, Sobel magnitude, NCC template match (`TM_CCOEFF_NORMED`), mean/stddev, area/bilinear resize + `effectiveAlphaMap` derived-size resolution (`effective_alpha_map` / `create_interpolated_alpha`, `watermark_engine.cpp`) | ✅ |
| `src/detect.ts` | `detect_one_variant` (three stages, circuit breaker, spatial rescue, ±3px V2-small snap) + the V2→V1 fallback and skip/processed status semantics — the CLI's `error` exit code stays CLI-only, invalid input throws (`watermark_engine.cpp`, `cli_app.cpp`) | ✅ |
| `src/guided.ts` | `guided_detect` coarse-to-fine multi-scale snap engine (`watermark_engine.cpp`) | ⏳ M7 |
| `src/inpaint.ts` | Soft Inpaint, GAUSSIAN branch of `inpaint_residual` (`watermark_engine.cpp`) | ⏳ M7 |
| `src/video.ts` | **extension, no upstream counterpart** — Veo geometry (48px logo, 96px margins), temporal self-calibration (biharmonic background inpainting), per-frame reverse blend + edge-band smoothing, one-call `processVideo`; provenance is measurement (DEVIATIONS D8), not C++ | ✅ |
| `src/index.ts` | public API surface | grows with modules |

Port the remaining modules in that order — each lands in the same
PR/commit as its equivalence tests. Update the README status table in the
same commit. The ffmpeg glue for video lives in `tools/video/`, outside
the core, and stays out of the npm package.

## Porting rules (numeric fidelity)

These are the traps that produce silent 1-pixel or 1-count divergences.
All of them are load-bearing:

1. **Rounding**: C++ `std::round` rounds half away from zero. JS
   `Math.round` does not (negative halves). Always use
   `roundHalfAwayFromZero` from `src/position.ts` for any value that the
   C++ side rounds. Never use bare `Math.round` in ported code.
2. **Grayscale conversion**: OpenCV's 8-bit `COLOR_BGR2GRAY` CPU path is
   fixed-point, not the float formula:
   `Y = (9798·R + 19235·G + 3735·B + 16384) >> 15`
   (15-bit coefficients, shift = half-up on the non-negative domain;
   coefficients attach to color channels, not byte order — our RGB(A)
   buffers use them directly). This rounding is distinct from the blend
   quantization law in rule 5. Detection quantizes gray to uint8 first,
   then converts to float `/255` — mirror that order.
3. **Channel order doesn't matter for blend math** (it is per-channel
   symmetric), but **alpha derivation** is `max(R,G,B)/255` — max is
   order-free. Don't introduce BGR anywhere; the port is RGB-native.
4. **Float width**: C++ computes in `float` (32-bit); JS numbers are
   64-bit. This is acceptable — the contract with golden outputs is
   ±1 per 8-bit channel on restored pixels, not bit-identical floats.
   Decision outputs (detected flags, chosen variant, regions, exit-like
   statuses) must match exactly; confidence scores must match within the
   per-category budgets in the testing conventions below (2e-3 against
   the 3-decimal manifest oracle).
5. **uint8 quantization**: three rounding laws coexist — never conflate
   them. (a) Position math uses `std::round` (half away from zero, rule 1).
   (b) Grayscale uses the fixed-point shift of rule 2 (half-up).
   (c) Pixel quantization after blend goes through OpenCV
   `convertTo(CV_8UC3)` = `saturate_cast<uchar>` = `cvRound`; on the
   pinned OpenCV version under the default FP rounding mode this measures
   as **half to even**, and blend output is already clamped to [0,255]
   before it. cvRound is implementation/rounding-mode dependent, so the
   pinned-version cv2 oracle dumps (and the reference binary's golden
   outputs) are the final authority — implement clamp + half-to-even and
   verify against them.
6. **Resize equivalence**: the standard removal path resizes the 96px
   alpha source to the config's logo size, both directions: exact
   integer-factor box mean (96→48 = 2×2), general `INTER_AREA`
   (pixel-coverage weighted) for downscales (96→42 etc.), and
   `INTER_LINEAR` (bilinear, half-pixel centers) for upscales — wide
   small-class images (e.g. 3000×1000) infer logo sizes above 96. All
   paths verify against cv2 oracle dumps; do not substitute a generic
   third-party resampler.
7. **Constants are copied, not derived.** Thresholds and weights come
   verbatim from the C++ source, with a comment citing file and function:
   spatial circuit breaker 0.25, spatial rescue 0.30, internal label
   threshold 0.35, fusion weights 0.50/0.30/0.20, V2-small snap pad ±3px,
   snap trust gate 0.60, alpha skip threshold 0.002, alpha clamp 0.99,
   default CLI-level detection threshold 0.25.
8. **Detection ROI subtleties**: the ROI is clamped to image bounds and
   (for V2 small) expanded by the snap pad; the alpha template slides via
   NCC across that region. Follow `detect_one_variant` exactly, including
   when the snapped offset is trusted (spatial ≥ 0.60) vs discarded.

Every ported function carries a provenance comment naming the C++
file/function it ports, in the style already used by `src/position.ts`.

## Video extension rules (`src/video.ts`)

The porting rules above answer "does this match the C++?"; the video
module has no C++, so its rules answer "does this match the *videos*?":

1. **Constants are measured, not designed.** Every threshold, size and
   weight carries a comment stating what was measured and how it decided
   the value (the style already used throughout `src/video.ts`). A number
   with no measurement behind it does not belong in the module.
2. **Algorithm changes must win a race.** Any change to the estimator,
   the gates, or the finishing pass is validated against alternatives on
   real sample videos before landing, scored by metrics that are not
   circular (a metric aligned with the estimator's own objective will
   always flatter it — the D8 addendum documents this trap and the
   signals used instead: residual/template correlation and edge-band
   Laplacian noise vs an untouched control ring). Record the variant
   table in a D8 addendum; losing variants are documented, not deleted
   from history.
3. **Clean videos are the dangerous input.** A calibration that
   "succeeds" on a watermark-free video reverse-blends a ghost sparkle
   *into* it. Anything touching the gates keeps the negative paths
   intact: the streaming calibrator throws, `processVideo` skips with
   every frame byte-identical, and both are pinned by tests.
4. **The blend arithmetic is still the port's.** Removal delegates to
   `removeWatermarkRegion` and quantization to `quantizeU8`; the video
   module must not fork its own copies of ported math.
5. **Geometry claims are 720p-wide only.** The 48/96 rule was measured on
   1280×720 and 720×1280 samples; other resolutions are unverified by
   design, and the template gate — not optimism — is what handles them.

## Testing conventions

- Framework: vitest. Tests live in `test/`, named `<module>.test.ts`.
- **Every algorithm module ships with equivalence tests in the same
  commit.** Geometry/decision assertions are exact; pixel assertions allow
  ±1 per channel (outside the watermark region and on the A channel:
  byte-exact); score assertions compare as `absErr ≤ absTol + relTol·|ref|`
  with per-category budgets — manifest scores 2e-3/0 (the log carries
  3 decimals), cv2-dump operators 1e-6/1e-5, NCC vs dump 1e-4/0 — never
  `toBeCloseTo` decimal-digit semantics. **Never loosen a tolerance to
  make a test pass**; tolerances carry no decision responsibility.
  Threshold gates are extracted as pure functions and unit-tested at
  `<` / `==` / `>` directly.
- `test/data/fixtures.json` is generated by the reference kit — never edit
  it by hand. To extend coverage, extend the kit's `make_fixtures.py`,
  regenerate, re-validate against the reference binary, then copy here.
- Preserve hard cases. `v2-large-2752x1536-hard` (busy background) is a
  case the reference detector itself skips — the port must reproduce the
  skip. Do not "fix" it.
- Pixel-level golden comparisons (against `$GWT_REFERENCE_DIR/golden/`)
  run locally; CI runs the self-contained tests. Keep large binaries out
  of this repo.
- Negative paths matter: clean images must skip (circuit breaker), and
  buffer-shape validation errors must throw `RangeError`/`TypeError` with
  actionable messages.
- Video tests (`test/video.test.ts`) have no upstream oracle, so they run
  the other direction: synthetic videos with exactly known ground truth —
  watermark forward-blended by our own `addWatermarkRegion` — and
  calibration/removal must recover it within budgets **derived** in the
  file's header comment (never tuned to pass; same discipline as the
  oracle tolerances). Clean synthetic videos must skip/throw, both
  fallback routes are pinned mechanically, and calibrate-heavy tests
  carry explicit `{ timeout }` options because the biharmonic fill takes
  seconds, not milliseconds.

## Code style

- Strict TS: no `any`, no non-null assertions in `src/` (tests may relax).
  `noUncheckedIndexedAccess` is on — index typed arrays via subarray/offset
  arithmetic patterns that keep the checker satisfied without per-pixel
  branching.
- Naming: C++ `snake_case` maps to `camelCase`; keep the noun structure
  recognizable (`v2_small_config_from_dims` → `v2SmallConfigFromDims`).
- Hot loops (per-pixel work) must not allocate. Preallocate `Float32Array`
  scratch buffers outside the loop; no closures over per-pixel state.
- Comments explain constraints and provenance, in English. Don't narrate
  what the next line does.
- Public API: named exports only, re-exported through `src/index.ts`.
  Types exported with `export type`.
- ESM only. Relative imports use the `.js` extension (required by
  `verbatimModuleSyntax` + bundler resolution at publish time).

## Toolchain notes

- Node ≥ 20. CI matrix: 20 / 22 / 24.
- TypeScript is pinned to 5.9.x — **TS 7.x breaks tsup's dts pipeline**
  (`rollup-plugin-dts` crash). Do not bump the major until tsup (or a
  replacement bundler) supports it; verify `npm run build` produces
  `dist/index.d.ts` when touching the toolchain.
- Scripts: `npm run typecheck` / `test` / `build`. All three must pass
  before any commit; CI enforces the same trio.

