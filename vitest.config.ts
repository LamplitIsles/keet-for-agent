import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@lamplitisles/keet-integration-core": path.join(root, "packages/keet-core/src/index.ts")
    }
  },
  test: { environment: "node" }
});
