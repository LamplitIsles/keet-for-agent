#!/usr/bin/env node
import { configurationFromEnvironment, KeetMcpGateway } from "./index.js"

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: keet-mcpd\n\nRequired environment: KEET_MCP_RUNTIME_DIR, KEET_MCP_IDENTITY_DIR, KEET_MCP_WORKSPACE_ROOT, KEET_MCP_STATE_DIR, KEET_MCP_LISTEN, KEET_MCP_TOKEN\nOptional environment: KEET_CFL_EVENT_RETENTION (positive integer; default 10000)")
} else {
  const gateway = new KeetMcpGateway({ config: configurationFromEnvironment() })
  const stop = () => { void gateway.close().finally(() => process.exit(0)) }
  process.once("SIGINT", stop); process.once("SIGTERM", stop)
  gateway.start().then(() => console.log(`Keet MCP gateway listening at ${gateway.address}`)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Keet MCP gateway failed to start."); process.exitCode = 1 })
}
