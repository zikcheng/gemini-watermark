/**
 * Access to the out-of-repo reference kit, for golden tests only.
 *
 * Golden tests compare against full-size reference images that are too
 * large to commit, so they live at `$GWT_REFERENCE_DIR` on the maintainer's
 * machine (see `tools/reference/README.md` for how to regenerate one).
 *
 * The contract, from M0.md: a golden test **throws** when the variable is
 * missing — it never skips. A skipped golden test looks identical to a
 * passing one in the output, which is exactly how an equivalence suite
 * silently stops proving anything. Run them with `npm run test:golden`;
 * the default `npm run test` excludes this directory entirely
 * (see `vitest.config.ts`), so the throw only fires when they were asked
 * for.
 *
 * Call it at module scope to fail collection of a whole file, or inside a
 * test to fail just that case.
 */

// Declared locally rather than pulling in @types/node: this is the only
// environment access the test suite needs so far. When a golden test needs
// real file I/O (M2 onward), add @types/node as a devDependency and drop
// this. `src/` may never do either — see tools/check-imports.mjs.
declare const process: { env: Record<string, string | undefined> };

export const REFERENCE_DIR_ENV = 'GWT_REFERENCE_DIR';

/**
 * @returns the configured reference-kit directory
 * @throws Error when {@link REFERENCE_DIR_ENV} is unset or empty
 */
export function requireReferenceDir(): string {
  const dir = process.env[REFERENCE_DIR_ENV];
  if (dir === undefined || dir.trim() === '') {
    throw new Error(
      `${REFERENCE_DIR_ENV} is not set, so golden tests cannot run.\n` +
        `  Golden tests must fail rather than skip — a skipped equivalence ` +
        `test proves nothing.\n` +
        `  Point it at a generated reference kit: ` +
        `export ${REFERENCE_DIR_ENV}=$HOME/gwt-reference\n` +
        `  See tools/reference/README.md to build one.`,
    );
  }
  return dir;
}
