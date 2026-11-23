# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[semantic versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

### Added

- Walking skeleton: a PI extension loaded through `pi.extensions` as a default
  factory (`dist/extension.js`).
- One tool, `std_smoke`, that returns the fixed string
  `pong from pi-standard-agents`, proving factory → registration → execute →
  result end to end.
- `session_start` / `session_shutdown` handlers that touch nothing yet, so the
  lifecycle wiring is proven before the runtime moves in.
- `test/fake-pi.ts`: a recorder implementing the `ExtensionAPI` surface the
  extension uses, plus a `ctx` stub.
- `scripts/check-manifest.mjs`: asserts the built tree, the runtime dependency
  and the peer host packages before publishing.
