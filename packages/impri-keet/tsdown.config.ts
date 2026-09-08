import { defineConfig } from "tsdown"

export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  fixedExtension: false,
  dts: false,
  sourcemap: false,
  clean: true,
  deps: {
    alwaysBundle: ["@lamplitisles/keet-integration-core"],
    neverBundle: ["fs-native-extensions", "tiny-buffer-rpc", "tiny-buffer-rpc/any.js"],
  },
})
