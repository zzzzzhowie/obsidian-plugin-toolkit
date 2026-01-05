# Changelog

## 2024 - Monorepo Refactoring

### Compatibility Fixes

1. **Unified TypeScript Version**
   - All projects now use TypeScript 5.8.3
   - Fixed peer dependency warnings for typescript-eslint 8.35.1

2. **Unified Build Tool Versions**
   - All projects now use esbuild 0.25.5
   - Unified @types/node to ^20.0.0

3. **Added peerDependencies**
   - Added obsidian peerDependencies configuration for copy-path and paste-enhanced
   - Reduced dependency warnings

### Project Structure Reorganization

1. **Unified Project Naming**
   - `file-explorer-enhancements` → `@obsidian-plugin-toolkit/file-explorer-enhancements`
   - `obsidian-plugin-copy-path` → `@obsidian-plugin-toolkit/copy-path`
   - `obsidian-sample-plugin` → `@obsidian-plugin-toolkit/paste-enhanced`

2. **Unified Build Output Directories**
   - `file-explorer`: `obsidian-plugin-file-explorer/`
   - `copy-path`: `obsidian-plugin-copy-path/`
   - `paste-enhanced`: `obsidian-plugin-paste-enhanced/`
   - All build outputs copy `main.js` to project root (required by Obsidian)

3. **Directory Renaming**
   - `obsidian-plugin` → `file-explorer`
   - `obsidian-plugin-copy-path` → `copy-path`
   - `obsidian-plugin-paste-enhanced` → `paste-enhanced`
   - Removed `obsidian-plugin` prefix from all directory names for cleaner structure

4. **Cleaned Up Old Build Files**
   - Removed old build output directories
   - Updated `.gitignore` to ignore build files

### Configuration Optimization

1. **Root Scripts**
   - Added convenient shortcut scripts (`dev:file-explorer`, `dev:copy-path`, `dev:paste-enhanced`)
   - Support for running specific projects using filter or shortcut scripts

2. **Added Configuration Files**
   - `.npmrc`: Configure pnpm behavior
   - `.gitignore`: Ignore build outputs and dependencies

3. **ESLint Configuration**
   - Added lint script to `file-explorer`
   - Kept ESLint configurations independent for each project

### Documentation Updates

- Updated README.md to reflect new project structure and naming
- Added tech stack documentation
