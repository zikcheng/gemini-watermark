# Contributing

This project is a **faithful port**, which makes contributing to it unlike
contributing to most libraries: the C++ reference implementation
([GeminiWatermarkTool] v0.3.2, commit `7c6a99f`) is the sole authority on
behavior, and a deviation from it is a bug **even when the deviation looks
better**. Thresholds are not tuned here, quirks are not fixed here, and a
test that fails is assumed to have caught a porting mistake until proven
otherwise.

That rule is the reason for most of what follows. [CLAUDE.md](CLAUDE.md) is
the standards layer (numeric semantics, code style, module plan);
[PLAN.md](PLAN.md) defines scope, tolerances and the milestone sequence.
This file is the practical how-to.

## Development environment

Node ≥ 20 is the only requirement for working on the TypeScript:

```bash
npm ci
npm run check
```

Python is needed **only** to regenerate the reference kit, which most
changes do not touch. See [Regenerating the reference kit](#regenerating-the-reference-kit).

## The three test suites

They are deliberately disjoint, because two of them need something a bare
checkout does not have. Each is opted into by its own script, and each
**throws rather than skips** when its prerequisite is missing — a skipped
equivalence test looks exactly like a passing one.

| Command | Runs | Needs |
|---|---|---|
| `npm run check` | forbidden-import scan, typecheck, unit + e2e tests, build, examples typecheck, package lint (`publint` + `attw`) | nothing |
| `npm run test:golden` | full-size pixel equivalence vs the reference kit | `$GWT_REFERENCE_DIR` |
| `npm run test:browser` | the built bundle driven in a real Chromium | `npm run build`, Playwright's Chromium |

`npm run check` is the gate CI runs and the one to run before every commit.
The other two are additional, not alternatives.

Its last step, `check:package`, runs `publint` and `attw` against the packed
tarball rather than the working tree, so it sees what a consumer installs.

`attw` runs under `--profile esm-only`, because this package ships one ESM
build and no CommonJS one. The profile *declares* that shape rather than
muting a rule: attw still prints the `CJSResolvesToESM` finding and marks it
`(ignored per resolution)`, and the two resolutions that actually matter for
an ESM-only package — `node16 (from ESM)` and `bundler` — still have to be
green. If a CJS build is ever added, drop the profile first and let the tool
re-audit.

The `exports` map uses a `default` condition rather than `import`. Both look
identical to publint and attw, but they are not identical to Node: with
`import` alone, `require('gemini-watermark')` fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED` ("No exports main defined"), which reads like
a broken package rather than an ESM-only one. With `default`, Node loads it
through `require(esm)` and it simply works — from **20.19** in the 20.x line
(where it was backported) and **22.12** in 22.x, which covers every currently
supported release. Only the older patches, 20.0–20.18 and 22.0–22.11, report
`ERR_REQUIRE_ESM`, and that is the accurate error for them. attw's finding
stays either way — its static analysis predates `require(esm)` — which is why
the condition is chosen on measured behaviour rather than on the tool's
output.

### `npm run test:golden`

```bash
export GWT_REFERENCE_DIR="$HOME/gwt-reference"
npm run test:golden
```

**"skipped golden" ≠ "passed golden".** Read the summary line: a healthy
run reports `3 passed` test files and roughly a hundred tests. If
`GWT_REFERENCE_DIR` is unset the suite *fails at collection* with an
actionable message rather than reporting zero tests — that is on purpose. A
small number of individually skipped tests is normal (a case the kit has no
oracle for), but a *file* that collected nothing is a broken setup, not a
green run.

### `npm run test:browser`

```bash
npx playwright install chromium   # once
npm run build                     # the suite tests dist/, not src/
npm run test:browser
```

It loads `dist/index.js` over HTTP with a bare `import`, runs `processImage`
in the page, and compares the sha256 of the resulting pixels with the value
Node computed from the same bytes. If `dist/` is missing it throws and names
the missing build step.

### Suite isolation, and the variable that used to break it

Suite selection reads two environment variables, `GWT_GOLDEN` and
`GWT_BROWSER` (see `vitest.config.ts`). Because they are environment
variables, exporting one in your shell would otherwise silently shrink the
default run — `npm run check` would execute a handful of tests and still
exit 0. The `test` script therefore clears both:

```json
"test": "GWT_GOLDEN= GWT_BROWSER= vitest run"
```

If you add a suite, follow the same pattern: opt in through a script, clear
the flag in the default run, and throw on a missing prerequisite.

## Numeric equivalence rules

The full set is [CLAUDE.md § Porting rules](CLAUDE.md#porting-rules-numeric-fidelity);
these are the ones that most often produce a silent one-off divergence.

- **Three rounding laws coexist, and conflating them is the classic bug.**
  Position math rounds half **away from zero** (C++ `std::round`, *not*
  `Math.round`); grayscale uses OpenCV's fixed-point shift, which is
  half-**up**; pixel quantization after a blend is `cvRound`, which measures
  as half-to-**even**. Never use bare `Math.round` in ported code.
- **Constants are copied, not derived**, with a comment citing the C++ file
  and function. `0.25`, `0.30`, `0.35`, `0.60`, the `0.50/0.30/0.20` fusion
  weights, `±3px`, `0.002`, `0.99` all come from the source verbatim.
- **Decisions are exact; only scores and pixels have tolerances.** Detect
  vs skip, circuit breaker, variant, region and status must match exactly.
  Scores compare as `absErr ≤ absTol + relTol·|ref|` against the budgets in
  PLAN.md; restored pixels allow ±1 per channel, and everything the removal
  should not touch is byte-exact. **Never use `toBeCloseTo`** — its
  decimal-digit semantics are not the contract.
- **Never loosen a tolerance to make a test pass.** That is the one change
  guaranteed to be wrong: tolerances do not carry decision responsibility,
  so a failure inside one is evidence about the port, not about the budget.
- **`src/` stays environment-agnostic.** No DOM, no Node APIs, no file I/O.
  `npm run check:imports` enforces it textually; environment-specific code
  belongs in `examples/`.

## Regenerating the reference kit

Only needed when the upstream version changes, when the pinned
opencv-python changes, or when you are adding fixture coverage. The kit
itself is not committed (it is far too large) but any machine can rebuild a
pixel-identical one.

[`tools/reference/README.md`](tools/reference/README.md) is the authority —
prerequisites, the pinned binary SHA256, the execution order, and what each
script writes. In outline: install the upstream checkout at `7c6a99f`, put
the release binary at `$GWT_REFERENCE_DIR/bin/gwt-mini`, create a venv from
`tools/reference/requirements.txt`, then run the five scripts in order.

Two rules about its output:

- **`test/data/` is never hand-edited.** `fixtures.json`, `manifest.json`,
  `cases/` and `imageops/` (the pinned cv2 dumps, written by
  `dump_imageops.py`) must all be verbatim script products. Extend coverage by
  extending the generator, regenerating, and re-validating — never by
  editing a number that disagrees with your code.
- **A `test/data/` diff must be explained by a regeneration**, and your PR
  should say which script produced it.

## Upstream sync policy

When a new upstream version lands, the order is not negotiable:

1. Update the pinned commit/binary and **regenerate the kit and manifest**
   first. The new oracle is what tells you what actually changed.
2. Re-run `npm run check` and `npm run test:golden` against it. Failures now
   are a map of the behavioral delta.
3. **Only then** port code, one module at a time, each with its equivalence
   tests in the same commit.
4. Record the version bump and any behavior change in the README scope
   section and `docs/plan/DEVIATIONS.md`.

Porting a change before the oracle knows about it means validating new code
against stale expectations, which is how a "fix" gets baked in.

Facts that contradict the plan — an oracle measurement that surprises you,
upstream behavior that the docs describe differently — go in
`docs/plan/DEVIATIONS.md` with symptom, evidence and disposition. That file
is where "we looked, and this is what is true" lives.

## Releasing

[`docs/release-checklist.md`](docs/release-checklist.md) is the procedure:
a rehearsal that packs the candidate in a temporary clone and installs the
tarball into throwaway ESM and TypeScript consumers, then the release-day
steps. Read it before touching anything release-shaped — it also explains
why `npx attw` must never run in a directory without installed dependencies.

## Pull request checklist

- [ ] `npm run check` passes.
- [ ] `npm run test:golden` passes locally (or you state why it could not
      run — it is not part of CI).
- [ ] `npm run test:browser` passes if you touched `src/`, the build, or
      anything the bundle's loadability depends on.
- [ ] Every ported function carries a provenance comment naming the C++
      file and function it ports.
- [ ] New algorithm code ships with its equivalence tests **in the same
      commit**, and threshold gates are tested at `<`, `==` and `>`.
- [ ] No tolerance was loosened, and no upstream quirk was "fixed".
- [ ] Any `test/data/` change is a regeneration, and the PR says so.
- [ ] The README status table and `docs/api-contract.md` still describe
      what the code does.
- [ ] Commit messages are [Conventional Commits] (`feat:`, `fix:`, `test:`,
      `docs:`, `chore:`).

## Reporting a detection or removal bug

Behavioral reports are only actionable with the image dimensions, since
every geometry decision is derived from them. Useful reports include the
dimensions, the variant you expected, and the `ProcessResult` — `attempts`
in particular, which carries each stage's score and tells the difference
between "the detector never saw it" (circuit breaker) and "it saw it and
scored it below the gate".

If the image can be shared, say so; the fixture corpus is entirely
synthetic, and real samples are a known gap (PLAN.md risk table).

[GeminiWatermarkTool]: https://github.com/allenk/GeminiWatermarkTool
[Conventional Commits]: https://www.conventionalcommits.org/
