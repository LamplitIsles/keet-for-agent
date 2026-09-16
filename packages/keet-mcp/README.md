# Keet MCP Gateway

**`keet-mcpd` is one persistent, bearer-protected loopback MCP endpoint for the five explicit Keet destination tools.**

```bash
KEET_MCP_RUNTIME_DIR=/opt/keet/4.21.0-linux-x64 \
KEET_MCP_IDENTITY_DIR=/var/lib/keet-mcp/identity \
KEET_MCP_WORKSPACE_ROOT=/srv/keet-workspace \
KEET_MCP_LISTEN=127.0.0.1:8765 \
KEET_MCP_TOKEN="replace-with-a-secret-of-at-least-32-characters" \
keet-mcpd
```

Use `http://127.0.0.1:8765/mcp` with the token as an HTTP `Authorization: Bearer …` header. There is no unauthenticated health or control route.

## Install

```bash
pnpm install --frozen-lockfile
pnpm build
npm pack ./packages/keet-mcp --pack-destination .local
npm install -g .local/lamplitisles-keet-mcp-0.1.0.tgz
```

The Keet runtime is deliberately not part of the package. Prepare the operator-supplied pinned Linux x64 runtime with [the workspace runtime guide](../../docs/runtime-extraction.md).

## Configuration

| Variable | Meaning |
| --- | --- |
| `KEET_MCP_RUNTIME_DIR` | Absolute runtime directory containing `bare` and `core-worker.bundle`. |
| `KEET_MCP_IDENTITY_DIR` | Absolute writable identity-data directory, created owner-only when missing. |
| `KEET_MCP_WORKSPACE_ROOT` | Absolute existing root from which image paths may be sent. |
| `KEET_MCP_LISTEN` | Loopback-only `127.0.0.1:port` or `::1:port`. |
| `KEET_MCP_TOKEN` | Bearer token at least 32 characters long. Never put it in a URL. |

The runtime, identity, and workspace paths must not overlap. Configuration errors and Core ownership failures happen before a usable HTTP listener is exposed. A daemon has one immutable startup snapshot of eligible Default rooms, Broadcasts, and complete accepted DMs; restart it to discover later room changes.

Each request to `/mcp`, including MCP `DELETE` session termination, requires the bearer token. The daemon retains at most 64 active MCP sessions; new session initialization receives `429` until an existing session is closed or terminated. This is a bounded local-service guard, not a substitute for operator authentication.

Core holds an exclusive kernel lock on the identity directory for its lifetime. Stop the DSH Keet bridge, Impri adapter, or another gateway using that same identity before starting this daemon. Do not delete `.keet-sidecar.lock`: the open kernel lock, not file presence, denotes ownership.

## MCP tools

| Tool | Scope |
| --- | --- |
| `keet_list_groups` | Lists the admitted startup destinations as `{ groupName, kind }`. |
| `keet_list_members` | Lists bounded display names for a group or DM; Broadcast rosters are rejected. |
| `keet_read_recent_messages` | Reads 1–50 text-only records without changing read state. DM records omit IDs and reply provenance. |
| `keet_send_message` | Sends non-empty text; regular groups support canonical replies and unique exact-name native mentions. |
| `keet_send_image` | Sends a workspace-contained PNG, JPEG, WebP, or GIF, then an optional caption. Caption failure after image success is a no-retry partial delivery. |

There are no subscriptions, incoming-message delivery, room onboarding, reactions, profiles, usernames, or stdio transport in this release. The daemon serializes sends per destination. Core remains the authority for current native posting permissions.

## Verification

```bash
pnpm check
pnpm test
pnpm build
pnpm pack-smoke
```

`pnpm pack-smoke` retains the DSH Loader artifact smoke and separately packs the gateway, checks machine-consumed contents, and runs its `--help` executable surface. It does not contact Keet. Official-runtime interoperability is not established by these checks.

## License

Apache-2.0. See [LICENSE](LICENSE).
