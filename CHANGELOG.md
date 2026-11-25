# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[semantic versioning](https://semver.org/). The extension has its own version: a
change to the runtime range is called out in the entry that makes it.

## [Unreleased]

## [0.1.1]

A workflow can now be a directory package, so a run can follow an order that is code, and a caller with
no later turn can wait for it.

### Added

- `start` accepts a **directory package** in the conventional layout (`agents/`, `prompts/`, `models/`,
  `tools/`, `hooks/`, `handlers/`, `effects/`), loaded with the runtime's `loadSource`. A JSON workflow
  cannot carry a handler, so it cannot carry an order; a package can, and an agent side may be
  `{ handler: "run_order" }`. The package's tools are its own — the built-ins only implement names a
  JSON file can declare — and a package that references a tool it does not define is refused before the
  run exists.
- `spec.json` for such a run carries a `source` block: the directory, every definition file and its
  hash. Editing a prompt, tool or handler is a new revision and therefore a new run. `RunService.open`
  refuses these runs with `run_from_source`, because `spec.json` alone cannot rebuild the handler.
- `start` takes `wait: true`: the call returns when the run ends instead of when it begins, with the
  phase, tokens and cost the wake reports. A turn with no later chance to ask uses it; the default stays
  detached, because a PI turn that waits cannot be interrupted.
- `start` on a package wraps every provider it resolves in the journal sink, so a package that carries
  its own provider factory still has its usage measured — asserted against a package-owned factory that
  answers, reports its own tokens and takes its credential from a host-filled slot.

### Changed

- The runtime range is `^0.2.5` (from `^0.2.4`). In 0.2.5 a model with no provider factory is a warning,
  not an error, which is what lets a package name a model and leave the connection to the host.
- A model defined in a package may omit its provider. `loadSource` now reports that as a **warning**
  rather than an error: the package names the model, the host supplies the connection, and
  `RuntimeOptions.hostProviders` (runtime 0.2.5) is the seam that makes it more than registry surgery.
  The doctrine path — a package that ships its provider — is unchanged and still wins.

## [0.1.0]

A workflow can now do work, not only talk: the five tool names it may declare have implementations
shipped with the package, and a host can register the run tool under its own name.

### Added

- Built-in tool implementations for the five names a workflow file may declare — `shell`, `read`,
  `write`, `edit`, `list` — bound to the run's working directory. Until now a workflow's `tools` were
  declarations only: the implementation had to come from an embedder, and a plain PI session passed
  none, so a workflow could not touch a repository. The file tools refuse a path outside the run's
  working directory; `shell` is a real shell, as `bash` is in PI itself.
- `createStandardAgentTool(pi, { name })` registers the run tool under a host's own name, so a
  repository can supply its own tool set beside the package's `standard_agent` instead of colliding
  with it.

### Changed

- `ToolSpec` accepts a real argument schema and a schema-typed `execute`: `ToolDefinition["args"]`
  resolves to `null` at its default generic, which made a schema-carrying tool unrepresentable.
- Dependency on `@t-works/standardagents-runtime` (the Standard Agents runtime this extension
  drives) narrowed from `^0.2.1` to `^0.2.4`: what the tests run against is what a user installs.

## [0.0.1]

The first release meant for somebody else's machine: one tool, one command, one
renderer, a published tarball CI installs and loads, and a README that says what
happens rather than how it is built.

### Added

- `standard_agent` tool with four actions over one harness: `start` (answers with
  a run id and thread id, then runs detached), `status` (records plus the
  journal's usage), `message` (a human message on a run's thread) and `stop`
  (terminate the root threads; children cascade). Errors come back as results
  carrying a code, never as thrown errors.
- `/sa` command: `runs` (with `--follow` for live lines), `cost`, and
  `stop <runId>`. It reads from disk, so it answers with no run open.
- `standard-agent-run` message renderer for the completion wake: exactly one per
  run, phase, revision, turns, tokens/cost, and the last few live lines folded by
  default. A run's live lines only reach the transcript when you ask for them.
- Run directories under `.pi/standard-agents/runs/<runId>/` with a pinned
  `spec.json` and its revision, an append-only `journal.jsonl`, an advisory
  `owner.lock`, and the runtime's thread store.
- `PI_STANDARD_AGENTS_DEADLINE_MS`: the wall-clock cap the runtime does not have.
  A run that overruns is journaled `failed`/`deadline` and terminated.
- Models resolve through PI's `ctx.modelRegistry`, so PI keeps the keys and the
  extension never stores one.
- `scripts/install-from-tarball.mjs`: packs, installs the tarball into a clean
  temp directory with a pinned PI host, and loads the extension from *that*
  install — including one scripted turn, the `/sa` command and the runtime's
  `quickjs` engine. This is the gate that would catch a broken peer range or a
  dependency that does not resolve from a published tree.
- `scripts/pi-smoke.sh`: the optional real-PI check, gated behind `PI_SMOKE=1`
  plus `PI_SMOKE_PROVIDER`/`PI_SMOKE_MODEL`.
- CI on Node 22 and 24: `npm ci`, build, test, manifest gate, tarball install.
  A release job publishes on a tag with `--provenance --access public`, gated by
  the same steps.

### Changed

- `std_smoke` stays, now as the load check it always was; `standard_agent` is the
  tool that does the work.
- `dist/` ships compiled JS and declarations only — no source maps — so the
  published tarball is exactly the `files` set.
- Runtime dependency: `@t-works/standardagents-runtime@^0.2.1`. It is the range
  this repository tests and the range the tarball gate resolves; a bump here is
  what a later entry will describe.
- The manifest gate now also asserts the pinned runtime range against the
  installed copy, the doc set, and the `## [x.y.z]` heading for the version being
  released.

### Release notes

Manual proof, run once against a real session (the automated equivalent lives in
`scripts/install-from-tarball.mjs`):

```bash
pi install npm:pi-standard-agents
# in a session:
/sa runs                                 # -> No runs in .pi/standard-agents/runs
standard_agent start examples/workflow.json
#   -> <runId> triage running, then one standard-agent-run completion message
/sa cost                                 # -> the same tokens/cost as journal.jsonl
```

### Known limitation

There is no cross-process lease. `owner.lock` is advisory (pid + age, 15 minutes)
and a shared volume, a reused pid or a clock jump can defeat it. The worst case
is a stale lock, never silent corruption; one run belongs on one machine.

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
