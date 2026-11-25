# pi-standard-agents

A [PI](https://github.com/earendil-works/pi) extension that turns a JSON workflow file into a running
team of [Standard Agents](https://github.com/standardagents) agents, without ever blocking your PI
turn. You ask for a run in one tool call, get a run id back immediately, and the agents keep working
in the background — each model call resolved through PI's own model registry and credentials, every
run recorded under `.pi/standard-agents/runs/`, and one completion message when it ends. You can
inspect a run (`/sa runs`, `/sa cost`), post a human message onto its thread, stop it, or follow its
live lines; nothing runs until you start it, and the whole thing is a single extension file PI loads
through `pi.extensions`.

## Install

```bash
pi install npm:pi-standard-agents
```

That is the whole install: PI supplies the host packages (`@earendil-works/pi-coding-agent`,
`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `typebox`) as peers, and the Standard
Agents runtime (`@t-works/standardagents-runtime`, the engine that runs the agents) comes in as this
package's own dependency. To try a checkout instead:

```bash
npm install --no-audit --no-fund && npm run build
pi -e ./dist/extension.js
```

Requirements: Node **≥ 22.18**, and a PI version that accepts a default-factory extension.

## What you get

| Surface | Name | What it does |
| --- | --- | --- |
| Tool | `standard_agent` | `start` / `status` / `message` / `stop` one run. `start` answers with a run id and a thread id in milliseconds, or blocks until the run ends when the caller passes `wait: true`. |
| Command | `/sa` | `runs` (add `--follow` for live lines), `cost`, `stop <runId>`. Answers from disk, so it works when no run is live. |
| Message | `standard-agent-run` | The completion wake: phase, revision, turns, tokens/cost and the last few live lines, folded by default. |
| Tool | `std_smoke` | Returns a fixed string. Only there to prove the extension loaded and is reachable. |

## A workflow file

A workflow is data: an id, model names, prompts, and the agents that use them. `sides.a` is the
model side, `sides.b.human` means "you are the other side". Below is a complete one — it lives at
[`examples/workflow.json`](examples/workflow.json), and
[`examples/library/`](examples/library) shows the prompt-library form.

```json
{
  "id": "support-triage",
  "models": [{ "name": "fast", "model": "gpt-4o-mini" }],
  "prompts": [
    {
      "name": "shared_system",
      "toolDescription": "Shared behaviour every agent in this workflow follows",
      "prompt": "You are part of one team. Answer in the user's language and never invent policy.",
      "model": "fast"
    },
    {
      "name": "triage",
      "toolDescription": "Route a support request to the specialist who can answer it",
      "prompt": [
        { "type": "text", "content": "You triage incoming support requests.\n\n" },
        { "type": "include", "prompt": "shared_system" }
      ],
      "model": "fast",
      "includeChat": true
    }
  ],
  "agents": [
    {
      "name": "triage",
      "title": "Support Triage",
      "description": "Front door: understands the request and routes it",
      "sides": { "a": { "prompt": "triage" }, "b": { "human": true } }
    }
  ]
}
```

`models[].name` is the name the workflow uses; `models[].model` is the model id PI resolves. PI owns
the registry and the keys, so a workflow file never carries a credential.

Start it from a PI session, either by asking for the tool or by naming the file:

```
standard_agent start examples/workflow.json
```

```
triage-1a2b3c4d triage running
```

The tool answers while the turn is still running — that is the point. The run ends with one
completion message:

```
standard-agent run triage-1a2b3c4d idle: 4120 tokens over 6 call(s) $0.0042
```

Then, depending on what you want next:

```
/sa runs                 # every run on disk, with its phase and token total
/sa cost                 # the same, cost-first (matches the journal)
/sa runs --follow        # stream a run's live lines into the transcript
/sa stop triage-1a2b3c4d # terminate the root threads; children cascade
```

Deadline: the runtime has no wall-clock cap of its own, so the host sets one. Leave
`PI_STANDARD_AGENTS_DEADLINE_MS` unset for an unattended run with no horizon, or set it (e.g.
`PI_STANDARD_AGENTS_DEADLINE_MS=900000`) and a run that overruns is recorded as `failed`/`deadline`
and terminated.

## A workflow directory

A JSON file can name agents and prompts, but it cannot carry code — so it cannot carry an **order**. A
directory in the [conventional layout](https://github.com/standardagents) can:

```
factory/workflow/
  agents/order.ts        side A is a handler, side B the operator
  handlers/run_order.ts  the order itself: preflight, run, gate, advance, stop
  prompts/*.ts  models/*.ts  tools/*.ts  hooks/*
```

`standard_agent start <dir>` loads it with the runtime's own `loadSource`, so handlers, tools and hooks
run exactly as the package wrote them. An agent's side may therefore be `{ handler: "run_order" }`, and
the run's order is code instead of a paragraph a model is asked to remember.

What differs from the JSON form, and only this:

- **The package's tools are its own.** The five built-ins implement declarations a JSON file can only
  name; injecting them here would shadow a package that ships its own `shell`. Declare a tool the
  package does not define and the run is refused before it starts.
- **The pinned record names the files.** `spec.json` gets a `source` block with every definition file
  and its hash, because code cannot be data. Editing any of them is a new revision, so it is a new run
  — the same rule a JSON spec gets by content.
- **Reopening means loading the directory.** `RunService.open` refuses a run that came from a package
  (`run_from_source`): hydrating `spec.json` alone would rebuild a registry with no handler, and the
  order would silently disappear.

### A model the host owns

The doctrine binds a model to the package: `models/vendor.ts` imports its provider, and the consumer
supplies the credential through the slots that provider declares — never from the package. When a
package would rather not carry a vendor dependency at all, it names the model and lets the host dial:

```ts
// models/fast.ts — no provider, no key, no vendor import
export default { name: "fast", model: "deepseek/deepseek-flash" };
```

The loader reports this as a **warning**, not an error, and the runtime resolves it from
`RuntimeOptions.hostProviders` first, then the registry. If neither has a factory the run fails naming
the model, not with a stack trace from the first turn. That is the escape path; the doctrine path
above needs no host cooperation at all.

Use the directory when the workflow is a process; use a JSON file when it is a conversation.

## Waiting for a run

`start` is detached because a PI turn that waits cannot be interrupted. A caller with no later turn —
a script, a scheduler, one `pi -p` process per drain — passes `wait: true` and gets the ending instead
of the opening:

```
main-1a2b3c4d planner idle: 4120 tokens over 6 call(s) $0.0042
```

The wait resolves on the same ending the completion wake reports: a settle, `failed`/deadline, or a
`stop`. Nothing outside the process can poll a run into completion, because the threads live in it —
so this is the only shape in which an unattended drain keeps PI's model registry and the journal.

## Where runs live

```
.pi/standard-agents/runs/<runId>/
  spec.json         the pinned spec and its revision (sha256 of the spec, first 12 chars)
  journal.jsonl     append-only usage: one JSON object per line
  owner.lock        the advisory owner claim (pid + start time)
  store/
    threads/<threadId>/thread.json     state, reason, children, termination
    threads/<threadId>/messages.json   the thread's own conversation
```

Everything is a file, so a later process can pick a run up: a run keeps the spec it was created
with, and a *changed* spec is a new run directory, never an edit underneath a live one.

## What is sent to the model

Only what the workflow declares, plus the thread's own conversation:

- the system prompt the workflow's prompt renders — its `text` parts and any `include`s, in order;
- the thread's message history from `messages.json` (limited by `includeChat` where a prompt sets it);
- the tools the workflow declares for that agent;
- the task text you passed to `start`, or a `message` you posted.

PI's own built-in tools are not added on your behalf, and no file from your repository is read unless
a workflow tool reads it. Each model call goes through PI's `ctx.modelRegistry`, so the key PI already
holds is used and never copied into the run directory.

## Tools a workflow may declare

A workflow file is data, so it can only *name* a tool: `"tools": [{ "name": "shell", "description": "run a
command" }]` at the top level, and `"tools": ["shell"]` on the prompt that may call it. This package
supplies the implementations for five names, so a run needs no host code:

| Name | What it does |
| --- | --- |
| `shell` | one command in the run's working directory; the exit code and the raw tail of its output (a non-zero exit is a result, not a tool failure) |
| `read` | a text file inside that directory, truncated with a note when it is large |
| `write` | one whole file, parent directories created |
| `edit` | one exact passage, refused when it occurs zero or several times |
| `list` | names under a directory, directories with a trailing slash, `.git` / `node_modules` / `.pi` skipped |

Declaration is the whole grant: a workflow that names none of these gets none of them, and nothing is
added on an agent's behalf. The fence is the run's working directory — `shell` is a real shell that can
write anywhere, the four file tools refuse a path outside it. A name that nothing implements fails at
run start, naming the prompt and the tool, so a typo is caught before the first model call.

A host may override any of these or add its own by passing `tools` to `createStandardAgentTool`, and may
register the tool under its own name (`{ name: "factory_agent", tools }`) so it sits beside this
package's `standard_agent` rather than colliding with it.

## What is journaled

`journal.jsonl` is append-only and holds four row kinds: `model_call` (provider, model, token usage
and cost, exactly as reported), `tool` (name, status, duration, one-line redacted summary), `status`
(lifecycle markers such as `running`, `failed`/`deadline`) and `usage_total` (the closing aggregate,
written when the journal closes).

Two rules keep it honest:

- **Unknown is not zero.** A provider that reports no usage produces `usage: null` and a run total
  marked `partial`, because "we did not measure it" and "it was free" are different facts.
- **Request bodies never reach a row.** Prompts, message bodies and interpolated secrets stay out of
  the journal; the fields are an allowlist, not a filter.

`/sa cost` reads this file, which is why its numbers match a run nobody has open.

## Dependency on the runtime

`@t-works/standardagents-runtime` is a regular dependency, pinned to the range this repository tests
(currently **`^0.2.5`**). It is not bundled: `dist/` holds our own compiled code only, and the
runtime — with the `quickjs` engine it uses for sandboxed tool code — is loaded from `node_modules`.
A runtime bump is a changelog entry in its own right, because narrowing or widening that range
changes what a user installs underneath this extension.

The host packages are peers with `"*"`: PI already has them, and shipping a second copy would give
you two `ExtensionAPI`s.

## One thing this does not do

**There is no cross-process lease.** `owner.lock` is advisory: it names a pid and a start time, and a
second process honours it only while that pid is alive and the lock is younger than 15 minutes. A
reused pid, a container with a shared volume, or a clock jump defeats that check. The worst case is a
stale lock — the run looks busy and a human removes the file — never silent corruption of a thread's
`messages.json`, because the single-writer rule is enforced inside one process. If you need more than
that, one run belongs on one machine.

## Development

```bash
npm install --no-audit --no-fund
npm run build                       # tsc: src/ -> dist/ (no source maps in the tarball)
npm test                            # node --test test/ (offline, no model calls)
npm run check:manifest              # manifest + dist gate
npm run verify:install              # pack, install the tarball in a temp dir, load it there
npm run smoke                       # real PI, off unless PI_SMOKE=1 (see below)
```

`npm test` runs the `.ts` sources directly while `tsc` emits `dist/`, so relative imports inside
`src/` carry the real `.ts` extension; `allowImportingTsExtensions` +
`rewriteRelativeImportExtensions` turn them back into `.js` on emit.

`npm run verify:install` is the only automated proof that the *published* tree works: it runs
`npm pack`, installs the tarball into a clean temp directory together with a pinned PI host and
`typebox`, and loads the extension from there. `dist` is what PI loads, so CI builds before it tests
and every gate reads `dist`, never `src`.

`npm run smoke` is the optional real-PI check, gated behind `PI_SMOKE=1` plus
`PI_SMOKE_PROVIDER` / `PI_SMOKE_MODEL`: CI names one cheap model explicitly instead of relying on
whatever credentials happen to be on the machine.

## License

MIT — see [LICENSE](LICENSE).
