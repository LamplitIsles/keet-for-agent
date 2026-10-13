# Keet MCP Gateway

**`keet-mcpd` is one persistent, bearer-protected loopback gateway for five explicit Keet destination tools and an optional incoming-message webhook.**

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

Use `http://127.0.0.1:8765/mcp` with the token as an HTTP `Authorization: Bearer …` header. The same MCP token protects `GET /images/{ref}`. The webhook bearer token, if set, is separate from the MCP token. There is no unauthenticated health or control route.

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
| `KEET_MCP_STATE_DIR` | Required absolute owner-only directory for pending webhook events, sequence state, and retained original images. |
| `KEET_WEBHOOK_URL` | Optional HTTPS or loopback-HTTP receiver URL. Credentials and fragments are rejected. |
| `KEET_WEBHOOK_BEARER_TOKEN` | Optional separate bearer token; requires `KEET_WEBHOOK_URL` and never belongs in its URL. |
| `KEET_MCP_LISTEN` | Loopback-only `127.0.0.1:port` or `::1:port`. |
| `KEET_MCP_TOKEN` | Bearer token at least 32 characters long. Never put it in a URL. |
| `KEET_MCP_ADMIN_TOKEN` | Optional human management bearer, at least 32 characters and distinct from the MCP token. Absent means management routes return 404. |

The runtime, identity, workspace, and state paths must not overlap. Configuration errors and Core ownership failures happen before a usable HTTP listener is exposed. A daemon has one immutable startup snapshot of eligible Default rooms, Broadcasts, and complete accepted DMs; restart it to discover later room changes.

Each request to `/mcp`, including MCP `DELETE` session termination, requires the bearer token. The daemon retains at most 64 active MCP sessions; new session initialization receives `429` until an existing session is closed or terminated. This is a bounded local-service guard, not a substitute for operator authentication.

Core holds an exclusive kernel lock on the identity directory for its lifetime. Stop the Impri adapter, another gateway, or any other process using that same identity before starting this daemon. Do not delete `.keet-sidecar.lock`: the open kernel lock, not file presence, denotes ownership.

## Online device linking

`keet-mcp-admin` is a normal TypeScript CLI distributed in this package. It
sends HTTP requests to the existing gateway and never opens a runtime or
identity directory. Configure a separate `KEET_MCP_ADMIN_TOKEN` on the daemon.
Installing the updated package and enabling this configuration requires a
normal gateway restart; later linking operations keep MCP sessions, messaging,
and webhook delivery running. The management token only authorizes the three
device-link routes; it cannot access `/mcp` or `/images/*`, and the MCP token
cannot access management routes. These capabilities are not MCP tools.

Select the running identity by its gateway origin. Only literal loopback HTTP
origins with explicit ports are accepted, including `http://[::1]:8765`;
credentials, paths beyond `/`, queries, and fragments are rejected. Tokens go
in environment variables and authorization headers, never URL/CLI arguments.
The following credentials are placeholders, not usable production secrets:

```bash
export KEET_MCP_ADMIN_URL=http://127.0.0.1:8765
export KEET_MCP_ADMIN_TOKEN='replace-with-distinct-human-secret-at-least-32-characters'
keet-mcp-admin devices invite
keet-mcp-admin devices pending
keet-mcp-admin devices approve REQUEST_ID --yes
keet-mcp-admin devices reject REQUEST_ID --yes
```

Invite writes `{invitationUrl, expiresAt}` JSON to your private terminal. Keep
that link out of shared logs and agent context. On the phone, follow the
[official linking flow](https://support.keet.io/installation-and-setup/link-devices/):
choose **I'm a current user → Link device → Start device link → Use account
link**, then paste the link. This adds a device to the same identity and is
separate from recovering a profile with a mnemonic. Query `pending` after the
phone requests linking; it returns `{request:{requestId,deviceName}}`. Check
the requesting phone, and explicitly approve or reject its `requestId`.
Device names are untrusted hints; identical names do not identify a request.
Request IDs are stable for the same two native device bindings during this
gateway lifetime. After restarting the gateway, query pending for a fresh ID.

The native invitation requires approval and has a fixed 2h lifetime. The
returned `expiresAt` is Unix milliseconds computed from the request-start
time + 2h, a conservative display estimate because native token inspection
does not expose its expiry. Creating another invitation does not cancel old
ones; they expire natively. There is no cancellation or QR feature here.

HTTP failures exit nonzero with safe stderr JSON containing `error` and the
response's integer `httpStatus` (100–599). HTTP 502 reports
`{"error":"operation_failed","httpStatus":502}`; 401, 409 and 504 retain
`unauthorized`, `request_conflict` and `pairing_state_unavailable`, respectively.
Other HTTP failures use `http_failure`. Transport, configuration and argument
errors have no `httpStatus`. Error response bodies are discarded without
parsing, and the CLI never retries or follows redirects.

These fields improve CLI diagnostics. They do not identify a native cause or
prove whether a failed invitation request created an invitation. A failure
can leave mutation results unknown; do not automatically repeat the request.

Only one current request is observed, not a list. The pinned Core suppresses
null subscription results; if no object arrives within 5s, or the stream ends,
HTTP returns 504 `pairing_state_unavailable` and the CLI exits nonzero. This
may mean no request or that reading could not complete; it is not proof of
an empty queue. Start the request on the phone and check again. Malformed
snapshots also fail closed. Each decision re-reads the current request and
compares both native device bindings; a replaced request returns 409
`request_conflict`, and an unobservable state cannot be confirmed. Management
mutations are serialized, without blocking ordinary messaging.

Decision success is `{decisionSubmitted:"approve"}` (or `"reject"`): the
native confirmation completed/submitted, not a claim that the phone has
finished syncing. A disappearing request may be a native no-op. Non-2xx,
conflicts and timeouts exit nonzero with safe JSON on stderr; the CLI neither
follows redirects nor retries mutations. If delivery fails after submission,
the outcome may be unknown: check the phone and pending before a new decision.
`--help` works without environment configuration.

The same strict JSON contract is available to shell scripts:

```bash
curl --fail-with-body -X POST "$KEET_MCP_ADMIN_URL/admin/device-link/invitation" \
  -H "Authorization: Bearer $KEET_MCP_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' --data '{}'
curl --fail-with-body "$KEET_MCP_ADMIN_URL/admin/device-link/request" \
  -H "Authorization: Bearer $KEET_MCP_ADMIN_TOKEN"
curl --fail-with-body -X POST "$KEET_MCP_ADMIN_URL/admin/device-link/decision" \
  -H "Authorization: Bearer $KEET_MCP_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"requestId":"REPLACE_WITH_PENDING_REQUEST_ID","decision":"approve"}'
```

Management authentication precedes body parsing and Core work. Unknown
fields, incorrect methods, queries, and bodies over 4 KiB are rejected;
responses are private, no-store JSON with fixed safe error categories.
Linking leaves the Managed Destination startup snapshot unchanged; rooms
joined later from the phone require a gateway restart to become destinations.
Fake tests verify API/CLI behavior; official phone interoperability remains
unverified, and deployment/live pairing require separate operator action.

## Offline human identity setup

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
| `send_message` | Sends non-empty text; regular groups support canonical replies and unique exact-name native mentions. An optional reaction adds one Unicode emoji to a specified Group or DM message after text is sent. |
| `send_file` | Sends one workspace-contained ordinary file up to 100 MiB. PNG, JPEG, WebP, and GIF files retain native image presentation and a generated preview. |

## Incoming webhook

When `KEET_WEBHOOK_URL` is set, KFA observes every admitted non-self Group,
DM, and Broadcast message with text or images and POSTs it to that URL. A
captioned image keeps both its text and images; pure image messages have empty
`text` and a nonempty `images` array.
Each JSON body has `type: "message"`, UUID `eventId`, positive `sequence`,
canonical `messageId`, safe-integer `timestamp`, `destination`, `senderLabel`,
bounded text, and optional `replyTo` and `trigger` (`mention`, `label`,
`reply`, or `dm`). It includes only canonical message IDs for the event,
optional reply, and reaction targets; it excludes group and sender IDs, native
records, image data, paths, and credentials. The ordered `images` array has one
entry per admitted native image: `mediaType`, optional safe `name`, and
`status: "available"` with an opaque `ref`, or `status: "unavailable"` without
one. Read or validation failure for one image does not suppress other images
or the message. Core admits at most 16 images, 16 MiB each, and 32 MiB per
message; KFA retains the validated original bytes without transcoding.

Fetch an available image using `GET /images/{ref}` on the same listener, with
`Authorization: Bearer <KEET_MCP_TOKEN>`. The response contains the original
bytes and their image media type. Missing or malformed references, including
images removed by an operator, return 404; missing credentials return 401.
The route accepts only GET and never accepts a filesystem path.

A qualifying Group or DM message trigger can also carry `reactionContext`: up to
16 `{ targetMessageId, targetText, emoji, externalCount }` entries from the
latest 50 messages in that destination. KFA makes at most 16 strict complete
reaction reads for identity-authored candidate messages with apparent
reactions. History alone cannot establish ownership: a target whose complete
read fails or is unavailable is omitted. `targetText` is an untrusted excerpt
of at most 48 Unicode code points. `externalCount` subtracts this identity's own
reaction, and entries with zero external reactions are omitted. Inbound emoji
may be Unicode or a bounded Keet shortcode. The complete event, including
images and context, is capped at 112 KiB; reaction entries are dropped to fit.
A history-read failure leaves the message event intact, and a later qualifying
trigger can collect a new snapshot. Reaction changes alone create no webhook
event. Ordinary Group messages and all Broadcast messages carry no reaction
context. The receiver handles its own
deduplication and delivery receipts; KFA does not identify reactors.

KFA appends and syncs an event before its first request. It sends one event at
a time; only a 2xx response removes the head event. Timeouts, network errors,
redirects, and non-2xx responses use bounded backoff and keep later events
behind it. The stable `eventId` makes at-least-once retries and restarts safe
for a receiver that persists then deduplicates before returning success. There
is no `/cfl` route, WebSocket replay protocol, or local inbound-media library.
If event persistence or intake fails, the daemon reports a fatal error and
exits nonzero. A graceful shutdown finishes accepted persistence work before
releasing the Core identity; an interrupted HTTP request may be retried.

Validated originals are synced under `KEET_MCP_STATE_DIR/images/` before an
event with their references is journaled. That directory is owner-only; files
are owner-readable. Webhook acknowledgement and gateway restart do not remove
images. The operator may manually remove retained files when they are no
longer needed. A removed file makes its historical reference return 404,
including during webhook retries. Keep the state directory on persistent
storage and plan its capacity; KFA has no automatic image expiry or cleanup.

`send_message` still requires nonblank `text`. It may include
`reaction: { targetMessageId: { deviceId, seq }, emoji }`, where `emoji` is
exactly one Unicode emoji. The target must be in the same admitted Group or
DM; Core checks its existence and native permission. A Group target may be an
older message and may differ from `replyTo`. A DM receiver should supply only
its active turn's triggering message ID, even if later DMs are queued; KFA
cannot infer turn ownership. Broadcast reactions and reaction-only sends are
rejected before text delivery. With no reaction request the result is
`{ sent: true }`. With one, the result is `{ sent: true, reacted: true }` or
`{ sent: true, reacted: false, reactionError: "Keet reaction could not be added." }`.
The latter confirms text delivery; do not resend it. A text-send failure is a
tool error. Text and its reaction attempt are serialized with other sends to
that destination.

The gateway exposes no room-onboarding, standalone reaction, profile,
username, or stdio tools; human setup uses the separate local CLI above. Core
remains the authority for current native posting permissions.

## Verification

```bash
pnpm check
pnpm test
pnpm build
pnpm pack-smoke
```

`pnpm pack-smoke` packs the gateway, checks its machine-consumed contents,
removed WebSocket dependency, notices, and `--help` executable surface. It does
not contact Keet. This includes the distributed `keet-mcp-admin --help` without
management configuration. Official-runtime interoperability is not
established by these checks.

## License

Apache-2.0. See [LICENSE](LICENSE).
