import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Two disjoint test suites share one runner.
 *
 * The default run is self-contained: it uses only data committed under
 * `test/data/`, so CI can run it on a bare checkout. Golden tests are
 * different — they read the full-size reference kit from
 * `$GWT_REFERENCE_DIR`, which deliberately lives outside the repository
 * (PLAN.md: keep large binaries out). If they were part of the default
 * run they would fail on every machine that has no kit, so they are
 * excluded unless `npm run test:golden` opts in by setting GWT_GOLDEN=1.
 *
 * That opt-in is what makes "golden tests throw when GWT_REFERENCE_DIR is
 * missing" safe: the throw only ever fires in a run that asked for them.
 *
 * Note: `test:golden` sets the variable with POSIX inline-env syntax,
 * which cmd.exe does not understand. Supported platforms are macOS (dev)
 * and ubuntu (CI) per PLAN.md, and adding cross-env for a script that
 * never runs in CI is not worth a dependency. On Windows, set the
 * variable manually and invoke vitest directly.
 */
const goldenRun = process.env.GWT_GOLDEN === '1';

export default defineConfig({
  test: {
    include: goldenRun ? ['test/golden/**/*.test.ts'] : ['test/**/*.test.ts'],
    exclude: goldenRun
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, 'test/golden/**'],
  },
});
