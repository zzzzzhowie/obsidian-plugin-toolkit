import { createBuildContext } from "../../build-tools/esbuild.config.mjs";

await createBuildContext({
	// Output folder must match the manifest "id" so the build syncs to the same
	// folder Obsidian loads the plugin from (avoids duplicate plugin folders).
	distDir: "file-explorer-enhancements",
});
