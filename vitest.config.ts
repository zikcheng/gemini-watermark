import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Three disjoint suites share one runner, because two of them need
 * something a bare checkout does not have.
 *
 * The **default** run is self-contained: only data committed under
 * `test/data/`, so CI runs it on any machine with `npm ci`.
 *
 * **Golden** tests read the full-size reference kit from
 * `$GWT_REFERENCE_DIR`, which deliberately lives outside the repository
 * (PLAN.md: keep large binaries out). **Browser** tests need a built
 * `dist/` and a downloaded Chromium, neither of which a contributor should
 * have to provide just to run the unit tests.
 *
 * Both would fail on every machine lacking their prerequisite, so each is
 * excluded from the default run and opted into by its own script:
 * `npm run test:golden` (GWT_GOLDEN=1) and `npm run test:browser`
 * (GWT_BROWSER=1). That opt-in is what makes "these suites **throw** when
 * their prerequisite is missing, never skip" safe — a skipped equivalence
 * test looks exactly like a passing one, so the throw only ever fires in a
 * run that asked for it.
 *
 * Note: both scripts set their variable with POSIX inline-env syntax, which
 * cmd.exe does not understand. Supported platforms are macOS (dev) and
 * ubuntu (CI) per PLAN.md, and adding cross-env for scripts CI runs on
 * ubuntu is not worth a dependency. On Windows, set the variable manually
 * and invoke vitest directly.
 */
const goldenRun = process.env.GWT_GOLDEN === '1';
const browserRun = process.env.GWT_BROWSER === '1';

/** The opt-in directories, excluded from the default run. */
const OPT_IN = ['test/golden/**', 'test/browser/**'];

function include(): string[] {
  if (goldenRun) return ['test/golden/**/*.test.ts'];
  if (browserRun) return ['test/browser/**/*.test.ts'];
  return ['test/**/*.test.ts'];
}

export default defineConfig({
  test: {
    include: include(),
    exclude:
      goldenRun || browserRun
        ? [...configDefaults.exclude]
        : [...configDefaults.exclude, ...OPT_IN],
  },
});
