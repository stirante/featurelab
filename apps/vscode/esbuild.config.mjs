// esbuild.config.mjs -- builds both halves of the extension:
//   - src/extension.ts -> dist/extension.js   (Node, CJS, runs in the extension host)
//   - webview/main.ts  -> dist/webview.js/.css (browser, ESM, runs inside the webview)
// The webview build bundles featurelab-frontend (and therefore three.js) INTO webview.js --
// nothing the webview loads comes from anywhere but this extension's own dist/, which is
// what "bundle three.js locally, no CDN" and the webview's CSP (script-src 'nonce-...' only,
// no remote origins) both require.
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  // Prefer a package's ESM entry over its CJS/UMD one. Not a preference -- jsonc-parser's
  // `main` is a UMD bundle whose wrapper calls factory(require, exports), so the four
  // require("./impl/...") calls inside it are made through a FUNCTION PARAMETER that esbuild
  // cannot analyse statically. They survive bundling, resolve against dist/ at run time, and
  // throw MODULE_NOT_FOUND while the extension host is activating -- which registers no
  // commands and surfaces as "command 'featurelab.previewFeature' not found". Its `module`
  // entry is plain ESM and bundles properly. Safe to flip: featurelab-frontend, the only
  // other dependency, has an `exports` map, which outranks mainFields.
  mainFields: ['module', 'main'],
  sourcemap: true,
  logLevel: 'info',
}

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview/main.ts'],
  outfile: 'dist/webview.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2021',
  sourcemap: true,
  logLevel: 'info',
}

/** The node editor's webview. A second entry rather than a route inside webview/main.ts: the
 * two share no code, and bundling the graph editor into the preview would make every preview
 * pay for it. @type {esbuild.BuildOptions} */
const graphConfig = {
  entryPoints: ['webview/graph.ts'],
  outfile: 'dist/graph.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2021',
  sourcemap: true,
  logLevel: 'info',
}

async function run() {
  if (watch) {
    const [extCtx, webCtx, graphCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
      esbuild.context(graphConfig),
    ])
    await Promise.all([extCtx.watch(), webCtx.watch(), graphCtx.watch()])
    console.log('esbuild watching for changes...')
    return
  }
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig), esbuild.build(graphConfig)])
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
