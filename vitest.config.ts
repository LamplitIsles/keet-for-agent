import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileCssModule } from "./scripts/css-modules.js";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@lamplitisles/keet-integration-core": path.join(root, "packages/keet-core/src/index.ts")
    }
  },
  plugins: [{
    name: "dsh-keet-css-modules-test",
    enforce: "pre",
    async load(id) {
      if (!id.endsWith(".module.dshcss")) return undefined;
      const { classes } = await compileCssModule(id);
      return `export default ${JSON.stringify(classes)};`;
    }
  }],
  test: {
    environment: "node",
    server: { deps: { inline: ["@deepseek-ai/dsh-client-ui-primitives"] } }
  }
});
