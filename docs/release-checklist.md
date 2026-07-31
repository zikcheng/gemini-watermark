# Release checklist

Two phases. The **rehearsal** proves the artifact works and is run against a
release candidate in a temporary clone; the **release day** steps are the
short, boring sequence that follows once the rehearsal is clean.

The most common release failure is not broken code — it is a broken
artifact: a tarball missing `dist/`, carrying a stale build, or failing to
import in a consumer project. `npm run check` cannot see any of those,
because it inspects the working tree rather than what npm would upload. That
is what the rehearsal is for.

> **`npm publish` and `git tag` are never executed without explicit
> instruction from the maintainer.** The rehearsal deliberately stops short
> of both. Everything below the "Release day" heading runs only when the
> maintainer says to release.

## Before you start: the `attw` binary name

`attw` is the bin name of `@arethetypeswrong/cli`. **A package literally
named `attw` also exists on npm and is not it** — a dependency-confusion
placeholder. So:

- Always invoke it through `npm run check:package` (or `npm run check`), or
  through the local `node_modules/.bin`. Both resolve the bin from the
  lockfile.
- **Never run `npx attw` in a directory whose dependencies are not
  installed.** With nothing local to resolve, `npx` fetches the registry
  package of that name and runs a stranger's code.
- In the temp clone this means `npm ci` **before** anything that reaches
  `attw` — which includes `npm run check`, since `check:package` is its last
  step.

The same reasoning applies to any short, generic bin name. Install first,
then run; `npx` is a fallback, not a shortcut.

## Rehearsal

Run every step and record its output. Nothing here touches the active
working tree, and nothing here cleans it — the clone is disposable, the
working tree is not.

### 1. Pin the candidate

```bash
CANDIDATE_SHA=$(git -C ~/gemini-watermark rev-parse HEAD)
echo "$CANDIDATE_SHA"        # record this in the PR description
```

Everything below is rehearsed against that exact commit, so the thing you
approve is the thing you would publish.

### 2. Clone and check out the candidate

```bash
git clone ~/gemini-watermark /tmp/gw-release
cd /tmp/gw-release
git checkout "$CANDIDATE_SHA"
```

### 3. Set the release version

```bash
npm version 0.1.0 --no-git-tag-version   # package.json + package-lock.json
```

`--no-git-tag-version` matters: `npm version` tags by default, and tagging is
a release-day step taken by the maintainer, not a side effect of a rehearsal.

### 4. Install and run the full gate

```bash
npm ci
npm run check
```

`npm ci` first — see the `attw` note above. `check` ends with `publint` and
`attw --pack . --profile esm-only`, both of which must report zero errors.

### 5. Pack, and inspect what npm would upload

```bash
npm pack                     # -> gemini-watermark-0.1.0.tgz
tar -tzf gemini-watermark-0.1.0.tgz
ls -l  gemini-watermark-0.1.0.tgz     # record the size baseline
```

The listing must contain **exactly**: `package/package.json`,
`package/LICENSE`, `package/README.md`, `package/dist/index.js`,
`package/dist/index.d.ts`, `package/dist/index.js.map` — and nothing else.
No `test/`, no `examples/`, no `tools/`, no `docs/`.

`prepack` rebuilds `dist/` as part of `npm pack`, so the tarball cannot
contain a stale build even if someone packs without building first. (It
fires for `npm pack` and for `attw --pack`; `publint` packs without running
scripts. Two consequences worth knowing: `npm run check` therefore builds
**twice** — once as its own step, once inside `attw` — and running
`npm run check:package` on its own also rewrites `dist/`. Neither is visible
in the log, because `attw` swallows the child process's output; confirm it
with the mtime of `dist/index.js` rather than by reading the console.)

### 6. Consumer smoke — ESM JavaScript and TypeScript

Install the tarball the way a user would, then prove it imports, type-checks
and computes.

```bash
mkdir /tmp/gw-consumer && cd /tmp/gw-consumer
npm init -y
npm i /tmp/gw-release/gemini-watermark-0.1.0.tgz typescript tsx @types/node
```

`@types/node` is there because the TypeScript smoke calls `console.log`, and
`console` comes from the environment's types rather than from `lib`. It also
matches how a Node consumer is actually configured.

> `npm init -y` writes to the **current directory**; `--prefix` does not
> redirect it. Make sure you are in `/tmp/gw-consumer` and not in a clone or
> the working tree.

`esm.mjs` — import, invoke, and check the skip guarantee:

```js
import { processImage } from 'gemini-watermark';

const width = 1024, height = 572;
const image = { data: new Uint8Array(width * height * 3), width, height, channels: 3 };
const before = Uint8Array.from(image.data);
const result = processImage(image);

console.log(result.status, result.confidence, result.attempts.map((a) => a.variant));
if (result.status !== 'skipped') throw new Error('a blank image must skip');
if (!before.every((b, i) => b === image.data[i])) throw new Error('a skip must not touch the buffer');
```

`main.ts` — the same call, plus the types a consumer actually relies on:

```ts
import { processImage } from 'gemini-watermark';
import type { ImageBuffer, ProcessResult, WatermarkVariant } from 'gemini-watermark';

const width = 1024, height = 572;
const image: ImageBuffer = {
  data: new Uint8Array(width * height * 3),
  width,
  height,
  channels: 3,
};
const result: ProcessResult = processImage(image, { threshold: 0.25 });
const variant: WatermarkVariant | undefined = result.variant;
console.log(result.status, variant);
```

```bash
npx tsc --noEmit --strict --module esnext --moduleResolution bundler \
        --target es2022 --lib es2022 --types node main.ts
node esm.mjs
npx tsx main.ts
```

All three must succeed. Expected output:

```
skipped 0 [ 'V2', 'V1' ]     # esm.mjs
skipped undefined            # main.ts — no variant on a skip, by contract
```

The `tsc` run is the one that would catch a `types` field resolving to
nothing — a failure mode no runtime test sees. The blank buffer is chosen
deliberately: it exercises the whole pipeline (both variants attempted, both
circuit-broken) and asserts the safety property that a skip returns the
caller's bytes untouched.

### 7. Land the version bump

The rehearsal's `npm version` happened in the clone. The bump lands in the
main working tree as its own commit, reviewed like any other.

## Release day

Only after the rehearsal is clean and the maintainer has said to publish.

### 1. Pre-flight

- [ ] `CHANGELOG.md` has a `## [0.1.0] - <date>` entry, the date is today,
      and `## [Unreleased]` is empty.
- [ ] `package.json` version equals the CHANGELOG's top released version.
- [ ] The compare/release links at the bottom of the CHANGELOG point at the
      version being released.
- [ ] `README.md` — scope matrix, API section and limitations still describe
      what ships. The status table has no stale "not yet" claims.
- [ ] Working tree clean, on `main`, up to date with the remote, CI green on
      that commit.
- [ ] `npm ci && npm run check` passes locally on that exact commit.
- [ ] `npm whoami` is the account that should own the package.

### 2. Publish

```bash
npm publish --access public --provenance
```

- `--provenance` links the tarball to the workflow run and commit that built
  it. It requires publishing from CI with `id-token: write` permission; from
  a laptop it will fail rather than silently publish something unattested.
  Decide which of the two you are doing before running the command, not
  after.
- `prepublishOnly` runs `npm run check` and `prepack` rebuilds `dist/`, so a
  publish from a dirty or unbuilt tree fails instead of shipping.
- The package name is not yet taken; the first publish claims it. There is no
  undo beyond a 72-hour unpublish window, so treat this as irreversible.

### 3. Tag

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Tag **after** a successful publish, so the tag never points at a version that
does not exist on the registry. The tag name must match the CHANGELOG link
anchor (`v0.1.0`).

### 4. Post-publish smoke

From a clean directory, install the published package rather than the local
tarball — this is the first time the registry, not the filesystem, is in the
loop.

```bash
mkdir /tmp/gw-published && cd /tmp/gw-published
npm init -y
npm i gemini-watermark@0.1.0
node -e "import('gemini-watermark').then(m => console.log(Object.keys(m).sort().join(' ')))"
```

Expected: the nine exported functions, and no resolution error. Then confirm
the npm page renders the README and lists the right files.

- [ ] Published version installs and imports from the registry.
- [ ] `npm view gemini-watermark` shows the expected version, license and
      file list.
- [ ] GitHub release created from the tag, body taken from the CHANGELOG
      entry.

### If something is wrong after publishing

Do not unpublish reflexively — unpublishing a version burns the version
number permanently. Publish a patch instead, and use `npm deprecate` on the
bad version if it is actively harmful.
