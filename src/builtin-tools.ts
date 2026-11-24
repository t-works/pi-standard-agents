/**
 * The tools a workflow file may declare: `shell`, `read`, `write`, `edit`, `list`.
 *
 * A workflow is data, so it can only *name* a tool — `tools: [{ name, description }]`
 * is the grant. Somebody has to hold the implementation, and until now that meant an
 * embedder: a plain PI session passed none, so a workflow that declared a tool could
 * not run it. These are the implementations for the five names, which is the whole of
 * what an agent needs to work a repository.
 *
 * Declaration is the only grant. A workflow that names none of these gets none of
 * them, nothing is added on the agent's behalf, and a name that is not in this file
 * stays unimplemented — `loadWorkflow` drops it and the prompt that names it fails
 * validation at run start, which is the honest outcome for a typo.
 *
 * Filesystem scope: every path resolves inside the run's working directory, and one
 * that escapes it is refused rather than clamped. `shell` is a real shell in that
 * directory — it can still write anywhere, exactly as `bash` can in PI itself. The
 * file tools are the ones with a fence.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import type { ToolResult } from "@standardagents/spec";
import type { ToolSpec } from "./registry.ts";

/** The names this module implements. A workflow may declare any subset. */
export const BUILTIN_TOOL_NAMES = ["shell", "read", "write", "edit", "list"] as const;

/** Longest command output one call returns; the tail is what a failure is read from. */
const SHELL_TAIL = 8_000;
/** A file read stops here; a bigger file is a job for `shell` and a filter. */
const READ_MAX_CHARS = 60_000;
const READ_MAX_LINES = 2_000;
/** One list call, so a repository root cannot flood a context. */
const LIST_MAX_ENTRIES = 400;
const SKIP_DIRS = new Set([".git", "node_modules", ".pi"]);

const ok = (result: string): ToolResult => ({ status: "success", result });
const bad = (error: string): ToolResult => ({ status: "error", error });

function tail(text: string, limit = SHELL_TAIL): string {
	const trimmed = text.trimEnd();
	return trimmed.length > limit ? `…[trimmed, last ${limit} chars]\n${trimmed.slice(-limit)}` : trimmed;
}

/** Resolve `path` inside `cwd`, or explain why it is outside. */
function inside(cwd: string, path: string): { abs: string } | { error: string } {
	const abs = resolve(cwd, path);
	const rel = relative(cwd, abs);
	if (rel.startsWith("..") || isAbsolute(rel)) {
		return { error: `'${path}' is outside the working directory (${cwd}); this tool only reaches inside it` };
	}
	return { abs };
}

function runCommand(cwd: string, command: string): Promise<ToolResult> {
	return new Promise((done) => {
		execFile(
			"bash",
			["-lc", command],
			{ cwd, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 },
			(error, stdout, stderr) => {
				const output = `${stdout ?? ""}${stderr ?? ""}`;
				if (!error) return done(ok(`exit: 0\n${tail(output)}`));
				const code = (error as { code?: number | string }).code;
				// A command that ran and failed is a result, not a tool failure: a red
				// baseline is the point of a builder step.
				if (typeof code === "number") return done(ok(`exit: ${code}\n${tail(output)}`));
				done(bad(`${error.message}${output ? `\n${tail(output)}` : ""}`));
			},
		);
	});
}

/**
 * The five tools, bound to one working directory.
 *
 * Bound per run rather than module-global: a run's cwd is its repo, and two sessions
 * in two repos must not share a fence.
 */
export function buildBuiltinTools(cwd: string): readonly ToolSpec[] {
	const root = resolve(cwd);

	const shell: ToolSpec = {
		name: "shell",
		description:
			"Run one command in the working directory and return its exit code and the raw tail of stdout+stderr. " +
			"A non-zero exit is a normal result. Use it for git, gates and scripts; it is a real shell, not a sandbox.",
		args: z.object({
			command: z.string().describe("the exact command, as the plan or the acceptance line writes it"),
		}),
		async execute(_state: unknown, args: { command: string }) {
			return runCommand(root, args.command);
		},
	};

	const read: ToolSpec = {
		name: "read",
		description:
			"Read a text file from the working directory. Returns the content, truncated with a note when it is large. " +
			"Paths outside the working directory are refused.",
		args: z.object({
			path: z.string().describe("path relative to the working directory"),
		}),
		async execute(_state: unknown, args: { path: string }) {
			const found = inside(root, args.path);
			if ("error" in found) return bad(found.error);
			let text: string;
			try {
				text = readFileSync(found.abs, "utf8");
			} catch (error) {
				return bad(`${args.path}: ${(error as Error).message}`);
			}
			const lines = text.split("\n");
			const byLines = lines.length > READ_MAX_LINES;
			const clipped = byLines ? lines.slice(0, READ_MAX_LINES).join("\n") : text;
			if (byLines) return ok(`${clipped}\n…[${lines.length - READ_MAX_LINES} more line(s) in ${args.path}]`);
			if (clipped.length > READ_MAX_CHARS) {
				return ok(`${clipped.slice(0, READ_MAX_CHARS)}\n…[${clipped.length - READ_MAX_CHARS} more char(s) in ${args.path}]`);
			}
			return ok(text);
		},
	};

	const write: ToolSpec = {
		name: "write",
		description:
			"Write one file in the working directory, replacing it whole and creating its parent directories. " +
			"Paths outside the working directory are refused.",
		args: z.object({
			path: z.string().describe("path relative to the working directory"),
			content: z.string().describe("the complete file content"),
		}),
		async execute(_state: unknown, args: { path: string; content: string }) {
			const found = inside(root, args.path);
			if ("error" in found) return bad(found.error);
			try {
				mkdirSync(dirname(found.abs), { recursive: true });
				writeFileSync(found.abs, args.content, "utf8");
			} catch (error) {
				return bad(`${args.path}: ${(error as Error).message}`);
			}
			return ok(`wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`);
		},
	};

	const edit: ToolSpec = {
		name: "edit",
		description:
			"Replace one exact passage in a file in the working directory. The passage must occur exactly once: " +
			"a count of 0 or 2+ is refused, so include surrounding context to make it unique.",
		args: z.object({
			path: z.string().describe("path relative to the working directory"),
			old: z.string().describe("the exact text to replace, unique in the file"),
			new: z.string().describe("the replacement text"),
		}),
		async execute(_state: unknown, args: { path: string; old: string; new: string }) {
			const found = inside(root, args.path);
			if ("error" in found) return bad(found.error);
			let text: string;
			try {
				text = readFileSync(found.abs, "utf8");
			} catch (error) {
				return bad(`${args.path}: ${(error as Error).message}`);
			}
			const occurrences = text.split(args.old).length - 1;
			if (occurrences === 0) return bad(`${args.path}: the passage to replace does not occur`);
			if (occurrences > 1) {
				return bad(`${args.path}: the passage occurs ${occurrences} times; include more context to make it unique`);
			}
			try {
				writeFileSync(found.abs, text.replace(args.old, args.new), "utf8");
			} catch (error) {
				return bad(`${args.path}: ${(error as Error).message}`);
			}
			return ok(`edited ${args.path}`);
		},
	};

	const list: ToolSpec = {
		name: "list",
		description:
			"List names under a directory in the working directory, directories first with a trailing slash. " +
			"Skips .git, node_modules and .pi, and stops at 400 entries.",
		args: z.object({
			path: z.string().optional().describe("directory relative to the working directory (default: the root)"),
			depth: z.number().int().min(1).max(6).optional().describe("levels to walk (default: 2)"),
		}),
		async execute(_state: unknown, args: { path?: string; depth?: number }) {
			const found = inside(root, args.path ?? ".");
			if ("error" in found) return bad(found.error);
			const entries: string[] = [];
			const walk = (dir: string, prefix: string, depth: number): void => {
				if (entries.length >= LIST_MAX_ENTRIES || depth <= 0) return;
				let names: string[];
				try {
					names = readdirSync(dir, { withFileTypes: true })
						.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
						.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
				} catch (error) {
					entries.push(`${prefix}<unreadable: ${(error as Error).message}>`);
					return;
				}
				for (const name of names) {
					if (entries.length >= LIST_MAX_ENTRIES) return;
					if (SKIP_DIRS.has(name.replace(/\/$/, ""))) continue;
					entries.push(`${prefix}${name}`);
					if (name.endsWith("/")) walk(join(dir, name), `${prefix}${name}`, depth - 1);
				}
			};
			walk(found.abs, "", args.depth ?? 2);
			const more = entries.length >= LIST_MAX_ENTRIES ? `\n…[stopped at ${LIST_MAX_ENTRIES} entries]` : "";
			return ok(`${entries.join("\n") || "(empty)"}${more}`);
		},
	};

	return [shell, read, write, edit, list];
}

/**
 * The tools a run gets: host-supplied implementations first, so an embedder can
 * override a built-in by name, then the built-ins, then nothing.
 */
export function withBuiltinTools(cwd: string, host: readonly ToolSpec[] = []): readonly ToolSpec[] {
	const seen = new Set(host.map((tool) => tool.name));
	return [...host, ...buildBuiltinTools(cwd).filter((tool) => !seen.has(tool.name))];
}
