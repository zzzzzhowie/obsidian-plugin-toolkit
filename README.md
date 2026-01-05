# Obsidian Plugin Toolkit

A monorepo for Obsidian plugins managed with pnpm workspace.

## Project Structure

```
obsidian-plugin-toolkit/
├── build-tools/                            # Shared build tools
│   ├── esbuild.config.mjs                 # Unified esbuild configuration
│   ├── version-bump.mjs                   # Version bump script
│   └── tsconfig.base.json                 # TypeScript base configuration
├── packages/
│   ├── file-explorer/                     # @obsidian-plugin-toolkit/file-explorer-enhancements
│   ├── copy-path/                          # @obsidian-plugin-toolkit/copy-path
│   └── paste-enhanced/                     # @obsidian-plugin-toolkit/paste-enhanced
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

## Installation

```bash
pnpm install
```

## Development

Run all plugins in development mode:

```bash
pnpm dev
```

Run a specific plugin in development mode:

```bash
pnpm dev:file-explorer    # File Explorer Enhancements
pnpm dev:copy-path        # Copy Path Plugin
pnpm dev:paste-enhanced   # Paste Enhanced Plugin
```

Or use filter:

```bash
pnpm --filter @obsidian-plugin-toolkit/file-explorer-enhancements dev
pnpm --filter @obsidian-plugin-toolkit/copy-path dev
pnpm --filter @obsidian-plugin-toolkit/paste-enhanced dev
```

## Build

Build all plugins:

```bash
pnpm build
```

Build a specific plugin:

```bash
pnpm build:file-explorer
pnpm build:copy-path
pnpm build:paste-enhanced
```

## Lint

Run lint for all plugins:

```bash
pnpm lint
```

## Plugins

### @obsidian-plugin-toolkit/file-explorer-enhancements
Enhanced file explorer with pinned items, folder notes, and file count display.

### @obsidian-plugin-toolkit/copy-path
Copy absolute path of current file with optional header anchor (cmd+option+C).

### @obsidian-plugin-toolkit/paste-enhanced
Enhanced paste functionality plugin.

## Tech Stack

- **Package Manager**: pnpm workspace
- **TypeScript**: 5.8.3
- **Build Tool**: esbuild 0.25.5
- **Linting**: ESLint + TypeScript ESLint

## Shared Configuration

This project uses shared build tools to unify configuration:

- **esbuild Configuration**: All projects use the unified configuration function from `build-tools/esbuild.config.mjs`
- **TypeScript Configuration**: All projects extend `build-tools/tsconfig.base.json` base configuration
- **Version Bump Script**: All projects share `build-tools/version-bump.mjs`

This ensures all plugins maintain consistent build configuration for easier maintenance and updates.
