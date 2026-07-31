# Browser example

A single page that removes a Gemini watermark client-side: pick a file, get
a PNG back. Nothing is uploaded, and there is no bundler in the loop —
`index.html` uses an [import map] to point the bare specifier
`gemini-watermark` at the built ESM bundle, which is the whole claim the
package makes about browsers.

## Run it

```bash
npm run build                 # produces dist/index.js, what the import map loads
npx tsc -p examples/browser   # compiles main.ts to examples/browser/dist/main.js
npx http-server . -p 8080     # any static server, from the repository root
```

Then open <http://localhost:8080/examples/browser/>. A server is needed
because browsers refuse ES-module imports over `file://`.

## What to read it for

Three lines carry almost all of the risk, and they are the reason this
example exists rather than a snippet in the README:

- **`colorSpaceConversion: 'none'`** — without it the browser converts the
  image's embedded colour profile while decoding, which changes pixel
  values. Detection correlates against a calibrated template and removal
  inverts an alpha blend; both read the exact bytes, so a colour transform
  lowers the confidence and leaves a residue behind.
- **`imageOrientation: 'from-image'`** — geometry is derived from the image
  dimensions, so an EXIF-rotated buffer sends the detector to the wrong
  corner.
- **`channels: 4` over `getImageData().data`** — the engine works in place
  on that array, so the canvas takes the result back with no copy, and the
  alpha channel passes through untouched.

The page also shows the per-attempt scores, which is the clearest way to see
the V2→V1 fallback: a V1 image circuit-breaks on the V2 attempt (spatial
`0.000`) before V1 scores `1.000`.

## Not part of the package

`files` in `package.json` publishes `dist`, `LICENSE` and `README.md` only,
so nothing here ships to npm. `npm run check` typechecks it against
`dist/index.d.ts` — the same declarations a consumer installs.

[import map]: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/script/type/importmap
