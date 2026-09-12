/**
 * Build config for dsh-ai-novel-copilot.
 *
 * Two artifacts, one `lib/`:
 * - `lib/index.js` — the host half. An ordinary ESM cordis plugin the DSH
 *   Loader imports directly.
 * - `lib/client.js` — the browser half. DSH's client-modules scanner reads this
 *   file verbatim and serves it under `/plugins/??<pkg>/client.js`, so it must
 *   match the framework's closure-factory protocol exactly: a CJS bundle whose
 *   banner registers a factory with `window.__ModuleLoader__` and whose
 *   `require` is answered by the shell's frozen module table.
 *
 * This file deliberately reproduces the in-repo preset
 * (`packages/client/tsdown.client.ts`) instead of importing it: that preset
 * resolves each package's manifest through `packages/*​/*​/package.json` inside
 * the DSH checkout, which an out-of-tree package can never satisfy. The
 * artifacts — not the preset — are the contract.
 */
import type { UserConfig } from 'tsdown'

/** Package name; doubles as the module-table id in the boot graph. */
const ID = 'dsh-ai-novel-copilot'

/**
 * Specifiers the shell shares into its frozen module table
 * (mirrors `PLATFORM_MODULES` in `packages/client/web/src/platform.ts`).
 * Everything else must be inlined: a `require()` the table cannot answer is a
 * guaranteed runtime throw.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/** Host half: the Node-side cordis plugin. */
const host: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  // The Loader imports the path package.json names, so the artifact must stay
  // exactly `lib/index.js` rather than an extension-fixed `.mjs`.
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
}

/** Browser half: the closure-factory bundle the module loader executes. */
const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  // Requested module-table rows stay imports; everything else is inlined.
  deps: { neverBundle: PLATFORM_MODULES },
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
