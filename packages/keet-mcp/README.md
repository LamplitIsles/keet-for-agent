# Keet MCP Gateway

**`keet-mcpd` is one persistent, bearer-protected loopback gateway for five explicit Keet destination tools and CFL's incoming event feed.**

```bash
KEET_MCP_RUNTIME_DIR=/opt/keet/4.22.0-linux-x64 \
KEET_MCP_IDENTITY_DIR=/var/lib/keet-mcp/identity \
KEET_MCP_WORKSPACE_ROOT=/srv/keet-workspace \
KEET_MCP_STATE_DIR=/var/lib/keet-mcp/state \
KEET_CFL_MEDIA_DIR=/var/lib/keet-mcp/cfl-media \
KEET_CFL_EVENT_RETENTION=10000 \
KEET_MCP_LISTEN=127.0.0.1:8765 \
KEET_MCP_TOKEN="replace-with-a-secret-of-at-least-32-characters" \
keet-mcpd
```

Use `http://127.0.0.1:8765/mcp` with the token as an HTTP `Authorization: Bearer …` header. CFL uses the same bearer token to connect to `ws://127.0.0.1:8765/cfl`. There is no unauthenticated health or control route.

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
| `KEET_MCP_STATE_DIR` | Required absolute owner-only directory for the CFL event journal and its temporary replacement file. It is not a media directory. |
| `KEET_CFL_MEDIA_DIR` | Required absolute owner-only durable media library for materialized inbound DM images. It is written only by the daemon and read locally by CFL under the same service account. |
| `KEET_CFL_EVENT_RETENTION` | Optional positive number of retained CFL events; defaults to `10000`. |
| `KEET_MCP_LISTEN` | Loopback-only `127.0.0.1:port` or `::1:port`. |
| `KEET_MCP_TOKEN` | Bearer token at least 32 characters long. Never put it in a URL. |

The runtime, identity, workspace, state, and media paths must not overlap. Configuration errors and Core ownership failures happen before a usable HTTP listener is exposed. A daemon has one immutable startup snapshot of eligible Default rooms, Broadcasts, and complete accepted DMs; restart it to discover later room changes.

Each request to `/mcp`, including MCP `DELETE` session termination, requires the bearer token. The daemon retains at most 64 active MCP sessions; new session initialization receives `429` until an existing session is closed or terminated. This is a bounded local-service guard, not a substitute for operator authentication.

Core holds an exclusive kernel lock on the identity directory for its lifetime. Stop the Impri adapter, another gateway, or any other process using that same identity before starting this daemon. Do not delete `.keet-sidecar.lock`: the open kernel lock, not file presence, denotes ownership.

## Human identity setup

`keet-mcp-setup` uses the same pinned runtime and identity as `keet-mcpd`, but
does not need the gateway token or expose these mutations as Agent tools. Set
`KEET_MCP_RUNTIME_DIR` and `KEET_MCP_IDENTITY_DIR` to the gateway's exact values.
The identity directory must already exist; a missing path cannot create a new identity.
Stop the process holding that identity before running a command, then restart
the gateway to refresh its admitted destination snapshot. CFL reconnects to the
gateway; its service does not need to stop.

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

## CFL event feed

`/cfl` is a WebSocket event feed for the CFL process; it is not an MCP tool and
it never selects an Agent, injects context, stores a read receipt, or sends a
Keet reply. It observes new non-self records in the immutable admitted
destination snapshot. Every frame retains its bounded source text and may carry
the gateway-owned `trigger` classification: `mention`, `label`, `reply`, or
`dm`. A Group value means, respectively, a verified native mention of the
Integration Identity, a literal occurrence of its current display label, or a
reply to a known Integration-authored Keet message. `dm` marks every external
DM. Unqualified Group and every Broadcast frame omit `trigger`. The gateway
does not decide what CFL buffers or admits from these facts.

For a direct message only, an image-only record or captioned image record is
published after every native image has been read and atomically materialized in
`KEET_CFL_MEDIA_DIR`. Its ordered `images` array contains only
`{ "filename", "mediaType", "name"? }`; `filename` is a generated relative
basename, never a path or a Core identifier. CFL resolves that basename below
its configured KFA media-library root and may use the resulting file directly
as its native local-image input. Group and Broadcast records remain text-only,
including captioned images.

The WebSocket upgrade requires the same `Authorization: Bearer …` header as
`/mcp`. Compression is disabled. The first and only client frame must be:

```json
{"type":"hello","afterSequence":42}
```

The feed admits at most 64 active WebSocket clients and requires this `hello`
within 10 seconds of connection; an idle or malformed client is closed without
affecting another consumer.

`afterSequence` is optional and is a CFL-owned durable checkpoint. The gateway
first sends `ready`, containing the nullable retained range and the immutable
`{ "groupName", "kind" }` destination snapshot. It then sends each retained
`message` whose monotonically increasing `sequence` is greater than the
checkpoint, followed by live messages in the same order. Each message contains
only its sequence, canonical Keet message id, source timestamp, destination,
bounded sender label, text, optional canonical reply id, and optional trigger
classification. Eligible DM image messages additionally contain the bounded
metadata above; image bytes, source paths, hashes, and native descriptors never
enter the frame or journal. The event journal is bounded by
`KEET_CFL_EVENT_RETENTION`; media is not. Journal compaction, gateway restart,
and event-append failure recovery never delete a published media file.
Operators must provision and back up this append-only media library and must
not manually delete a file while CFL history still references it.

If a supplied checkpoint is older than the retained window, the gateway sends
one `resync_required` frame with that window's range and closes the socket. CFL
must reconcile explicitly (for example with `read_recent_messages`),
deduplicate replayed events, persist its next checkpoint, and decide whether or
how to inject the data into a Codex turn. Delivery is at least once across
reconnects; the journal is a bounded replay buffer, not a per-CFL queue.

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
direct WebSocket dependency, notices, and `--help` executable surface. It does
not contact Keet. Official-runtime interoperability is not
established by these checks.

## License

Apache-2.0. See [LICENSE](LICENSE).
