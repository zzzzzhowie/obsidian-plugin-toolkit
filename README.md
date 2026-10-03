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
│   ├── image-auto-upload-enhanced/         # @obsidian-plugin-toolkit/image-auto-upload-enhanced
│   ├── mermaid-enhanced/                   # @obsidian-plugin-toolkit/mermaid-enhanced
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
pnpm dev:file-explorer              # File Explorer (Enhanced)
pnpm dev:copy-path                  # Copy Path
pnpm dev:paste-enhanced             # Paste (Enhanced)
pnpm dev:hide-ui-elements           # Hide UI Elements
pnpm dev:image-auto-upload-enhanced # Image Auto Upload (Enhanced)
pnpm dev:mermaid-enhanced           # Mermaid (Enhanced)
pnpm dev:line-numbers               # Line Numbers
pnpm dev:nav-history                # Nav History
pnpm dev:note-comments              # Note Comments
pnpm dev:quick-open                 # Quick Open
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
pnpm build:image-auto-upload-enhanced
pnpm build:mermaid-enhanced
pnpm build:line-numbers
pnpm build:nav-history
pnpm build:note-comments
pnpm build:quick-open
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

### @obsidian-plugin-toolkit/image-auto-upload-enhanced
Upload images from your clipboard via PicGo.

### @obsidian-plugin-toolkit/mermaid-enhanced
Enhance Mermaid diagrams: fit tall diagrams to one screen (with a per-diagram size slider) and click to open a zoomable, pannable overlay.

### @obsidian-plugin-toolkit/line-numbers
Show whole-document line numbers in the editor gutter (every line, not just fenced code blocks). Absolute / relative / hybrid (vim-style) numbering.

### @obsidian-plugin-toolkit/nav-history
VS Code style global Go Back / Go Forward (`Ctrl+-` / `Ctrl+Shift+-`). Unlike Obsidian's built-in per-tab `app:go-back`, this keeps one navigation stack for the whole workspace, restores the exact cursor position you left, and reopens a tab that was closed rather than taking over the one you are looking at.

### @obsidian-plugin-toolkit/note-comments
Select text and comment on it (`Cmd/Ctrl+Option/Alt+M`, or the editor menu). Commented passages are highlighted; resting the pointer on one shows its comment in a small read-only card, and clicking one opens a Comments panel in the right sidebar that lists the note's comments, and clicking elsewhere puts the previous tab back. Comments are written and edited in that panel, in a full Obsidian editor — images, mermaid and paste handlers such as the image uploader work there too (Enter saves, Shift+Enter is a new line). They are stored in the plugin's data file, so the Markdown is never touched: a comment is found again by its quoted text and surrounding context, not by a marker — with formatting (whitespace, Markdown markup, punctuation) ignored, so reformatting a note doesn't lose its comments — and one whose words were actually rewritten stays in the panel, marked as not found. Editor-only (Live Preview and source); text inside rendered tables, callouts and embeds can't carry a comment yet.

### @obsidian-plugin-toolkit/quick-open
VS Code's Go to File on `Cmd/Ctrl+P` (the command palette moves to `Cmd/Ctrl+Shift+P`, as in VS Code). With nothing typed it lists recently opened files, most recent first; typing fuzzy-matches file names (or whole paths once the query has a `/`) and notes' `aliases` — an alias match shows as its own row, the alias with the note it stands for, as in Obsidian's switcher — recently opened matches first, then the rest of the vault. `name:42` opens at a line, `:42` goes to a line in the current note, `@` lists its headings. Enter opens — in the tab the file already has in the current group, or a new tab, never over the note you're in — and `Cmd/Ctrl+Enter` opens to the side. Pressing `P` again with `Cmd/Ctrl` held moves down the list, and letting go opens the selection. The recent list is shared between devices through the plugin's data.json: each device records when it last opened each file and copies are merged entry by entry (later time wins, removals included), so one device never overwrites another's list the way Obsidian's own recent list in workspace.json does. It starts from Obsidian's and the Recent Files plugin's lists, and vault-backup leaves it out of backups. On mobile it takes over the search button in the middle of the navbar; on a phone a file opens in the tab that already has it, else in the current tab, and there is no opening to the side.

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
