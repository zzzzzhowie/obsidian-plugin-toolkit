import { createBuildContext, updateManifestVersion } from "../../build-tools/esbuild.config.mjs";

await createBuildContext({
	minify: false,
	keepNames: true,
	onBuildEnd: () => {
		updateManifestVersion();
	},
});
