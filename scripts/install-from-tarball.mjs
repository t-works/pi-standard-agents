#!/usr/bin/env node
/**
 * The published-artifact gate: pack, install the tarball in a clean temp dir,
 * and load the extension from *that* install.
 *
 * `npm test` runs against `dist/` in this checkout, so it can never answer the
 * question that actually breaks users: does the published dependency tree load?
 * Here it can and is answered twice:
 *
 *  - **the tarball is the artifact.** `npm pack --json` and
 *    `npm publish --dry-run --json` must agree, and the file list must be exactly
 *    `files` — `dist/` plus the three docs. No `src/`, no `test/`, no `.map`, no
 *    `.wasm`, no scripts.
 *  - **the artifact works.** In a temp dir: `npm init -y`, install the tarball
 *    plus the pinned PI host and `typebox` (the peers), then run
 *    `install-fixtures/loader.mjs`, which imports the installed package by name
 *    and drives it with a copied fake recorder. That loader is the only
 *    automated proof that `@t-works/standardagents-runtime` — and the `quickjs`
 *    engine's wasm behind its sandbox — resolves from an installed tree instead
 *    of a dev checkout.
 *
 * The PI host version is pinned below on purpose (risks, 08): a broken peer
 * range has to fail this gate, not a user's `pi install`.
 *
 *   node scripts/install-from-tarball.mjs            # pack, install, load
 *   PI_INSTALL_KEEP=1 node scripts/install-from-tarball.mjs  # keep the temp dir
 */
import { exec } from "node:child_process";
import { mkdir, mkdtemp, opendir, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = join(root, "scripts", "install-fixtures");

/** The PI host the tarball is installed against. A peer range break fails here. */
const HOST_PACKAGE = "@earendil-works/pi-coding-agent";
const HOST_VERSION = "1.6.0";
/** Peers the host does not bring itself. */
const EXTRA_PEERS = ["typebox"];

/** Files `files` allows, beyond `dist/`. npm always adds `package.json`. */
const ALLOWED_ROOT_FILES = new Set(["package.json", "README.md", "CHANGELOG.md", "LICENSE"]);
/** The entries that must be there, whatever else is. */
const REQUIRED_FILES = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "dist/extension.js"];

const NETWORK_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Run one command through the shell.
 *
 * npm on Windows is `npm.cmd`, and node itself lives under `C:\Program Files`,
 * so both the command and its arguments are quoted here rather than relying on
 * `execFile`'s argument array, which a shell would not honour.
 */
async function npm(args, { cwd = root, timeout = NETWORK_TIMEOUT_MS } = {}) {
	return run("npm", args, { cwd, timeout });
}

/** Quote one shell word, leaving plain words alone so output stays readable. */
function shellQuote(value) {
	return /[\s"]/.test(value) ? `"${value}"` : value;
}

/** Run one command, turning a non-zero exit into an error that carries its output. */
async function run(command, args, { cwd = root, timeout = NETWORK_TIMEOUT_MS } = {}) {
	const line = [command, ...args].map(shellQuote).join(" ");
	try {
		const { stdout, stderr } = await execAsync(line, { cwd, timeout, maxBuffer: 64 * 1024 * 1024 });
		return { stdout, stderr };
	} catch (error) {
		const output = [error.stdout, error.stderr].map((chunk) => String(chunk ?? "").trim()).filter(Boolean);
		throw new Error(
			`${line} failed (exit ${String(error.code ?? "?")})` +
				(output.length ? `\n${output.join("\n")}` : ""),
		);
	}
}

/**
 * Read one pack/publish report.
 *
 * npm 12 prints an object keyed by package name; older majors print an array.
 * Both shapes are handled so the gate does not depend on the npm in the runner.
 */
function report(result) {
	const json = JSON.parse(result.stdout);
	const entry = Array.isArray(json) ? json[0] : Object.values(json ?? {})[0];
	if (!entry || typeof entry !== "object") throw new Error("npm --json printed no package entry");
	return entry;
}

/** The `npm pack` file list, as paths. */
function pathsOf(entry) {
	const files = Array.isArray(entry.files) ? entry.files : [];
	return files.map((file) => (typeof file === "string" ? file : file.path)).sort();
}

/** Assert the tarball is exactly the `files` set. Returns the sorted paths. */
function assertFileList(entry) {
	const paths = pathsOf(entry);
	const failures = [];

	for (const required of REQUIRED_FILES) {
		if (!paths.includes(required)) failures.push(`missing ${required}`);
	}
	for (const path of paths) {
		if (ALLOWED_ROOT_FILES.has(path)) continue;
		if (!path.startsWith("dist/")) {
			failures.push(`${path} is not in the files set`);
			continue;
		}
		if (path.endsWith(".map")) failures.push(`${path} ships a source map`);
		if (path.endsWith(".wasm")) failures.push(`${path} ships a wasm blob`);
		if (path.endsWith(".ts") && !path.endsWith(".d.ts")) failures.push(`${path} ships TypeScript source`);
		if (/node_modules|standardagents-runtime|quickjs/i.test(path)) {
			failures.push(`${path} bundles the runtime`);
		}
	}
	if (failures.length > 0) {
		throw new Error(`the tarball is not the files set:\n  ${failures.join("\n  ")}`);
	}
	return paths;
}

/** Copy the loader and its fixtures into the temp install. */
async function copyFixtures(destination) {
	const directory = await opendir(fixtures);
	const copied = [];
	for await (const entry of directory) {
		if (!entry.isFile()) continue;
		await copyFile(join(fixtures, entry.name), join(destination, entry.name));
		copied.push(entry.name);
	}
	copied.sort();
	if (copied.length === 0) throw new Error(`no loader fixtures in ${fixtures}`);
	return copied;
}

async function main() {
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const label = `${manifest.name}@${manifest.version}`;
	const temp = await mkdtemp(join(tmpdir(), "pi-standard-agents-install-"));
	const keep = process.env.PI_INSTALL_KEEP === "1";

	console.log(`install-from-tarball: ${label}`);
	try {
		// 1. Pack, and assert the tarball is the files set.
		const packed = report(await npm(["pack", "--json", "--pack-destination", temp]));
		const tarball = join(temp, packed.filename);
		const packedPaths = assertFileList(packed);
		console.log(
			`  ✓ npm pack: ${packed.filename} (${packed.size} bytes, ${packedPaths.length} file(s), ` +
				`dist/extension.js included, no src/, test/, .map or .wasm)`,
		);

		// 2. The publish path must print the same list: what CI tested is what ships.
		const published = report(await npm(["publish", "--dry-run", "--json"]));
		const publishedPaths = assertFileList(published);
		if (publishedPaths.join("\n") !== packedPaths.join("\n")) {
			throw new Error(
				`npm publish --dry-run lists a different file set than npm pack:\n` +
					`  pack:    ${packedPaths.join(", ")}\n  publish: ${publishedPaths.join(", ")}`,
			);
		}
		console.log(`  ✓ npm publish --dry-run: same ${publishedPaths.length} file(s)`);

		// 3. A clean temp project, with the tarball and the pinned peers.
		const app = join(temp, "app");
		await mkdir(app, { recursive: true });
		await npm(["init", "-y"], { cwd: app });
		await npm(
			[
				"install",
				tarball,
				`${HOST_PACKAGE}@${HOST_VERSION}`,
				...EXTRA_PEERS,
				"--no-audit",
				"--no-fund",
			],
			{ cwd: app },
		);
		const installed = JSON.parse(
			await readFile(join(app, "node_modules", manifest.name, "package.json"), "utf8"),
		);
		if (installed.version !== manifest.version) {
			throw new Error(`the temp install resolved ${installed.version}, expected ${manifest.version}`);
		}
		console.log(
			`  ✓ npm install in a clean dir: ${label} + ${HOST_PACKAGE}@${HOST_VERSION} + ${EXTRA_PEERS.join(", ")}`,
		);

		// 4. Load it there. The loader's own output is the assertion log.
		const copied = await copyFixtures(app);
		const loader = await run(process.execPath, ["loader.mjs"], { cwd: app, timeout: 5 * 60 * 1000 });
		process.stdout.write(loader.stdout);
		console.log(`  ✓ loader (${copied.join(", ")}) imported the installed package`);

		console.log("install-from-tarball: ok");
	} finally {
		if (keep) console.log(`install-from-tarball: kept ${temp}`);
		else await rm(temp, { recursive: true, force: true });
	}
}

try {
	await main();
} catch (error) {
	console.error("install-from-tarball: FAILED");
	console.error(String(error instanceof Error ? error.message : error));
	process.exitCode = 1;
}
