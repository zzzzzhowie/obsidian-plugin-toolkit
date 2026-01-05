import { createBuildContext, updateManifestVersion } from "../../build-tools/esbuild.config.mjs";

await createBuildContext({
	distDir: "obsidian-plugin-paste-enhanced",
	minify: false,
	keepNames: true,
	onBuildEnd: () => {
		updateManifestVersion();
	},
});
