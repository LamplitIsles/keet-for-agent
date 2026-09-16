# Keet MCP Gateway

**`keet-mcpd` is one persistent, bearer-protected loopback gateway for five explicit Keet destination tools and CFL's incoming event feed.**

```bash
KEET_MCP_RUNTIME_DIR=/opt/keet/4.21.0-linux-x64 \
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
| `KEET_MCP_WORKSPACE_ROOT` | Absolute existing root from which image paths may be sent. |
| `KEET_MCP_STATE_DIR` | Required absolute owner-only directory for the CFL event journal and its temporary replacement file. It is not a media directory. |
| `KEET_CFL_MEDIA_DIR` | Required absolute owner-only durable media library for materialized inbound DM images. It is written only by the daemon and read locally by CFL under the same service account. |
| `KEET_CFL_EVENT_RETENTION` | Optional positive number of retained CFL events; defaults to `10000`. |
| `KEET_MCP_LISTEN` | Loopback-only `127.0.0.1:port` or `::1:port`. |
| `KEET_MCP_TOKEN` | Bearer token at least 32 characters long. Never put it in a URL. |

The runtime, identity, workspace, state, and media paths must not overlap. Configuration errors and Core ownership failures happen before a usable HTTP listener is exposed. A daemon has one immutable startup snapshot of eligible Default rooms, Broadcasts, and complete accepted DMs; restart it to discover later room changes.

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
must reconcile explicitly (for example with `keet_read_recent_messages`),
deduplicate replayed events, persist its next checkpoint, and decide whether or
how to inject the data into a Codex turn. Delivery is at least once across
reconnects; the journal is a bounded replay buffer, not a per-CFL queue.

There are no room-onboarding, reaction, profile, username, or stdio surfaces in
this release. The daemon serializes sends per destination. Core remains the
authority for current native posting permissions.

## Verification

```bash
pnpm check
pnpm test
pnpm build
pnpm pack-smoke
```

`pnpm pack-smoke` packs the gateway, checks its machine-consumed contents,
direct WebSocket dependency, notices, and `--help` executable surface. It does
not contact Keet or start DSH. Official-runtime interoperability is not
established by these checks.

## License

Apache-2.0. See [LICENSE](LICENSE).
