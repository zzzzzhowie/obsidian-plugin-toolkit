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
│   ├── paste-enhanced/                     # @obsidian-plugin-toolkit/paste-enhanced
│   ├── hide-ui-elements/                   # @obsidian-plugin-toolkit/hide-ui-elements
│   ├── image-zoom/                         # @obsidian-plugin-toolkit/image-zoom
│   ├── image-auto-upload-enhanced/         # @obsidian-plugin-toolkit/image-auto-upload-enhanced
│   ├── mermaid-fit/                        # @obsidian-plugin-toolkit/mermaid-fit
│   └── line-numbers/                        # @obsidian-plugin-toolkit/line-numbers
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
pnpm dev:file-explorer              # File Explorer Enhancements
pnpm dev:copy-path                  # Copy Path
pnpm dev:paste-enhanced             # Paste Enhanced
pnpm dev:hide-ui-elements           # Hide UI Elements
pnpm dev:image-zoom                 # Image Zoom
pnpm dev:image-auto-upload-enhanced # Image Auto Upload Enhanced
pnpm dev:mermaid-fit                # Mermaid Fit
pnpm dev:line-numbers               # Line Numbers
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
pnpm build:hide-ui-elements
pnpm build:image-zoom
pnpm build:image-auto-upload-enhanced
pnpm build:mermaid-fit
pnpm build:line-numbers
```

## Lint

Run lint for all plugins:

```bash
pnpm lint
```

## Plugins

### @obsidian-plugin-toolkit/file-explorer-enhancements
Enhanced file explorer with pinned items, folder notes, file count display, and file/folder hiding (right-click to hide, wildcard patterns, toggle-visibility command).

### @obsidian-plugin-toolkit/copy-path
Copy absolute path of current file with optional header anchor (cmd+option+C).

### @obsidian-plugin-toolkit/paste-enhanced
Enhanced paste functionality that automatically detects code blocks and pastes content accordingly.

### @obsidian-plugin-toolkit/hide-ui-elements
Toggle visibility of sidebar tabs and status bar items.

### @obsidian-plugin-toolkit/image-zoom
Click to zoom images (and Mermaid diagrams) in Obsidian.

### @obsidian-plugin-toolkit/image-auto-upload-enhanced
Upload images from your clipboard via PicGo.

### @obsidian-plugin-toolkit/mermaid-fit
Constrain tall Mermaid diagrams so they fit within one screen (preserves aspect ratio, works with full-width themes).

### @obsidian-plugin-toolkit/line-numbers
Show whole-document line numbers in the editor gutter (every line, not just fenced code blocks). Absolute / relative / hybrid (vim-style) numbering.

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
