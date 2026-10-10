# Build Tools

Shared build tools and configurations for unified management of all Obsidian plugin build processes.

## Files

### `esbuild.config.mjs`

Unified esbuild build configuration function `createBuildContext()`, providing the following features:

- Unified build configuration (external, format, target, etc.)
- Automatically copy manifest.json and styles.css to build directory
- Automatically copy main.js to project root (required by Obsidian)
- Support for custom options:
  - `distDir`: Build output directory (default `dist`); the vault folder is always named after the manifest `id`
  - `entryPoint`: Entry file (default "src/main.ts")
  - `minify`: Whether to minify (default true)
  - `keepNames`: Whether to keep function names (default false)
  - `onBuildEnd`: Callback function when build ends

**Usage Example:**

```javascript
import { createBuildContext } from "../../build-tools/esbuild.config.mjs";

await createBuildContext(); // builds into dist/, copied to <vault>/.obsidian/plugins/<manifest id>/
```

### `version-bump.mjs`

Version bump script for automatically updating manifest.json and versions.json during builds.

### `tsconfig.base.json`

TypeScript base configuration containing shared compilation options for all projects.

Each project's `tsconfig.json` extends this configuration via `extends` and can override specific options.

## Benefits

1. **Code Reuse**: esbuild configuration for three projects reduced from ~300+ lines to ~20 lines (3-5 lines per project)
2. **Unified Maintenance**: Build configuration updates only need to be made in one place
3. **Consistency**: Ensures all plugins have consistent build behavior
4. **Flexibility**: Supports customizing build behavior for specific projects via options
