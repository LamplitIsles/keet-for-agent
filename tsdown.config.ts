import { defineConfig, type UserConfig } from "tsdown"

const mcpBuild: UserConfig = {
  entry: { index: "packages/keet-mcp/src/index.ts", cli: "packages/keet-mcp/src/cli.ts" },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "packages/keet-mcp/dist",
  fixedExtension: false,
  sourcemap: false,
  dts: { generator: "tsgo" as const, sourcemap: false },
  clean: true,
  // The public package carries its normal runtime dependencies. Keep native
  // addons and the MCP SDK external so its ESM artifact never embeds CJS
  // native-loader code.
  deps: { neverBundle: true, alwaysBundle: ["@lamplitisles/keet-integration-core"] },
}

export default defineConfig([mcpBuild])
