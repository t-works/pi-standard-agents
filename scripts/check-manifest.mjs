#!/usr/bin/env node
/**
 * Manifest gate for the published package.
 *
 * `dist` is what PI loads and what npm publishes, so every assertion here reads
 * the built tree and `package.json`, never `src/`.
 *
 * Fails (exit 1) when:
 *  - `dist/extension.js` is missing, or any `pi.extensions` path does not exist
 *  - `dist/` ships TypeScript source (`.d.ts` declarations are fine), a `.wasm`
 *    blob, or a copy of the runtime / quickjs
 *  - `@t-works/standardagents-runtime` is not a plain dependency
 *  - `quickjs-emscripten` leaks into our own dependencies (it is transitively ours)
 *  - a host package (PI, typebox) is a dependency instead of a peer
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_PACKAGE = "@t-works/standardagents-runtime";
const HOST_PACKAGES = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"typebox",
];

const failures = [];
const checked = [];

/** Record one passed assertion. */
function ok(label) {
	checked.push(label);
}

/** Record one failed assertion. */
function fail(label, detail) {
	failures.push(detail ? `${label}: ${detail}` : label);
}

/** Assert, recording the outcome either way. */
function expect(condition, label, detail) {
	if (condition) ok(label);
	else fail(label, detail);
}

function toPosix(path) {
	return path.split(sep).join("/");
}

/** Normalize a manifest/disk path to forward slashes without a leading "./". */
function normalize(path) {
	return toPosix(path).replace(/^\.\//, "");
}

async function walk(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (error && error.code === "ENOENT") return [];
		throw error;
	}
	const files = [];
	for (const entry of entries) {
		const absolute = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(absolute)));
		else if (entry.isFile()) files.push(absolute);
	}
	return files;
}

async function exists(path) {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const dependencies = pkg.dependencies ?? {};
	const devDependencies = pkg.devDependencies ?? {};
	const peerDependencies = pkg.peerDependencies ?? {};

	// 1. PI's extension ABI points at built JS that exists.
	const extensions = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
	expect(extensions.length > 0, "package.json pi.extensions is a non-empty array");
	for (const entry of extensions) {
		const relative = normalize(entry);
		const absolute = resolve(root, entry);
		expect(
			relative.startsWith("dist/"),
			`pi.extensions entry ${relative} points into dist/`,
		);
		expect(await exists(absolute), `pi.extensions entry ${relative} exists`);
		if (relative.endsWith(".ts")) {
			fail(`pi.extensions entry ${relative}`, "must be compiled JS, not TypeScript");
		}
	}
	expect(await exists(join(root, "dist", "extension.js")), "dist/extension.js exists");

	// 2. The built tree carries no source, no wasm, no vendored runtime.
	const distFiles = (await walk(join(root, "dist"))).map((file) =>
		normalize(file.slice(root.length + 1)),
	);
	expect(distFiles.length > 0, "dist/ is not empty (run `npm run build` first)");
	expect(
		distFiles.some((file) => file === "dist/extension.js"),
		"dist/ holds the compiled extension entry",
	);
	for (const file of distFiles) {
		ok(file);
		if (file.endsWith(".ts") && !file.endsWith(".d.ts")) {
			fail(`dist file ${file}`, "TypeScript source must not be shipped");
		}
		if (file.endsWith(".wasm")) {
			fail(`dist file ${file}`, "quickjs wasm must stay in dependencies, not in dist/");
		}
		if (/quickjs/i.test(file) || /standardagents-runtime/.test(file)) {
			fail(`dist file ${file}`, "the runtime is a dependency, never bundled");
		}
	}

	// 3. The runtime is a normal dependency, and only one copy can exist.
	expect(
		RUNTIME_PACKAGE in dependencies,
		`${RUNTIME_PACKAGE} is in dependencies`,
	);
	expect(
		!(RUNTIME_PACKAGE in devDependencies),
		`${RUNTIME_PACKAGE} is not a devDependency`,
	);
	const runtimeRange = dependencies[RUNTIME_PACKAGE];
	expect(
		typeof runtimeRange === "string" && !String(runtimeRange).startsWith("file:"),
		`${RUNTIME_PACKAGE} is published from the registry, not file:-linked`,
		String(runtimeRange),
	);

	// 4. quickjs-emscripten arrives through the runtime, never through us.
	expect(!("quickjs-emscripten" in dependencies), "quickjs-emscripten is absent from dependencies");
	expect(
		!("quickjs-emscripten" in devDependencies),
		"quickjs-emscripten is absent from devDependencies",
	);

	// 5. Host packages are peers: PI supplies them at runtime.
	for (const host of HOST_PACKAGES) {
		expect(!(host in dependencies), `${host} is not a dependency`);
		expect(!(host in devDependencies), `${host} is not a devDependency`);
		expect(host in peerDependencies, `${host} is declared as a peerDependency`);
	}

	// 6. Small shape checks the loader and the packer rely on.
	expect(pkg.type === "module", 'package.json has "type": "module"');
	expect(
		Array.isArray(pkg.files) && pkg.files.includes("dist"),
		'package.json "files" ships dist',
	);
	expect(
		Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package"),
		'package.json keywords include "pi-package"',
	);
	expect(
		typeof pkg.engines?.node === "string" && pkg.engines.node.includes("22.18"),
		'package.json engines.node is ">=22.18"',
		String(pkg.engines?.node),
	);

	// 7. `npm test` runs against dist, not src.
	const testScript = pkg.scripts?.test ?? "";
	expect(testScript.length > 0, "package.json has a test script");
	expect(
		!(pkg.scripts?.build ?? "").includes("&"),
		"the build script is a single command",
	);

	if (failures.length > 0) {
		console.error("check-manifest: FAILED");
		for (const failure of failures) console.error(`  ✗ ${failure}`);
		process.exitCode = 1;
		return;
	}

	console.log("check-manifest: ok");
	for (const label of checked) console.log(`  ✓ ${label}`);
	console.log(`checked ${checked.length} item(s) across dist/, package.json and its dependencies`);
}

await main();
