import { defineConfig, type TsdownPlugin, type UserConfig } from "tsdown"
import { compileCssModule } from "./scripts/css-modules.ts"

const dshExternals = [
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-agent/client",
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-api-remotes/client",
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-api-session-controller/client",
  "@deepseek-ai/dsh-api-workspace-controller",
  "@deepseek-ai/dsh-api-workspace-controller/client",
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-connection/client",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-locale/client",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-primitives/client",
  "@deepseek-ai/dsh-client-ui-settings",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-ui-settings-plugins",
  "@deepseek-ai/dsh-client-ui-settings-plugins/client",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-slots/client",
  "@deepseek-ai/dsh-client-ui-workspace",
  "@deepseek-ai/dsh-client-ui-workspace/client",
  "@deepseek-ai/dsh-commands",
  "@deepseek-ai/dsh-credentials",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-settings",
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/dsh-workspace",
  "@deepseek-ai/schemastery",
  "react",
  "react/jsx-runtime",
  "fs-native-extensions",
  "sharp",
]

function cssModulesPlugin(): TsdownPlugin {
  return {
    name: "dsh-keet-css-modules",
    async load(id) {
      if (!id.endsWith(".module.dshcss")) return null
      const { css, classes } = await compileCssModule(id)
      const styleId = "@lamplitisles/dsh-keet/keet.module.css"
      return {
        moduleType: "js",
        code: [
          `const css = ${JSON.stringify(css)};`,
          `const styleId = ${JSON.stringify(styleId)};`,
          "if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=\"${styleId}\"]`) === null) {",
          "  const tag = document.createElement('style');",
          "  tag.dataset.plugin = '@lamplitisles/dsh-keet';",
          "  tag.dataset.pluginCss = styleId;",
          "  tag.textContent = css;",
          "  document.head.appendChild(tag);",
          "}",
          `export default ${JSON.stringify(classes)};`,
        ].join("\n"),
      }
    },
  }
}

const esmBuild: UserConfig = {
  entry: {
    index: "packages/dsh-keet/src/index.ts",
    setup: "packages/dsh-keet/src/setup.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "packages/dsh-keet/dist",
  fixedExtension: false,
  sourcemap: false,
  dts: { generator: "tsgo" as const, sourcemap: false },
  clean: true,
  deps: { neverBundle: dshExternals },
}

const clientBuild: UserConfig = {
  entry: { client: "packages/dsh-keet/src/client.ts" },
  format: ["cjs"],
  platform: "browser",
  target: "es2022",
  outDir: "packages/dsh-keet/dist",
  fixedExtension: false,
  sourcemap: false,
  dts: { generator: "tsgo" as const, sourcemap: false },
  clean: false,
  plugins: [cssModulesPlugin()],
  deps: { neverBundle: dshExternals },
  outExtensions: () => ({ js: ".js", dts: ".d.cts" }),
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "@lamplitisles/dsh-keet", factory: (require) => { var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: "return module.exports; } });" },
}

export default defineConfig([esmBuild, clientBuild])
