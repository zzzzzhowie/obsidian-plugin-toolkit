import { createBuildContext } from "../../build-tools/esbuild.config.mjs";

await createBuildContext({
  distDir: "image-auto-upload-enhanced",
});
