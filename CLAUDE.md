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

**Single package:**
```bash
pnpm dev:file-explorer
pnpm dev:copy-path
pnpm dev:paste-enhanced
pnpm dev:image-zoom

pnpm build:file-explorer   # (and similar for each)
```

**Version bump (run from within a package directory):**
```bash
pnpm version patch   # Updates manifest.json and versions.json, stages them for git
```

**Per-package build internals** (rarely needed directly):
```bash
node esbuild.config.mjs             # Dev/watch mode
node esbuild.config.mjs production  # Production build
tsc -noEmit -skipLibCheck           # Type-check only (run before production build)
eslint .                            # Lint a single package
```

There are no automated tests — plugins are tested manually via the Obsidian runtime.

## Architecture

### Monorepo structure

- `build-tools/` — Shared build infrastructure (esbuild config, tsconfig base, version-bump script). Not an Obsidian plugin.
- `packages/<name>/` — Each Obsidian plugin. Source lives in `src/`, build output in a subdirectory named after the plugin ID.
- Root `package.json` provides convenience scripts that delegate to all packages via `pnpm --filter`.

### Shared build system (`build-tools/esbuild.config.mjs`)

All packages call `createBuildContext(options)` from build-tools and pass a minimal config. The shared function handles:
- Bundling with esbuild (CJS, ES2018, tree-shaking)
- Marking Obsidian/Electron/CodeMirror packages as external (not bundled)
- Copying `manifest.json` and `styles.css` to the output directory
- Copying the built `main.js` to the package root (required by Obsidian to load the plugin)
- In dev mode: symlinking the build output into the local Obsidian vault at `/Users/yeyan1996/Library/Mobile Documents/iCloud~md~obsidian/Documents/default/.obsidian/plugins`
- In production mode: copying instead of symlinking

Each package's `esbuild.config.mjs` is ~5 lines and only specifies what's unique (entry point, output directory, any `onBuildEnd` hooks).

### Per-package TypeScript config

Each `tsconfig.json` extends `../../build-tools/tsconfig.base.json`. The base config enables strict TypeScript (noImplicitAny, strictNullChecks, noImplicitReturns, etc.), targets ES6, and uses `src` as `baseUrl`.

### Plugin architecture pattern

All plugins extend Obsidian's `Plugin` class:
- `onload()` — register commands, settings tabs, workspace events, DOM event listeners
- `onunload()` — cleanup (Obsidian auto-cleans anything registered via `registerEvent`, `registerDomEvent`, `registerInterval`)

Settings are persisted via `this.loadData()` / `this.saveData()` which writes to `.obsidian/plugins/<id>/data.json` and syncs automatically with Obsidian Sync.

More complex plugins (file-explorer) split features into dedicated manager classes (e.g., `PinnedItemsManager`, `FolderNoteManager`) that are instantiated in `onload()`. Each manager owns its own event listeners and DOM mutations.

### Obsidian-specific conventions

- File explorer DOM: nodes have `data-path` attributes for identifying files/folders
- Context detection: check `this.app.workspace.activeLeaf` or event targets to distinguish editor vs. file-explorer vs. preview
- Hotkeys: registered via `addCommand({ hotkeys: [...] })`
- Context menus: `app.workspace.on('file-menu', ...)` and `app.workspace.on('editor-menu', ...)`

### ESLint

Uses ESLint 9 flat config (`eslint.config.mts`) with `typescript-eslint` strict mode and `eslint-plugin-obsidianmd` for Obsidian-specific rules. The config lives per-package, not at the root.
