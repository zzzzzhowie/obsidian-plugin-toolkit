import { createBuildContext } from "../../build-tools/esbuild.config.mjs";

await createBuildContext({
	distDir: "obsidian-plugin-auto-link-title-enhanced",
});
