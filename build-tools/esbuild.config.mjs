import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync, cpSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load .env from repo root (two levels up from build-tools/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");
if (existsSync(envPath)) {
	for (const line of readFileSync(envPath, "utf-8").split("\n")) {
		const match = line.match(/^([^#=]+)=(.*)$/);
		if (match) process.env[match[1].trim()] = match[2].trim();
	}
}

/**
 * Update manifest.json version number (optional feature)
 * @param {string} manifestPath - Path to manifest.json
 */
export function updateManifestVersion(manifestPath = "manifest.json") {
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		
		// Parse version number (e.g., "1.0.1" -> [1, 0, 1])
		const versionParts = manifest.version.split(".").map(Number);
		
		// Increment patch version number
		versionParts[2] = (versionParts[2] || 0) + 1;
		
		// Reassemble version number
		manifest.version = versionParts.join(".");
		
		// Write back to file
		writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");
		console.log(`✓ Updated manifest version to ${manifest.version}`);
		return manifest.version;
	} catch (error) {
		console.warn("Failed to update manifest version:", error);
		return null;
	}
}

/**
 * Sync plugin to Obsidian plugins directory
 * @param {string} distDir - Build output directory name
 * @param {string} packagePath - Path to the package directory
 * @param {boolean} isDev - Whether in development mode (symlink) or build mode (copy)
 */
function syncToObsidian(distDir, packagePath, isDev) {
	const OBSIDIAN_PLUGINS_DIR = process.env.OBSIDIAN_PLUGINS_DIR ?? '';
	
	if (!existsSync(OBSIDIAN_PLUGINS_DIR)) {
		console.warn(`⚠️  Obsidian plugins directory does not exist: ${OBSIDIAN_PLUGINS_DIR}`);
		return;
	}
	
	const sourcePath = resolve(packagePath, distDir);
	const targetPath = join(OBSIDIAN_PLUGINS_DIR, distDir);
	
	if (!existsSync(sourcePath)) {
		console.warn(`⚠️  Source directory does not exist: ${sourcePath}`);
		return;
	}
	
	// Always preserve the user's runtime data.json across the sync — in BOTH dev
	// (symlink) and build (copy) modes. data.json holds plugin settings (pinned
	// items, etc.) that Obsidian owns at runtime, so it must never be clobbered or
	// deleted by a rebuild. Read it (resolving through a symlink) before we remove
	// the target, then write it back into the location Obsidian will read.
	let savedDataJson = null;
	const existingDataJsonPath = join(targetPath, "data.json");
	if (existsSync(existingDataJsonPath)) {
		try {
			savedDataJson = readFileSync(existingDataJsonPath, "utf-8");
		} catch (error) {
			console.warn(`⚠️  Failed to back up data.json: ${error.message}`);
		}
	}

	// Remove existing target (symlink or directory)
	if (existsSync(targetPath)) {
		try {
			const stat = statSync(targetPath);
			if (stat.isSymbolicLink()) {
				rmSync(targetPath);
			} else if (stat.isDirectory()) {
				rmSync(targetPath, { recursive: true, force: true });
			}
		} catch (error) {
			console.warn(`⚠️  Failed to remove existing target: ${error.message}`);
		}
	}

	// Create symlink (dev) or copy (build)
	try {
		if (isDev) {
			symlinkSync(sourcePath, targetPath, 'dir');
			// The symlink exposes sourcePath to Obsidian, so the live data.json
			// lives at sourcePath/data.json. Restore the preserved data there.
			if (savedDataJson !== null) {
				try {
					writeFileSync(join(sourcePath, "data.json"), savedDataJson, "utf-8");
					console.log(`✓ Preserved data.json (user settings kept)`);
				} catch (error) {
					console.warn(`⚠️  Failed to preserve data.json: ${error.message}`);
				}
			}
			console.log(`✓ Symlinked ${distDir} -> Obsidian plugins`);
		} else {
			cpSync(sourcePath, targetPath, { recursive: true });

			// Restore user's data.json that was backed up before the copy
			if (savedDataJson !== null) {
				try {
					writeFileSync(join(targetPath, "data.json"), savedDataJson, "utf-8");
					console.log(`✓ Restored data.json (user settings preserved)`);
				} catch (error) {
					console.warn(`⚠️  Failed to restore data.json: ${error.message}`);
				}
			}

			console.log(`✓ Copied ${distDir} -> Obsidian plugins`);
		}
	} catch (error) {
		console.error(`✗ Failed to ${isDev ? 'symlink' : 'copy'} ${distDir}:`, error.message);
	}
}

/**
 * Create esbuild configuration for Obsidian plugins
 * @param {Object} options - Configuration options
 * @param {string} options.distDir - Build output directory (e.g., "obsidian-plugin-file-explorer")
 * @param {string} [options.entryPoint="src/main.ts"] - Entry file
 * @param {boolean} [options.minify=true] - Whether to minify (production mode)
 * @param {boolean} [options.keepNames=false] - Whether to keep function names
 * @param {Function} [options.onBuildEnd] - Callback function when build ends
 * @returns {Promise<esbuild.BuildContext>} esbuild context
 */
export async function createBuildContext({
	distDir,
	entryPoint = "src/main.ts",
	minify = true,
	keepNames = false,
	onBuildEnd = null,
}) {
	const prod = process.argv[2] === "production";
	
	// Get package directory path (assuming esbuild.config.mjs is in package root)
	const packagePath = process.cwd();

	const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

	// Copy files to build directory
	const copyFiles = () => {
		if (!existsSync(distDir)) {
			mkdirSync(distDir, { recursive: true });
		}

		const filesToCopy = ["manifest.json", "styles.css"];
		for (const file of filesToCopy) {
			if (existsSync(file)) {
				copyFileSync(file, join(distDir, file));
			}
		}

		// NOTE: data.json is intentionally NOT copied here. It is a runtime file
		// owned by Obsidian (plugin settings such as pinned items). Treating it as
		// a build artifact would clobber the user's live data on every build.

		// Copy main.js to root directory (required by Obsidian)
		if (existsSync(join(distDir, "main.js"))) {
			copyFileSync(join(distDir, "main.js"), "main.js");
		}
	};

	const context = await esbuild.context({
		banner: {
			js: banner,
		},
		entryPoints: [entryPoint],
		bundle: true,
		external: [
			"obsidian",
			"electron",
			"@codemirror/autocomplete",
			"@codemirror/collab",
			"@codemirror/commands",
			"@codemirror/language",
			"@codemirror/lint",
			"@codemirror/search",
			"@codemirror/state",
			"@codemirror/view",
			"@lezer/common",
			"@lezer/highlight",
			"@lezer/lr",
			...builtinModules,
			...builtinModules.map((m) => `node:${m}`),
		],
		format: "cjs",
		target: "es2018",
		logLevel: "info",
		sourcemap: prod ? false : "inline",
		treeShaking: true,
		outfile: `${distDir}/main.js`,
		minify: prod && minify,
		keepNames: keepNames,
		plugins: [
			{
				// Userland polyfill subpaths like "process/" and "string_decoder/"
				// (used by readable-stream) mirror Node builtins. Resolve them to the
				// bare builtin and mark external — it's available in Electron. Without
				// this, esbuild leaves an unresolvable require("process/") in the bundle.
				name: "builtin-polyfill-subpath",
				setup(build) {
					const builtinSet = new Set(builtinModules);
					build.onResolve({ filter: /\/$/ }, (args) => {
						const bare = args.path.slice(0, -1);
						if (builtinSet.has(bare)) {
							return { path: bare, external: true };
						}
						return null;
					});
				},
			},
			{
				name: "copy-files",
				setup(build) {
					build.onEnd((result) => {
						if (!result.errors.length) {
							copyFiles();
							// Sync to Obsidian plugins directory
							syncToObsidian(distDir, packagePath, !prod);
							if (onBuildEnd) {
								onBuildEnd();
							}
						}
					});
				},
			},
		],
	});

	if (prod) {
		await context.rebuild();
		copyFiles();
		// Sync to Obsidian plugins directory (copy mode)
		syncToObsidian(distDir, packagePath, false);
		if (onBuildEnd) {
			onBuildEnd();
		}
		console.log(`✓ Build completed: ${distDir}/main.js`);
		process.exit(0);
	} else {
		// Development mode: copy files initially
		copyFiles();
		// Sync to Obsidian plugins directory (symlink mode)
		syncToObsidian(distDir, packagePath, true);
		console.log(`✓ Watching for changes...`);
		console.log(`✓ Output directory: ${distDir}/`);
		await context.watch();
	}

	return context;
}

