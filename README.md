# pi-standard-agents

A [PI](https://github.com/earendil-works/pi) extension package that exposes the
Standard Agents runtime (`@t-works/standardagents-runtime`) to PI sessions:
tools, slash commands and lifecycle hooks.

This repository is built one unit at a time. U01 is the walking skeleton: an
installable package with a single tool, the fake-PI test harness every later
unit tests against, and the manifest gate.

## Layout

```
package.json               package manifest: pi.extensions -> ./dist/extension.js
tsconfig.json              src/ -> dist/, ESM, declarations, no bundler
src/extension.ts           default factory: registers tools + lifecycle hooks
test/fake-pi.ts            recorder implementing the ExtensionAPI surface we use
test/*.test.ts             node:test suites (run against dist/)
scripts/check-manifest.mjs the manifest gate CI runs after the build
dist/                      build output; this is what PI loads and npm ships
```

## Install

```bash
npm install pi-standard-agents
```

PI discovers `./dist/extension.js` through the `pi.extensions` field of
`package.json`. Load it explicitly in a session with:

```bash
pi -e ./dist/extension.js
```

## The one tool

`std_smoke` takes an optional `note` and returns the fixed string
`pong from pi-standard-agents`. It exists to prove the path
default factory → tool registration → execute → result before any runtime code
exists.

## Development

```bash
npm install --no-audit --no-fund
npm run build                      # tsc: src/ -> dist/
npm test                           # node --test test/ (offline, no model calls)
node scripts/check-manifest.mjs    # manifest + dist gate
npm pack --dry-run --json          # what gets published
```

`npm test` never reaches a model. The optional real-PI check is gated behind
`PI_SMOKE=1` plus `PI_SMOKE_PROVIDER` / `PI_SMOKE_MODEL`, so CI names one cheap
model explicitly instead of relying on ambient credentials.

## Rules this package follows

- The extension ABI is a **default factory**, sync or async. A named `activate`
  export fails to load: `Extension does not export a valid factory function`.
- `@t-works/standardagents-runtime` is a regular dependency; PI host packages
  (`@earendil-works/pi-*`, `typebox`) are peers, supplied by PI at runtime.
- Nothing is bundled: no `.wasm`, no runtime source in `dist/`.
- `dist` is what PI loads, so CI builds before it tests and the manifest gate
  reads `dist`, never `src`.

## License

MIT — see [LICENSE](LICENSE).
