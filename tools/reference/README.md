# Reference kit generation scripts

These scripts regenerate the oracle this port is verified against: the
calibrated alpha captures, the synthetic fixtures, and the golden outputs
of the **reference C++ binary** (GeminiWatermarkTool v0.3.2, commit
`7c6a99f`). Nothing here runs in CI and nothing here ships in the package
— the committed data under `test/data/` is their output.

Every path is resolved from an environment variable or an explicit flag.
There are **no default paths**: a missing variable exits `2` with an
actionable message rather than guessing a location, because a kit built
against an unknown checkout or an unknown binary is not an oracle.

## Prerequisites

**1. Upstream C++ checkout** at the pinned commit — supplies
`assets/embedded_assets.hpp` (the alpha captures) and `artworks/` (fixture
content material):

```bash
git clone https://github.com/allenk/GeminiWatermarkTool
git -C GeminiWatermarkTool checkout 7c6a99f   # tag v0.3.2
export GWT_UPSTREAM_DIR="$PWD/GeminiWatermarkTool"
```

**2. Reference binary** — `gwt-mini` from the v0.3.2 release. `gen_golden.py`
verifies its SHA256 and `--version` before running and refuses to continue
on a mismatch. The pinned hash below is the **macOS Universal** build; the
Linux/Windows builds are different binaries and will not pass the check.

| Artifact | SHA256 |
|---|---|
| [`gwt-mini-macos-universal.zip`](https://github.com/allenk/GeminiWatermarkTool/releases/download/v0.3.2/gwt-mini-macos-universal.zip) | `da56b0537b54f9921498da6cfad48d92aa9795bd09ebbb2e0ac24edcbbd1db0f` |
| `gwt-mini` (extracted) | `8f4796a1450a6471d29dc670627c73d6506c3fd686370c258b7d986b8de453d1` |

```bash
export GWT_REFERENCE_DIR="$HOME/gwt-reference"
mkdir -p "$GWT_REFERENCE_DIR/bin"
curl -L -o /tmp/gwt-mini.zip \
  https://github.com/allenk/GeminiWatermarkTool/releases/download/v0.3.2/gwt-mini-macos-universal.zip
unzip -o /tmp/gwt-mini.zip -d "$GWT_REFERENCE_DIR/bin"
chmod +x "$GWT_REFERENCE_DIR/bin/gwt-mini"
shasum -a 256 "$GWT_REFERENCE_DIR/bin/gwt-mini"   # must match the table above
```

**3. Python ≥ 3.10 with the pinned dependencies.** The cv2 build is a
numeric oracle (resize kernels, `cvRound` quantization), so install the
exact versions:

```bash
python3 -m venv "$GWT_REFERENCE_DIR/.venv"
"$GWT_REFERENCE_DIR/.venv/bin/pip" install -r tools/reference/requirements.txt
```

## Environment variables

| Variable | Points at | Used by |
|---|---|---|
| `GWT_UPSTREAM_DIR` | upstream C++ checkout root (commit `7c6a99f`) | `extract_alpha.py`, `make_fixtures.py`, `gen_golden.py` |
| `GWT_REFERENCE_DIR` | kit working directory (`bin/`, `alpha/`, `fixtures/`, `golden/`) | the three generation scripts |

Missing or wrong variables are reported together, in one failure, with
exit `2`. Every script that touches the checkout also verifies it sits on
the pinned commit (`git rev-parse HEAD`); `gen_golden.py` records the
measured commit in the manifest's `toolchain` block alongside the binary
hash and the cv2 version. `validate_manifest.py` needs no variables — it
checks a committed artifact.

## Execution order

Each step consumes the previous step's output, so run them in order:

| # | Script | Reads | Writes |
|---|---|---|---|
| 1 | `extract_alpha.py` | `$GWT_UPSTREAM_DIR/assets/embedded_assets.hpp` | `$GWT_REFERENCE_DIR/alpha/*.png` |
| 2 | `make_fixtures.py` | `alpha/`, `$GWT_UPSTREAM_DIR/artworks/` | `$GWT_REFERENCE_DIR/fixtures/`, `test/data/fixtures.json` |
| 3 | `gen_golden.py` | `bin/gwt-mini`, `fixtures/` | `$GWT_REFERENCE_DIR/golden/`, `test/data/manifest.json` |
| 4 | `validate_manifest.py` | `test/data/manifest.json`, `manifest.schema.json` | nothing (checks only) |
| 5 | `make_patches.py` | `fixtures/`, `golden/`, `test/data/manifest.json` | `test/data/cases/` |

`dump_imageops.py` stands outside that chain: it measures the pinned cv2
itself rather than the reference binary, so it needs neither the kit nor
the environment variables. Run it whenever the pinned opencv-python
version changes.

| Script | Reads | Writes |
|---|---|---|
| `dump_imageops.py` | nothing but `cv2` | `test/data/imageops/` |

## One-shot regeneration

```bash
export GWT_UPSTREAM_DIR="$HOME/GeminiWatermarkTool"
export GWT_REFERENCE_DIR="$HOME/gwt-reference"
PY="$GWT_REFERENCE_DIR/.venv/bin/python3"

"$PY" tools/reference/extract_alpha.py && \
"$PY" tools/reference/make_fixtures.py --fixtures-out test/data/fixtures.json && \
"$PY" tools/reference/gen_golden.py --manifest-out test/data/manifest.json && \
"$PY" tools/reference/validate_manifest.py test/data/manifest.json && \
"$PY" tools/reference/make_patches.py
```

The whole pipeline is deterministic — no randomness, no timestamps in the
outputs — so a rerun on the same inputs reproduces byte-identical files.
Run it from the repository root: `--fixtures-out` and `--manifest-out` are
the **only** supported ways to refresh the two committed data files, which
must always be verbatim script products (never hand-edited).

`gen_golden.py --binary <path>` overrides the binary location; the pinned
SHA256/version check still applies.

## What the manifest records

`manifest.schema.json` is the authority; the fields worth knowing before
reading it:

- **Scores** parsed directly from the `-v` log carry exactly **3 decimal
  places**. Compare them with the 2e-3 budget from CLAUDE.md's testing
  conventions, never with
  `toBeCloseTo`. They are `TM_CCOEFF_NORMED` correlations over [-1, 1] —
  negative values are normal on clean images. The one exception is a
  circuit-breaker detection's `confidence`: the breaker log line prints
  only `spatial`, so that field is **reconstructed** as
  `round(spatial × 0.5, 4)` (error ≤ 3e-4), not an independently printed
  value — see `docs/plan/DEVIATIONS.md` D2.
- **`decoded_pixel_sha256` / `output_decoded_sha256`** hash *decoded RGB
  pixels* (cv2 `IMREAD_COLOR`, BGR→RGB, contiguous uint8), not file bytes.
  That is what the reference binary consumes, and it is immune to PNG
  encoder drift across Pillow versions (see `docs/plan/DEVIATIONS.md` D1).
- **`eligible_for`** is derived from measured run results, not assigned by
  hand; downstream suites assert `executed == eligible − explicitly-skipped`.
- **`runs.forced_size`** captures the upstream size-override quirk: the
  removal position comes from the dims-based config while the template
  comes from the forced size. The recorded `alpha_map` is the evidence, and
  it is stored exactly as produced — never corrected (DEVIATIONS D3).

## What the committed patch data is

`make_patches.py` writes `test/data/cases/<name>/`, the CI-sized slice of
the kit. Two crops per case, both described by that case's `meta.json`:

- **`patch-*.png`** — the union of every region `detect_one_variant` reads
  for either variant (template ROI plus the variance reference strip
  above it), padded by 8px. Forced-size cases also union in the regions
  their forced combination reads.
- **`blend-*.png`** — the watermark region ±8px, for region-math tests
  only. `meta.blend.watermark_region_in_crop` gives its position inside
  the crop.

A patch is **not an image**: every geometry decision the engine makes is
inferred from image dimensions, so tests must rebuild a full-size buffer
via `test/helpers/reconstruct.ts` before calling the engine.

Which roles exist per case is meaningful, not incidental:
`patch-golden-default.png` is present only when the default run actually
processed the image (the `v2-large-2752x1536-hard` skip case has none),
negatives carry only `patch-watermarked.png`, and the JPEG case has no
`original` because the kit stores no separate ground truth for it.

The generator enforces two invariants and fails rather than emit bad data:
every detector region must fall inside the patch bbox, and `test/data`
must stay under 4 MiB.

## What the committed cv2 dumps are

`test/data/imageops/` holds measured behavior of the pinned
opencv-python, for the primitives the port reimplements. OpenCV's real
numbers differ from textbook formulas in ways that silently move detection
scores, so these are measurements, never derivations.

M0 ships one: `quantize-u8.json`, measuring `saturate_cast<uchar>` — the
conversion C++ uses to write blend results back (`convertTo(CV_8UC3)`).
Its `samples` array pairs the exact float32 input with the byte cv2
produced, and the meta records whether `clamp(half-to-even(v), 0, 255)`
reproduced every sample — so the rule stated in CLAUDE.md is a checked
claim rather than prose.

Read `measured_against` before treating it as proof: the dump comes from
opencv-python 5.0.0, while the reference binary statically links OpenCV
**4.11.0**. `cvRound` is implementation- and rounding-mode-dependent, so
this pins the law for our own arithmetic but is not self-sufficient
evidence about the binary. The comparison that actually ties the law to
the binary is M2's golden-force pixel check; if the two ever disagree, the
golden images win.
Inputs are widened to doubles in the JSON deliberately: `255.4` is not
representable in float32, and a JavaScript `255.4` literal is a third
value again, so a consumer must test the number cv2 actually saw.

The five detector primitives are dumped alongside it as `.bin` + `.json`
pairs: `bgr2gray`, `sobel-magnitude`, `mean-stddev`,
`match-template-ccoeff-normed` and `resize-alpha`.

Two conventions are worth knowing before reading one:

- Fields named `output`, `result` or `input` hold **array keys**, not
  filenames. Resolve them through the same JSON's `arrays` block, which
  carries `{file, dtype, shape}` — never build a `.bin` path by hand.
- cv2 is BGR and this port is RGB. Each dump records the channel order of
  what cv2 was handed; the grayscale coefficients attach to colours rather
  than positions, so the port applies them to its R/G/B and gets the same
  byte.

The degenerate `match-template` cases are there on purpose: OpenCV does
not return NaN when a variance is zero, and what it does return is
asymmetric — a constant *template* scores 1, a flat *search region* under
a varying template scores 0. Those numbers are the calibration for the
port's denominator guard, and they were measured, not reasoned out.

`dump_imageops.py` removes files a dump wrote on an earlier run but no
longer produces, so a renamed case cannot leave an orphan behind. Only the
dump's own files are touched, which keeps `--only` safe.

## Exit codes

`0` success · `2` environment or verification failure (missing variable,
missing input, binary hash/version mismatch). These mirror the reference
CLI's own convention, where `1` is reserved for "input skipped".

## Attribution

The calibrated alpha data (`alpha/` and everything derived from it) comes
from [allenk/GeminiWatermarkTool](https://github.com/allenk/GeminiWatermarkTool)
(MIT License, Copyright Allen Kuo). Redistribution must preserve that
copyright notice.
