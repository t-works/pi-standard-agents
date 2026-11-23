#!/usr/bin/env bash
# The real-PI check. Off by default: `npm test` must stay offline and
# credential-free, so every model call here is gated behind PI_SMOKE=1 plus an
# explicitly named provider and model.
#
#   PI_SMOKE=1 PI_SMOKE_PROVIDER=deepseek PI_SMOKE_MODEL=deepseek-flash \
#     ./scripts/pi-smoke.sh
#
# It proves three things a fake recorder cannot:
#   1. a default factory that throws fails to load with
#      `Failed to load extension: boom-from-factory` and a non-zero exit
#   2. PI loads ./dist/extension.js, the model calls `standard_agent`, and the
#      turn streams a clean `tool_execution_end` for it (no error, empty stderr)
#   3. `std_smoke` is still reachable, so the plain extension path never regresses
#
# What this script deliberately does not assert: `/sa`. PI's print mode treats a
# leading `/` as prompt text, not as a command, so the command's handler is
# exercised where it can be — `scripts/install-from-tarball.mjs` invokes it
# offline against the installed package — and by hand in the release notes.
set -euo pipefail

if [[ "${PI_SMOKE:-}" != "1" ]]; then
	echo "pi-smoke: skipped (set PI_SMOKE=1, PI_SMOKE_PROVIDER and PI_SMOKE_MODEL to run)"
	exit 0
fi

: "${PI_SMOKE_PROVIDER:?pi-smoke: set PI_SMOKE_PROVIDER to a provider name}"
: "${PI_SMOKE_MODEL:?pi-smoke: set PI_SMOKE_MODEL to a model id}"

if ! command -v pi >/dev/null 2>&1; then
	echo "pi-smoke: the pi CLI is not on PATH" >&2
	exit 1
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

out=$(mktemp)
err=$(mktemp)
trap 'rm -f "$out" "$err"' EXIT

# PI loads extensions from dist/, so the build has to be current.
npm run build >/dev/null

# 1. Negative fixture: a throwing factory must not load.
if pi --offline -a -e ./test/fixtures/throwing-factory.mjs --mode json --no-session -ne \
	-p "reply with ok" </dev/null >"$out" 2>"$err"; then
	echo "pi-smoke: a throwing extension factory must make pi exit non-zero" >&2
	exit 1
fi
if ! grep -q "Failed to load extension: boom-from-factory" "$err"; then
	echo "pi-smoke: expected 'Failed to load extension: boom-from-factory' on stderr, got:" >&2
	cat "$err" >&2
	exit 1
fi

# 2. The tool that does the work: the model has to call `standard_agent`, and the
# call has to end without an error. A started run continues in the background, so
# only the tool call is asserted here — never the run's own outcome.
if ! pi --offline -a -e ./dist/extension.js --mode json --no-session -ne \
	--provider "$PI_SMOKE_PROVIDER" --model "$PI_SMOKE_MODEL" -t standard_agent \
	-p "Call the standard_agent tool exactly once with action 'start', workflow 'examples/workflow.json' and task 'Say hello'. Then reply with the run id it returned." \
	</dev/null >"$out" 2>"$err"; then
	echo "pi-smoke: pi exited non-zero" >&2
	cat "$err" >&2
	exit 1
fi

if [[ -s "$err" ]]; then
	echo "pi-smoke: expected empty stderr, got:" >&2
	cat "$err" >&2
	exit 1
fi

if ! grep -q '"type":"tool_execution_end"[^\n]*"toolName":"standard_agent"' "$out"; then
	echo "pi-smoke: no tool_execution_end for standard_agent in the JSONL stream" >&2
	cat "$out" >&2
	exit 1
fi

if grep -q '"isError":true' "$out"; then
	echo "pi-smoke: the standard_agent tool call reported an error" >&2
	cat "$out" >&2
	exit 1
fi

# 3. The extension path itself: one cheap call to the ping tool.
if ! pi --offline -a -e ./dist/extension.js --mode json --no-session -ne \
	--provider "$PI_SMOKE_PROVIDER" --model "$PI_SMOKE_MODEL" -t std_smoke \
	-p "Call the std_smoke tool exactly once, then reply with the text it returned." \
	</dev/null >"$out" 2>"$err"; then
	echo "pi-smoke: pi exited non-zero" >&2
	cat "$err" >&2
	exit 1
fi

if [[ -s "$err" ]]; then
	echo "pi-smoke: expected empty stderr, got:" >&2
	cat "$err" >&2
	exit 1
fi

if ! grep -q '"type":"tool_execution_end"[^\n]*"toolName":"std_smoke"' "$out"; then
	echo "pi-smoke: no tool_execution_end for std_smoke in the JSONL stream" >&2
	cat "$out" >&2
	exit 1
fi

if grep -q '"isError":true' "$out"; then
	echo "pi-smoke: the std_smoke tool call reported an error" >&2
	cat "$out" >&2
	exit 1
fi

echo "pi-smoke: ok (real pi loaded dist/extension.js, ran standard_agent and std_smoke)"
