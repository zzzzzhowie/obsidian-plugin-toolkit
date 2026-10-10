# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands use pnpm. Run from the repo root.

**All packages at once:**
```bash
pnpm dev          # Watch mode for all packages (auto-syncs to local Obsidian vault)
pnpm build        # Type-check + production build for all packages
pnpm lint         # Lint all packages
```

**Single package** (every package has both; the names are the package directories):
```bash
pnpm dev:claudian-enhanced
pnpm build:claudian-enhanced   # type-check + build, copied into OBSIDIAN_PLUGINS_DIR
```

**Other vaults:**
```bash
pnpm sync                               # mirror every built plugin into the other vaults
node scripts/sync-vaults.mjs ByteDance  # just one vault
```
The `.githooks/pre-push` hook runs `pnpm sync` on every push, so build before pushing (`--no-verify` skips it).

**Version bump (run from within a package directory):**
```bash
pnpm version patch   # Updates manifest.json and versions.json, stages them for git
```
Paste (Enhanced) bumps its own patch version on every build (its `onBuildEnd`), so its `manifest.json` shows up modified after a build; commit it with the change.

**Per-package build internals** (rarely needed directly):
```bash
node esbuild.config.mjs             # Dev/watch mode
node esbuild.config.mjs production  # Production build
tsc -noEmit -skipLibCheck           # Type-check only (run before production build)
eslint .                            # Lint a single package
```

There are no automated tests — plugins are tested in the running Obsidian (see "Testing in Obsidian" below).

## Architecture

### Monorepo structure

- `build-tools/` — Shared build infrastructure (esbuild config, tsconfig base, version-bump script). Not an Obsidian plugin.
- `shared/` — Runtime code used by more than one plugin (e.g. `zoom-overlay.ts`, the click-to-zoom overlay behind Mermaid (Enhanced) and Excalidraw (Enhanced)). Imported by relative path (`../../../shared/x`), bundled into each plugin by esbuild, and listed in the importing package's `tsconfig.json` `include`. Its own imports of `obsidian` resolve against the root `node_modules`, which is why `obsidian` is a root devDependency.
- `packages/<name>/` — Each Obsidian plugin. Source lives in `src/`, build output in `packages/<name>/dist/` (ignored by git).
- `scripts/sync-vaults.mjs` — Copies built plugins (plus CSS snippets and shared app/appearance/hotkey/core-plugin settings) from the default vault to the others, matching plugins by manifest `id` and never touching a vault's `data.json`.
- Root `package.json` provides convenience scripts that delegate to all packages via `pnpm --filter`.

### Shared build system (`build-tools/esbuild.config.mjs`)

All packages call `createBuildContext(options)` from build-tools and pass a minimal config. The shared function handles:
- Bundling with esbuild (CJS, ES2018, tree-shaking)
- Marking Obsidian/Electron/CodeMirror packages as external (not bundled)
- Copying `manifest.json` and `styles.css` to the output directory
- Copying the built `main.js` to the package root (required by Obsidian to load the plugin)
- In dev mode: symlinking the build output into the local Obsidian vault at the path defined by `OBSIDIAN_PLUGINS_DIR` in `.env` (see `.env.example`)
- In production mode: copying instead of symlinking

Each package's `esbuild.config.mjs` is ~5 lines and only specifies what's unique (entry point, output directory, any `onBuildEnd` hooks).

### Plugin IDs, folders and versions

- Every package builds into `dist/`; the build and `scripts/sync-vaults.mjs` copy it into the vault folder named after the manifest `id` (read from `manifest.json`, never configured). A plugin's settings live in that vault folder's `data.json`.
- Obsidian's updater identifies a plugin by `id` alone and offers the community store's release of the same id as an update, which replaces ours. Before choosing an id, check it against `community-plugins.json` (obsidianmd/obsidian-releases). Ours either carry a prefix (`yeyan-drafts`, `yeyan-quick-open`, `yeyan-sidebar-guard`, `yeyan-tab-manager`) or, where the store has the id and we keep it, are versioned `100.0.0` so no store release is newer (`copy-path`, `note-comments`, `vault-backup`). Don't rename an id: enabled state, hotkeys and cross-plugin command ids (e.g. `yeyan-drafts:new-draft`, run by Claudian (Enhanced)) hang on it.
- Never edit a vault's `.obsidian/plugins/` by hand; change the package and build.

### Per-package TypeScript config

Each `tsconfig.json` extends `../../build-tools/tsconfig.base.json`. The base config enables strict TypeScript (noImplicitAny, strictNullChecks, noImplicitReturns, etc.), targets ES6, and uses `src` as `baseUrl`.

### Plugin architecture pattern

All plugins extend Obsidian's `Plugin` class:
- `onload()` — register commands, settings tabs, workspace events, DOM event listeners
- `onunload()` — cleanup (Obsidian auto-cleans anything registered via `registerEvent`, `registerDomEvent`, `registerInterval`)

Settings are persisted via `this.loadData()` / `this.saveData()` which writes to `.obsidian/plugins/<id>/data.json` and syncs automatically with Obsidian Sync.

More complex plugins (file-explorer-enhancements) split features into dedicated manager classes (e.g., `PinnedItemsManager`, `FolderNoteManager`) that are instantiated in `onload()`. Each manager owns its own event listeners and DOM mutations.

### Obsidian-specific conventions

- File explorer DOM: nodes have `data-path` attributes for identifying files/folders
- Context detection: check `this.app.workspace.activeLeaf` or event targets to distinguish editor vs. file-explorer vs. preview
- Hotkeys: registered via `addCommand({ hotkeys: [...] })`
- Context menus: `app.workspace.on('file-menu', ...)` and `app.workspace.on('editor-menu', ...)`

### ESLint

Uses ESLint 9 flat config (`eslint.config.mts`) with `typescript-eslint` strict mode and `eslint-plugin-obsidianmd` for Obsidian-specific rules. The config lives per-package, not at the root; every package declares `eslint` itself, and its `globalIgnores` lists `dist`. The forked packages (auto-link-title, image-auto-upload, file-explorer-enhancements, copy-path, hide-ui-elements, mermaid, line-numbers, blockier, nav-history) carry pre-existing lint errors — don't add new ones; compare a file's error count against `HEAD` when touching them.

### Testing in Obsidian

Obsidian is run with `--remote-debugging-port=9222` (`open -a Obsidian --args --remote-debugging-port=9222`), so a script can evaluate JS in a vault's window over CDP: find the page in `http://127.0.0.1:9222/json/list` whose title contains ` - <vault> - `, then `Runtime.evaluate` with `awaitPromise`/`returnByValue`. `app` is global (`require("obsidian")` is not); reload a rebuilt plugin with `app.plugins.disablePlugin(id)` then `enablePlugin(id)` (call `app.plugins.loadManifests()` first if its manifest changed).
- A background Obsidian window throttles timers and pauses `requestAnimationFrame`, and an unfocused editor never opens an `EditorSuggest` or shows Live Preview source — test the logic directly (call the method, dispatch the transaction) rather than waiting on those.
- Restore anything a test changes (note text, cursor, active leaf); stub side effects such as `app.showInFolder`.
- Quitting Obsidian mid-write can truncate a plugin's `data.json`; back up `.obsidian/plugins` before migrations.

### Claudian (Enhanced) notes

It drives Claudian's internals, which shift between releases (verify against the installed `realclaudian` bundle):
- A conversation summary's `messageCount` is 0 until the conversation is loaded (`getConversationById`); the plugin loads them all once per session before trusting the counts.
- Session metas live in `.claudian/sessions/` and, since 2.3, `.claudian/sessions/devices/<device>/`.
- Claudian's selection poll drops the carried selection whenever focus is outside the note editor and Claudian's view, so UI it adds must keep focus there (e.g. focus the composer on mousedown).
