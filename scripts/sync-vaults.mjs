#!/usr/bin/env node
// Distribute this monorepo's BUILT plugins to Obsidian vaults, and fan the
// primary vault's CSS snippets (Obsidian Appearance) out to the others.
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
// CSS snippets: the vault that OBSIDIAN_PLUGINS_DIR points to (the "default"
// vault) is the source of truth for `.obsidian/snippets/*.css`. Its snippets are
// mirrored (rsync --delete) into every other target vault, so appearance CSS
// stays identical everywhere.
//
// Vault settings: theme and appearance, hotkeys, core plugins and the editor options
// in app.json are kept the same across the target vaults, setting by setting — a
// setting changed in any vault is carried to the others (see syncSettings below).
// Which community plugins are enabled, and each plugin's data.json, stay per vault.
//
// Usage (run AFTER `pnpm build`):
//   node scripts/sync-vaults.mjs                 # all vaults in obsidian.json
//   node scripts/sync-vaults.mjs MyVault         # only vaults matching name/path
//   node scripts/sync-vaults.mjs /path/to/vault  # an explicit vault path
//   node scripts/sync-vaults.mjs --dry-run       # print the settings changes, write nothing

import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const PACKAGES_DIR = join(REPO_ROOT, "packages");
// Files a plugin writes at runtime, in its own folder: never part of a build, so --delete
// would remove them. data.json is its settings / data; data.backup.json is the copy Note
// Comments keeps of data.json before its first write each session — the sync was deleting it.
const EXCLUDES = ["data.json", "data.backup.json"];

// The vault OBSIDIAN_PLUGINS_DIR points to is the CSS-snippets source of truth.
// OBSIDIAN_PLUGINS_DIR = <vault>/.obsidian/plugins, so the source snippets dir is
// the sibling <vault>/.obsidian/snippets.
function sourceSnippetsDir() {
	const envPath = join(REPO_ROOT, ".env");
	if (!existsSync(envPath)) return null;
	const m = readFileSync(envPath, "utf8").match(/^\s*OBSIDIAN_PLUGINS_DIR\s*=\s*(.+?)\s*$/m);
	if (!m) return null;
	const pluginsDir = m[1].replace(/^["']|["']$/g, "");
	return join(dirname(pluginsDir), "snippets");
}

const filters = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DRY_RUN = process.argv.includes("--dry-run");

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
if (DRY_RUN) {
	syncSettings(targets);
	console.log("Dry run: nothing written, plugins and snippets not copied.");
	process.exit(0);
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

// ---- CSS snippets (Obsidian Appearance) -------------------------------------
// Mirror the source vault's snippets/ into every other target vault. The source
// vault itself is skipped (it's the truth). Which snippets are enabled is in
// appearance.json, kept in step by syncSettings.
const srcSnippets = sourceSnippetsDir();
if (!srcSnippets) {
	console.warn("⚠️  OBSIDIAN_PLUGINS_DIR not found in .env — CSS snippets not synced.");
} else if (!existsSync(srcSnippets)) {
	console.warn(`⚠️  source snippets dir missing (${srcSnippets}) — CSS snippets not synced.`);
} else {
	const srcVault = dirname(dirname(srcSnippets)); // <vault>/.obsidian/snippets -> <vault>
	const cssTargets = targets.filter((v) => v !== srcVault);
	console.log(`CSS snippets from ${basename(srcVault)} -> ${cssTargets.length} vault(s)\n`);
	for (const vault of cssTargets) {
		const dest = join(vault, ".obsidian/snippets");
		mkdirSync(dest, { recursive: true });
		console.log(`==> ${basename(vault)}: snippets/`);
		execFileSync(
			"rsync",
			["-a", "--delete", "--exclude", ".DS_Store", `${srcSnippets}/`, `${dest}/`],
			{ stdio: ["ignore", "ignore", "inherit"] }
		);
	}
	console.log("");
}

syncSettings(targets);

console.log("Done.");

// ---- Vault settings (theme, hotkeys, core plugins, editor options) ----------
// Merged setting by setting against a snapshot of what the last sync left in every vault
// (STATE_PATH): a setting a vault has changed since is carried to the others, one nobody
// changed stays. Not "newest file wins": Obsidian rewrites app.json, appearance.json and
// core-plugins.json on every start, so a file's mtime says nothing about who changed
// what, and restarting a vault would push its old settings over a newer change. Only when
// two vaults changed the same setting differently does the more recently written file win.
//
// A vault the snapshot doesn't know yet (first run, or a new vault) takes the merged
// settings without voting — so a fresh vault's defaults never overwrite the others. On
// the very first run there's no snapshot: a setting set in one vault and unset in the
// other is taken as set; set differently, the more recently written file wins.
//
// Obsidian picks up app.json, appearance.json and hotkeys.json while running;
// core-plugins.json is read at startup, so a core plugin switched on or off elsewhere
// takes effect the next time the vault opens.
function syncSettings(vaults) {
	const FILES = ["app.json", "appearance.json", "hotkeys.json", "core-plugins.json"];
	// Settings about a vault's own folders, not how Obsidian behaves: left as each vault has them.
	const OWN = {
		"app.json": new Set(["userIgnoreFilters", "attachmentFolderPath", "newFileLocation", "newFileFolderPath"]),
	};
	const STATE_PATH = join(REPO_ROOT, ".cache/vault-settings-sync.json");
	if (vaults.length < 2) return;

	const state = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, "utf8")) : { vaults: [], files: {} };
	const known = new Set(state.vaults);
	const next = { vaults: [...new Set([...state.vaults, ...vaults])], files: { ...state.files } };
	console.log(`Vault settings across ${vaults.length} vaults${DRY_RUN ? " (dry run)" : ""}\n`);

	for (const file of FILES) {
		const own = OWN[file] ?? new Set();
		const copies = [];
		let unreadable = false;
		for (const vault of vaults) {
			const path = join(vault, ".obsidian", file);
			if (!existsSync(path)) {
				copies.push({ vault, path, data: null, mtime: 0 });
				continue;
			}
			try {
				copies.push({ vault, path, data: JSON.parse(readFileSync(path, "utf8")), mtime: statSync(path).mtimeMs });
			} catch {
				console.warn(`⚠️  ${basename(vault)}/${file} isn't valid JSON — ${file} not synced.`);
				unreadable = true;
			}
		}
		if (unreadable) continue;

		const base = state.files[file];
		// Most recently written first, so it wins a conflict.
		const voters = copies
			.filter((c) => c.data && (!base || known.has(c.vault)))
			.sort((a, b) => b.mtime - a.mtime);
		const keys = new Set([...Object.keys(base ?? {}), ...voters.flatMap((c) => Object.keys(c.data))]);
		const merged = {};
		for (const key of keys) {
			if (own.has(key)) continue;
			const changed = base
				? voters.filter((c) => !same(c.data[key], base[key]))
				: voters.filter((c) => c.data[key] !== undefined);
			const value = changed.length ? changed[0].data[key] : base?.[key];
			if (value !== undefined) merged[key] = value;
		}
		next.files[file] = merged;

		for (const { vault, path, data } of copies) {
			const current = data ?? {};
			// The file's own key order, then anything new; a vault's own settings kept.
			const out = {};
			for (const key of Object.keys(current)) {
				if (own.has(key)) out[key] = current[key];
				else if (key in merged) out[key] = merged[key];
			}
			for (const key of Object.keys(merged)) if (!(key in out)) out[key] = merged[key];
			const diff = [...new Set([...Object.keys(current), ...Object.keys(out)])].filter(
				(key) => !same(current[key], out[key])
			);
			if (!diff.length) continue;
			console.log(`==> ${basename(vault)}/${file}: ${diff.join(", ")}`);
			// A fresh write, not a copy that keeps the source's mtime: Obsidian reloads app.json
			// and appearance.json only when the file is newer than its last read.
			if (!DRY_RUN) writeFileSync(path, JSON.stringify(out, null, 2));
		}
	}

	if (!DRY_RUN) {
		mkdirSync(dirname(STATE_PATH), { recursive: true });
		writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
	}
	console.log("");
}

/** Equal as JSON, whatever the key order. */
function same(a, b) {
	return canonical(a) === canonical(b);
}

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
