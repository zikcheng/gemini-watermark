/**
 * Proof that the built package actually runs in a browser.
 *
 * "Zero dependencies, environment-agnostic, runs in browsers" is the
 * package's headline claim, and until now it has been argued rather than
 * observed: `tools/check-imports.mjs` scans the *source* for Node and DOM
 * access, and every other suite runs the TypeScript through Vitest in
 * Node. Neither watches the **built** `dist/index.js` load in Chromium. A
 * bundler flag, a polyfill pulled in by a dependency, a `process.env`
 * introduced downstream of the scan — each would leave the whole suite
 * green and the browser claim false.
 *
 * So this loads the real artefact over HTTP with a bare
 * `import '/dist/index.js'`, runs `processImage` there, and compares the
 * sha256 of the resulting pixels against the value Node computed from the
 * same input bytes. Identical hashes mean identical arithmetic on a
 * different engine — not merely "it did not throw".
 *
 * Not part of `npm run check`: it needs `npm run build` to have run and a
 * Chromium to have been downloaded, and a contributor running unit tests
 * should need neither. `npm run test:browser` opts in; CI runs it as its
 * own job (see `.github/workflows/ci.yml`).
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { processImage } from '../../src/index.js';
import type { ImageBuffer, ProcessResult } from '../../src/index.js';
import { caseImage } from '../helpers/cases.js';
import { startSmokeServer, type SmokeServer } from './server.js';

/** Chromium launch, page load and one 3 MB transfer, on a cold CI runner. */
const BROWSER_TIMEOUT = 120_000;

const DIST = join(import.meta.dirname, '..', '..', 'dist', 'index.js');

/**
 * Fail — never skip — when the artefact under test has not been built.
 *
 * Same contract as `requireReferenceDir`: a smoke test that quietly does
 * nothing is worse than one that is absent, because it reports success.
 */
function requireBuiltBundle(): string {
  if (!existsSync(DIST)) {
    throw new Error(
      `dist/index.js is missing, so the browser smoke test has nothing to load.\n` +
        `  It tests the built artefact, not the source — run \`npm run build\` first.\n` +
        `  (\`npm run test:browser\` is the opt-in scope; \`npm run check\` does not include it.)`,
    );
  }
  return DIST;
}

/**
 * The two cases, chosen for what they exercise rather than for size.
 *
 * `v2-small-1376x768` is the one processed case whose 48px template is not
 * baked data: it is resampled from the 96px source at call time, so this
 * run covers the resize kernel, the base64 alpha decode, all three
 * detection stages and the reverse blend. `clean-1024x572` covers the
 * property that matters most to a browser consumer — an image that is not
 * watermarked comes back byte for byte, so a file picker plus this library
 * cannot silently corrupt someone's photo.
 */
const CASES = [
  { name: 'v2-small-1376x768', expected: 'processed' },
  { name: 'clean-1024x572', expected: 'skipped' },
] as const;

const sha256 = (bytes: Uint8Array | Uint8ClampedArray): string =>
  createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');

interface BrowserOutcome {
  bytes: number;
  before: string;
  after: string;
  status: string;
  confidence: number;
  variant: string | null;
  size: string | null;
  region: { x: number; y: number; width: number; height: number } | null;
  attempts: string[];
}

/** What Node gets for the same case, computed the same way. */
function nodeOutcome(name: string): { input: ImageBuffer; before: string; after: string; result: ProcessResult } {
  const image = caseImage(name, 'watermarked');
  const before = sha256(image.data);
  const result = processImage(image);
  return { input: image, before, after: sha256(image.data), result };
}

describe('the built bundle in Chromium', () => {
  const expectations = new Map<string, ReturnType<typeof nodeOutcome>>();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  let browser: Browser;
  let page: Page;
  let server: SmokeServer;

  beforeAll(async () => {
    requireBuiltBundle();

    // Reconstruct once, on the Node side, and hand the browser the exact
    // same bytes. Any difference in what the two engines *received* would
    // otherwise be indistinguishable from a difference in what they
    // computed.
    const pixels = new Map<string, Uint8Array>();
    for (const { name } of CASES) {
      const outcome = nodeOutcome(name);
      expectations.set(name, outcome);
      pixels.set(name, Uint8Array.from(caseImage(name, 'watermarked').data));
    }

    server = await startSmokeServer(pixels);
    browser = await chromium.launch();
    page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto(`${server.origin}/page.html`, { waitUntil: 'load' });
    // The module script is deferred, so the import has to have resolved
    // before anything can be called. A failed import never sets this — and
    // a bare "waitForFunction timed out" would say nothing about why, so
    // the page's own errors are attached to the failure. That message is
    // the whole diagnostic a CI reader gets when the bundle stops being
    // loadable in a browser.
    try {
      await page.waitForFunction('window.__ready === true', undefined, { timeout: 30_000 });
    } catch (cause) {
      const reported = [...pageErrors, ...consoleErrors];
      throw new Error(
        `the page never finished importing /dist/index.js.\n` +
          (reported.length > 0
            ? `  the browser reported:\n${reported.map((line) => `    ${line}`).join('\n')}`
            : `  the browser reported nothing, so suspect the page or the server, not the bundle`),
        { cause },
      );
    }
  }, BROWSER_TIMEOUT);

  afterAll(async () => {
    // Browser first, then server, so nothing is still requesting from a
    // socket that has gone away. `finally` because a failing `close` must
    // not leak the listening port into the rest of the run.
    try {
      await browser?.close();
    } finally {
      await server?.close();
    }
  });

  it('imported the bundle without an error on the page', () => {
    // Checked before anything else: an import that half-failed can still
    // let a later assertion pass for the wrong reason.
    expect(pageErrors, 'uncaught errors on the page').toEqual([]);
    expect(consoleErrors, 'console errors on the page').toEqual([]);
  });

  for (const { name, expected } of CASES) {
    it(
      `${name} produces byte-identical output to Node`,
      async () => {
        const node = expectations.get(name);
        expect(node, `${name} was prepared`).toBeDefined();
        if (node === undefined) return;

        // `globalThis`, not `window`: the project's `lib` is ES2022 with no
        // DOM, deliberately, and the two are the same object on a page.
        const outcome: BrowserOutcome = await page.evaluate(
          ({ caseName, width, height, channels }) =>
            (
              globalThis as unknown as {
                runCase: (n: string, w: number, h: number, c: number) => Promise<BrowserOutcome>;
              }
            ).runCase(caseName, width, height, channels),
          {
            caseName: name,
            width: node.input.width,
            height: node.input.height,
            channels: node.input.channels,
          },
        );

        // The same input reached both engines...
        expect(outcome.bytes, 'byte count').toBe(node.input.data.length);
        expect(outcome.before, 'input hash').toBe(node.before);

        // ...and both reached the same verdict about it...
        expect(outcome.status).toBe(expected);
        expect(outcome.status).toBe(node.result.status);
        expect(outcome.confidence).toBe(node.result.confidence);
        expect(outcome.variant).toBe(node.result.variant ?? null);
        expect(outcome.size).toBe(node.result.size ?? null);
        expect(outcome.region).toEqual(node.result.region ?? null);
        expect(outcome.attempts).toEqual(node.result.attempts.map((a) => a.variant));

        // ...and wrote the same pixels. This is the assertion the whole
        // job exists for: one hash over every byte, so a single channel
        // differing anywhere in the image fails it.
        expect(outcome.after, 'output hash').toBe(node.after);

        if (expected === 'skipped') {
          // Stated separately from the hash comparison because it is a
          // different promise: not "the same as Node" but "unchanged".
          expect(outcome.after, 'a skipped image is untouched').toBe(outcome.before);
        } else {
          expect(outcome.after, 'a processed image actually changed').not.toBe(outcome.before);
        }
      },
      BROWSER_TIMEOUT,
    );
  }

  it('covers both a processed and a skipped case', () => {
    expect(CASES.map((c) => c.expected).sort()).toEqual(['processed', 'skipped']);
  });

  it('ran every case without an error on the page', () => {
    // The import-time check above cannot see this: a `console.error` raised
    // *during* `runCase` — a caught-and-logged failure, a deprecation the
    // engine trips over — would otherwise go unreported, because the hashes
    // can still match while the page complains. Declared last so it observes
    // everything the case tests produced.
    expect(pageErrors, 'uncaught errors on the page').toEqual([]);
    expect(consoleErrors, 'console errors on the page').toEqual([]);
  });
});
