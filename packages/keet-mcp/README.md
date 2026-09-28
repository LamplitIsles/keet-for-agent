# Keet MCP Gateway

**`keet-mcpd` is one persistent, bearer-protected loopback gateway for five explicit Keet destination tools and an optional incoming-text webhook.**

```bash
KEET_MCP_RUNTIME_DIR=/opt/keet/4.22.0-linux-x64 \
KEET_MCP_IDENTITY_DIR=/var/lib/keet-mcp/identity \
KEET_MCP_WORKSPACE_ROOT=/srv/keet-workspace \
KEET_MCP_STATE_DIR=/var/lib/keet-mcp/state \
KEET_WEBHOOK_URL=http://127.0.0.1:3080/api/keet/events \
KEET_WEBHOOK_BEARER_TOKEN="optional-separate-webhook-secret" \
KEET_MCP_LISTEN=127.0.0.1:8765 \
KEET_MCP_TOKEN="replace-with-a-secret-of-at-least-32-characters" \
keet-mcpd
```

Use `http://127.0.0.1:8765/mcp` with the token as an HTTP `Authorization: Bearer …` header. The webhook bearer token, if set, is separate from the MCP token. There is no unauthenticated health or control route.

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
| `KEET_MCP_WORKSPACE_ROOT` | Absolute existing root from which file paths may be sent. |
| `KEET_MCP_STATE_DIR` | Required absolute owner-only directory for pending webhook events and sequence state. |
| `KEET_WEBHOOK_URL` | Optional HTTPS or loopback-HTTP receiver URL. Credentials and fragments are rejected. |
| `KEET_WEBHOOK_BEARER_TOKEN` | Optional separate bearer token; requires `KEET_WEBHOOK_URL` and never belongs in its URL. |
| `KEET_MCP_LISTEN` | Loopback-only `127.0.0.1:port` or `::1:port`. |
| `KEET_MCP_TOKEN` | Bearer token at least 32 characters long. Never put it in a URL. |

The runtime, identity, workspace, and state paths must not overlap. Configuration errors and Core ownership failures happen before a usable HTTP listener is exposed. A daemon has one immutable startup snapshot of eligible Default rooms, Broadcasts, and complete accepted DMs; restart it to discover later room changes.

Each request to `/mcp`, including MCP `DELETE` session termination, requires the bearer token. The daemon retains at most 64 active MCP sessions; new session initialization receives `429` until an existing session is closed or terminated. This is a bounded local-service guard, not a substitute for operator authentication.

Core holds an exclusive kernel lock on the identity directory for its lifetime. Stop the Impri adapter, another gateway, or any other process using that same identity before starting this daemon. Do not delete `.keet-sidecar.lock`: the open kernel lock, not file presence, denotes ownership.

## Human identity setup

`keet-mcp-setup` uses the same pinned runtime and identity as `keet-mcpd`, but
does not need the gateway token or expose these mutations as Agent tools. Set
`KEET_MCP_RUNTIME_DIR` and `KEET_MCP_IDENTITY_DIR` to the gateway's exact values.
The identity directory must already exist; a missing path cannot create a new identity.
Stop the process holding that identity before running a command, then restart
the gateway to refresh its admitted destination snapshot. Incoming webhook
delivery resumes from the persisted pending queue when the gateway restarts.

```text
keet-mcp-setup status
keet-mcp-setup list
keet-mcp-setup inspect                       # invitation from stdin
keet-mcp-setup join                          # invitation from stdin
keet-mcp-setup dm-requests
keet-mcp-setup dm-accept --member-id ID
keet-mcp-setup leave --group-id ID --yes     # joined Default groups only
keet-mcp-setup profile --display-name NAME [--avatar FILE]
keet-mcp-setup profile --avatar FILE
keet-mcp-setup username --username NAME
```

`join` and `inspect` accept one `keet://chat/...` URL, up to 8192 bytes, from
stdin only. Keep invitations out of command arguments, shell history, files,
logs, and exported environment variables. A terminal can read one without echoing it:

```sh
(
  set -e
  trap 'systemctl --user start keet-mcp.service' EXIT
  systemctl --user stop keet-mcp.service
  read -r -s -p 'Keet invitation: ' invitation
  printf '\n'
  printf '%s' "$invitation" | keet-mcp-setup join
)
```

This example assumes the two path variables are already exported and the
named service is the one that owns that identity. It does not stop a separate
Impri identity or a Partner service. Avoid joining during active group traffic:
the gateway cannot observe messages while stopped. `leave` requires `--yes`
and checks the selected room is a joined ordinary group before native departure.
Profile avatars accept local PNG, JPEG, or WebP files up to 8 MiB and are
prepared as three bounded square variants. A username result of `pending`
returns a nonzero exit code; inspect the JSON result before retrying.

## MCP tools

| Tool | Scope |
| --- | --- |
| `list_destinations` | Lists the admitted startup destinations as `{ destinationName, kind }`. |
| `list_members` | Lists bounded display names for a group or DM; Broadcast rosters are rejected. |
| `read_recent_messages` | Reads 1–50 text-only records without changing read state. DM records omit IDs and reply provenance. |
| `send_message` | Sends non-empty text; regular groups support canonical replies and unique exact-name native mentions. |
| `send_file` | Sends one workspace-contained ordinary file up to 100 MiB. PNG, JPEG, WebP, and GIF files retain native image presentation and a generated preview. |

## Incoming webhook

When `KEET_WEBHOOK_URL` is set, KFA observes every admitted non-self,
text-bearing Group, DM, and Broadcast message and POSTs it to that URL. A
captioned image contributes its text only; image-only messages are omitted.
Each JSON body has `type: "message"`, UUID `eventId`, positive `sequence`,
canonical `messageId`, safe-integer `timestamp`, `destination`, `senderLabel`,
bounded text, and optional `replyTo` and `trigger` (`mention`, `label`,
`reply`, or `dm`). It never includes Keet IDs other than the message ID, native
records, image data, paths, or credentials.

KFA appends and syncs an event before its first request. It sends one event at
a time; only a 2xx response removes the head event. Timeouts, network errors,
redirects, and non-2xx responses use bounded backoff and keep later events
behind it. The stable `eventId` makes at-least-once retries and restarts safe
for a receiver that persists then deduplicates before returning success. There
is no `/cfl` route, WebSocket replay protocol, or local inbound-media library.
If event persistence or intake fails, the daemon reports a fatal error and
exits nonzero. A graceful shutdown finishes accepted persistence work before
releasing the Core identity; an interrupted HTTP request may be retried.

The gateway exposes no room-onboarding, reaction, profile, username, or stdio
tools; human setup uses the separate local CLI above. The daemon serializes
sends per destination. Core remains the authority for current native posting
permissions.

## Verification

```bash
pnpm check
pnpm test
pnpm build
pnpm pack-smoke
```

`pnpm pack-smoke` packs the gateway, checks its machine-consumed contents,
removed WebSocket dependency, notices, and `--help` executable surface. It does
not contact Keet. Official-runtime interoperability is not
established by these checks.

## License

Apache-2.0. See [LICENSE](LICENSE).
