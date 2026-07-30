# gemini-watermark — Porting Execution Master Plan

> This file is the **entry point for the long-running execution session**.
> It converged through four rounds of external review (final verdict:
> "no blockers, ready to start" — see the review record at the end).
> Step-level instructions live in `docs/plan/M0.md` – `M6.md`; this file
> does not repeat them.

## Reading and execution order

1. `CLAUDE.md` (the standards layer: porting rules, numeric semantics,
   code style — authoritative definitions live there)
2. This file (baseline, scope, tolerances, session protocol)
3. `docs/plan/M<current>.md` (step-level instructions), executed in
   order M0 → M6

**Determining the current milestone**: check the README status table +
`git log`; a fresh start means M0.

## Background and current baseline

**Repository baseline** (as of commit `bd84791`): scaffolding (tsup +
vitest + ESM-only + TypeScript pinned to 5.9 — do not upgrade to TS 7),
`src/types.ts` + `src/position.ts` ported with 21 equivalence tests,
CI (Node 20/22/24) green. No other modules started.

**Reference assets**: M0 eliminated the machine-local dependency. The
generation scripts are in-repo under `tools/reference/`, take every path
from `GWT_UPSTREAM_DIR` / `GWT_REFERENCE_DIR` (no defaults — a missing
variable exits 2), and verify the pinned binary hash and upstream commit
before producing anything. The kit itself is still generated locally
rather than committed — it is far too large — but any machine can now
rebuild a **pixel-identical** one from the repo. (Byte-identical files
additionally require the pinned `tools/reference/requirements.txt`
toolchain: a different Pillow re-encodes the same pixels into different
PNG bytes, which is why the oracle hashes decoded pixels rather than
files — see `docs/plan/DEVIATIONS.md` D1.)

| Asset | Location | Contents |
|---|---|---|
| Upstream C++ checkout | `$GWT_UPSTREAM_DIR` (machine-local clone) | v0.3.2, commit `7c6a99f`; verified by `git rev-parse` before use |
| Reference kit | `$GWT_REFERENCE_DIR` (machine-local, regenerated from `tools/reference/`) | `bin/gwt-mini` (v0.3.2 release binary, SHA256 `8f4796a1…`, full value in M0.md), `alpha/` — 4 calibrated PNGs, `fixtures/` (11 watermarked + 3 clean), `golden/` (default/ + force/ + forced_size/ + manifest.json) |
| Generation scripts | repo `tools/reference/` | 5 parameterized Python scripts (extract_alpha, make_fixtures, gen_golden, validate_manifest, make_patches) + `manifest.schema.json` + pinned `requirements.txt` |
| Committed test data | repo `test/data/` | `fixtures.json` (geometry expectations), `manifest.json` (decision/score oracle), `cases/` (patch + blend crops for CI) |

**Glossary**:

- **golden-force / golden-default**: outputs produced by the reference
  binary with `--force + pinned profile` / default arguments — the
  pixel-level oracle
- **manifest**: structured record (argv, detection scores and decisions,
  regions, status, `eligible_for` applicability tags) — the
  decision/score-level oracle; scores carry only 3 decimal places
- **patch + reconstruction**: the CI data format — a cropped block that
  carries the original image size and its absolute origin; tests rebuild a
  zero-filled full-size buffer and place the patch (a bare crop changes
  geometry inference and must never be fed in as an image)
- **blend crop**: watermark region ±8px, used only for blend region-math
  tests
- **the three rounding laws**: position half-away / grayscale fixed-point
  half-up / quantization cvRound half-even — CLAUDE.md rules 1/2/5

## Scope and compatibility matrix (the v0.1.0 promise boundary)

| Upstream capability | v0.1.0 | Notes |
|---|---|---|
| Auto detection (three stages + circuit breaker + rescue + snap) | ✅ equivalent | |
| V2→V1 fallback, threshold gate, skip semantics | ✅ equivalent | |
| Reverse removal (V1+V2 all profiles, incl. forced-size quirk) | ✅ equivalent | force keeps the internal snap detection |
| Forward add V1 | ✅ equivalent | |
| Forward add V2 | ⚠️ TS extension | oracle = C++ remove restores the original; must not be described as upstream equivalence |
| region/snap search, Soft Inpaint | ❌ M7 | |
| NS/TELEA/AI denoise, file IO | ❌ never / excluded by design | |
| Runtime environments | Node ≥20 + browser smoke, both CI-tested; nothing else promised | |

## Tolerance and oracle principles

1. **Decision equivalence is the hard constraint** (detect/skip, circuit
   breaker, variant, region, status must match exactly); tolerances never
   carry decision responsibility; **never loosen a tolerance to make a
   test pass**
2. Scores compare as `absErr ≤ absTol + relTol·|ref|`: manifest scores
   2e-3/0 (log has 3 decimals); cv2-dump operators 1e-6/1e-5; NCC vs dump
   1e-4/0; pixels ±1 (outside-region and A channel byte-exact). Never use
   `toBeCloseTo`
3. Threshold gates (0.25/0.30/0.35/0.60/user threshold) are extracted as
   pure functions and unit-tested at `<` / `==` / `>`
4. Oracle layering: decisions/geometry = manifest, exact; scores =
   manifest, low precision; operators = cv2 dumps, full precision;
   pixels = golden images, ±1

## Milestone index (details in docs/plan/M*.md)

| Milestone | One-liner | Key deliverables |
|---|---|---|
| [M0](docs/plan/M0.md) | Self-contained reference toolchain + data infrastructure + claim corrections | tools/reference/, manifest schema, patch data, check script |
| [M1](docs/plan/M1.md) | Alpha source-map data module | src/alpha-maps.ts (the four source maps only) |
| [M2](docs/plan/M2.md) | Forward/reverse blend | src/blend.ts + quantize.ts, CI crop equivalence |
| [M3](docs/plan/M3.md) | Image primitives | imageops/resize/effective-alpha aligned to cv2 dumps |
| [M4](docs/plan/M4.md) | Detection and orchestration | **first commit freezes the API contract**, full manifest equivalence |
| [M5](docs/plan/M5.md) | API docs + examples + package quality | e2e matrix, browser smoke, CONTRIBUTING, publint/attw |
| [M6](docs/plan/M6.md) | Release rehearsal (no publish) | temp-clone rehearsal, consumer smoke, CHANGELOG |
| M7 (later) | guided snap, Soft Inpaint, real-sample collection | does not block v0.1.0; planned separately |

## Long-running session protocol

**Cadence**: one milestone = one branch + one CI-green PR, with atomic
commits at the boundaries defined in its plan file; run `npm run check`
before every commit (before M0 exists, use `typecheck && test && build`).
Closing a milestone: verify every acceptance checkbox → update the README
status table → merge. Track commit-level progress with
TaskCreate/TaskUpdate.

**Equivalence discipline** (highest priority):

- A failing test → first suspect a porting mistake and re-check against
  the C++ source line by line; then suspect misuse of the oracle.
  **Forbidden**: loosening tolerances, hand-editing fixture/manifest
  values, "fixing" upstream quirks
- Facts that contradict the plan or expectations (oracle measurements,
  upstream behavior) → record in `docs/plan/DEVIATIONS.md` (symptom,
  evidence, disposition) and continue with unaffected work
- An acceptance item that genuinely cannot be met → the milestone stops on
  its unmerged branch; record in DEVIATIONS, then move to independent work
  or stop. **Never merge past a failing acceptance item**

**Permission boundary**:

- Allowed: commits, pushes, opening/merging its own PRs in this repo; kit
  regeneration; temp-directory operations
- Forbidden: `npm publish`, `git tag`, any write to the upstream repo,
  deleting/cleaning the active working tree, mutating machine state
  outside `~/gwt-reference`
- Stuck on something only the user can decide (contract semantics with no
  upstream evidence, self-contradictory acceptance criteria) → record in
  DEVIATIONS and stop at that point. Do not guess

**Per-commit implement/review loop** (when orchestrating with subagents):

- The orchestrator itself writes no code — it routes plan sections, diffs,
  and findings, keeping its own context small
- For each commit boundary in the milestone file:
  1. The **implementation subagent** receives: the milestone file path +
     which commit number is current, the instruction to read CLAUDE.md →
     PLAN.md → the **entire milestone file** (its Base-fact header states
     what is being ported; its Context section explains where this work
     sits; never excerpt just the commit section), the branch name, and
     the env vars. Before writing any code it completes the milestone's
     **Required upstream reading** list — the exact C++ files/functions
     being ported, read in full (never the whole upstream repo: GUI/AI-
     denoise/build code is irrelevant and dilutes attention). It then
     implements, runs `npm run check` (plus the section's own verification
     steps), and reports the diff summary with verification output,
     confirming the required reading was done
  2. The **review subagent** (read-only) receives the same pointers
     (full milestone file + commit number) and reviews the actual
     `git diff` against: scope match (nothing
     beyond the section), CLAUDE.md compliance (provenance headers, the
     three rounding laws, forbidden imports, zero runtime deps), tests
     present and meaningful per the section, verification output
     plausibility, and equivalence discipline (any `test/data` change must
     come from the regeneration scripts, never hand edits — the
     implementer must state this in its report)
  3. Pass → commit (conventional message) and advance; fail → findings go
     back to the implementation subagent; loop. After **3 failed rounds**
     on the same commit → record in `docs/plan/DEVIATIONS.md` and stop
     for user input
- Milestone close remains as above: acceptance checklist verified item by
  item, README status table updated, then merge

**Context management**: each milestone file is self-contained; after a
context compaction, recover via "Reading and execution order" + the README
status table + `git log`, never via conversation memory. Subagents start
with fresh context by design — every subagent prompt must carry its plan
section and the pointer to CLAUDE.md/PLAN.md rather than assume shared
memory.

## Known risks and mitigations

| Risk | Mitigation |
|---|---|
| manifest scores have only 3 decimals | 2e-3 tolerance; decisions/coordinates are the primary contract |
| OpenCV fixed-point grayscale platform differences | target byte-exact, documented fallback + M4 decision backstop (M3.md) |
| matchTemplate DFT numeric path | 1e-4 + degenerate cases follow the dump + pure gate functions |
| all-synthetic fixtures, no real samples | manual smoke before release; M7 collection channel; stated in README |
| JPEG decoder differences | kit emits decode-normalized PNGs; TS side never decodes JPEG |
| reference binary / dependency drift | pinned SHA256 + requirements.txt + verification steps |

## Review record

- Round 1 (26 findings): 24 adopted, 2 downgraded (perf gate → non-blocking
  bench; size caps → recorded baselines)
- Round 2 (17 findings; verdict "not executable"): all adopted —
  patch+reconstruction replaces bare crops, oracle precision honest at
  2e-3, cvRound half-to-even correction, V2-add demoted to TS extension,
  force keeps internal snap, API three-layer split frozen up front,
  release rehearsal moved to a temp clone, executed-count closure checks
- Round 3 (2 blockers + minors): all adopted — resize gains INTER_LINEAR
  upscale, forced-size gains golden data and acceptance (quirk ported
  as-is); grayscale fixed-point formula, cvRound wording qualified,
  V2-add oracle guarded against self-validation, 0.99 clamp is
  remove-only, M4-0 as a standalone commit, M6 checks out a recorded SHA
- Round 4: **"no blockers, ready to start"**; three wording fixes applied
- Round 5 (restructure): reshaped for a long-running session into master
  plan + `docs/plan/M*.md` step files; the M4 API contract draft written
  in advance into M4.md (removes solo-decision risk); session protocol
  added (equivalence discipline, permission boundary, checkpoint recovery)
