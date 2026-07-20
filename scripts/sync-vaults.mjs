#!/usr/bin/env node
// Distribute this monorepo's BUILT plugins to Obsidian vaults.
//
// `pnpm build` only installs into the single vault named by OBSIDIAN_PLUGINS_DIR
// in .env. This script fans the built output out to every vault (or specific
// ones), so multiple vaults stay in sync with the monorepo — the single source
// of truth. Only the toolkit's own plugins are touched; third-party plugins in
// each vault are left alone. Per-vault `data.json` is never copied or deleted.
//
// Plugins are matched to a vault's existing folder by manifest `id` (folder
// names differ across vaults); if absent, the monorepo's distDir name is used.
//
// Usage (run AFTER `pnpm build`):
//   node scripts/sync-vaults.mjs                 # all vaults in obsidian.json
//   node scripts/sync-vaults.mjs ByteDance       # only vaults matching name/path
//   node scripts/sync-vaults.mjs /path/to/vault  # an explicit vault path

import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGES_DIR = join(__dirname, "..", "packages");
const EXCLUDES = ["data.json"]; // per-vault personal config — never touched

const filters = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// ---- target vaults ----------------------------------------------------------
function allVaults() {
	const p = join(homedir(), "Library/Application Support/obsidian/obsidian.json");
	return Object.values(JSON.parse(readFileSync(p, "utf8")).vaults).map((v) => v.path);
}

let targets = allVaults();
if (filters.length) {
	targets = targets.filter((p) =>
		filters.some((f) => f === p || basename(p) === f)
	);
	// allow explicit paths that aren't registered in obsidian.json
	for (const f of filters) {
		if (f.includes("/") && !targets.includes(f)) targets.push(f);
	}
}

// ---- built plugins in the monorepo ------------------------------------------
function distDirOf(pkgPath) {
	const cfg = join(pkgPath, "esbuild.config.mjs");
	if (existsSync(cfg)) {
		const m = readFileSync(cfg, "utf8").match(/distDir:\s*["']([^"']+)["']/);
		if (m) return m[1];
	}
	// fallback: a subdirectory that contains a manifest.json (the build output)
	for (const e of readdirSync(pkgPath, { withFileTypes: true })) {
		if (e.isDirectory() && existsSync(join(pkgPath, e.name, "manifest.json"))) {
			return e.name;
		}
	}
	return null;
}

const plugins = [];
for (const e of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
	if (!e.isDirectory()) continue;
	const pkgPath = join(PACKAGES_DIR, e.name);
	const distDir = distDirOf(pkgPath);
	if (!distDir) continue;
	const src = join(pkgPath, distDir);
	const manifestPath = join(src, "manifest.json");
	if (!existsSync(manifestPath)) {
		console.warn(`⚠️  ${e.name}: not built yet (run \`pnpm build\`) — skipped`);
		continue;
	}
	const id = JSON.parse(readFileSync(manifestPath, "utf8")).id;
	plugins.push({ id, distDir, src });
}

// ---- id -> folder name for a vault's installed plugins ----------------------
function idMap(pluginsBase) {
	const map = {};
	if (!existsSync(pluginsBase)) return map;
	for (const e of readdirSync(pluginsBase, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const mp = join(pluginsBase, e.name, "manifest.json");
		if (!existsSync(mp)) continue;
		try {
			map[JSON.parse(readFileSync(mp, "utf8")).id] = e.name;
		} catch {
			/* ignore unreadable manifest */
		}
	}
	return map;
}

// ---- sync -------------------------------------------------------------------
if (!targets.length) {
	console.error("No target vaults matched.");
	process.exit(1);
}
console.log(`Plugins: ${plugins.length} | Target vaults: ${targets.length}\n`);

for (const vault of targets) {
	const base = join(vault, ".obsidian/plugins");
	console.log(`==> ${basename(vault)}`);
	const map = idMap(base);
	for (const { id, distDir, src } of plugins) {
		const targetFolder = map[id] || distDir;
		const dest = join(base, targetFolder);
		mkdirSync(dest, { recursive: true });
		const rsyncArgs = [
			"-a",
			"--delete",
			...EXCLUDES.flatMap((x) => ["--exclude", x]),
			`${src}/`,
			`${dest}/`,
		];
		console.log(`  ${id} -> ${targetFolder}${map[id] ? "" : " (new)"}`);
		execFileSync("rsync", rsyncArgs, {
			stdio: ["ignore", "ignore", "inherit"],
		});
	}
	console.log("");
}

console.log("Done.");
