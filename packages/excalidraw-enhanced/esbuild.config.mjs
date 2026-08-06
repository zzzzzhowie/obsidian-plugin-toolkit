import { createBuildContext } from "../../build-tools/esbuild.config.mjs";

await createBuildContext({
	distDir: "excalidraw-enhanced",
});
