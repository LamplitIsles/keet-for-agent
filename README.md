# Keet for Agent

`@lamplitisles/dsh-keet` is a narrow DeepSeek Harness (DSH) plugin for every
joined Keet `Default` room and every accepted complete `DirectMessage` room
discovered at startup. It uses the official Keet Linux x86-64 runtime
through a typed Integration Core; the runtime itself is supplied privately by
the operator and is never included in this repository or package artifact.

## Install locally

This repository is a Bun workspace. Build and inspect the package, then add
the exact local tarball to a disposable DSH profile:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
bun run pack-smoke
```

For a local/link or tarball installation, use the DSH CLI's normal plugin
installer. The tarball is an npm-shaped local artifact only; this project has
no publication or release workflow.

```sh
npm pack ./packages/dsh-keet --pack-destination .local
dsh plugin --profile web add .local/lamplitisles-dsh-keet-0.1.0.tgz
```

`bun run pack-smoke` performs this operation in a fresh temporary DSH home,
activates the real DSH Loader, and checks the Host, client, patch, CSS,
readiness, and settings registrations. It does not contact Keet.

## Prepare the private runtime

Follow [the operator runtime guide](docs/runtime-extraction.md) to obtain the
official release and prepare `$DSH_HOME/runtimes/keet/4.21.0-linux-x64`,
containing `bare`, `core-worker.bundle`, and the manifest-selected Linux x64
native closure.
Only Keet 4.21.0, `@holepunchto/keet-core` 4.21.5, ABI 35, and Linux x86-64
are admitted. The Integration Core fails closed for other tuples.

Keep runtime files outside the repository. The plugin creates the writable
identity directory at `<workspace>/.dsh/dsh-keet/identity`; one bridge process
owns that directory at a time.

Stop the running bridge before using any `dsh-keet-setup` operation against
that workspace. If DSH runs as the user service shown below, this Bash wrapper
attempts to start the service again when setup succeeds or fails:

```sh
bash -lc '
  set -e
  trap "systemctl --user start dsh.service" EXIT
  systemctl --user stop dsh.service
  dsh-keet-setup profile --workspace /path/to/dsh-workspace \
    --avatar /path/to/avatar.png
'
```

Use the same stop/setup/restart pattern for `join`, `dm-requests`, and
`dm-accept`. Operators using another service manager should stop and restart
the process that owns the identity directory by its equivalent mechanism.

## One-time onboarding

Create a fresh identity and join it to a pre-existing group with the human-only
setup command. Pass exactly one `keet://chat/<token>` URL on stdin; it is not
accepted in argv, environment variables, DSH settings, or Agent tools.

```sh
printf '%s\n' "$INVITATION" | dsh-keet-setup join \
  --workspace /path/to/dsh-workspace
```

The command prints one bounded machine-readable success result and never
exposes a room ID. Set the identity's current display name separately:

```sh
dsh-keet-setup profile \
  --workspace /path/to/dsh-workspace \
  --display-name "Keet Assistant"
```

The profile operation accepts either field independently (or both):

```sh
dsh-keet-setup profile --workspace /path/to/dsh-workspace \
  --display-name "Keet Assistant" --avatar /path/to/avatar.png
```

Avatar input must be a local PNG, JPEG, or WebP no larger than 8 MiB. Setup
honors orientation, center-crops to a square, and creates deterministic 64,
128, and 256 pixel PNG variants, each below Keet's 512 KiB inline limit. The
asset remains square; official clients apply their circular presentation mask.
An avatar-only CLI update reads the current non-empty display name and resends
it with the new avatar because the underlying Keet profile update requires the
name. It fails without changing the profile if the identity has no current
display name. Setup has no chat, room creation, invitation creation, biography,
or avatar-removal surface.

To inspect and accept a human-sent DM request, use the setup executable:

```sh
dsh-keet-setup dm-requests --workspace /path/to/dsh-workspace
dsh-keet-setup dm-accept --workspace /path/to/dsh-workspace --member-id <peer-member-id>
```

The request list contains only bounded sender identity records. Acceptance is
exact and confirms only the selected peer Member ID; the Agent and production
bridge never initiate contact requests. Restart DSH after joining or accepting
so the next startup snapshot discovers the destination.

## Configure and use the bridge

The native DSH settings card has one restart-scoped field: the DSH workspace.
The bridge derives all allowed destinations from the Keet identity's canonical
joined-room snapshot; no room or peer ID is copied into settings.

The workspace can be saved before onboarding. On the next startup the Host
initializes its private identity directory beneath that workspace. Runtime and
identity paths are fixed Host conventions rather than browser-supplied values.
If readiness is unavailable, verify the selected workspace and the fixed
runtime, then save the settings and restart DSH. Diagnostics stay bounded and
do not echo invitations or Core-private records.

The Integration Core reads the canonical joined-room list once at startup and
also obtains one bounded pending-request snapshot. Joined `Default` rooms are
managed groups. Complete `DirectMessage` rooms whose peer is not pending are
managed DMs. Pending requests, broadcasts, unknown or incomplete records, and
duplicate room IDs are excluded; failure to obtain the pending snapshot fails
startup closed without admitting a DM.

At startup the bridge selects the latest eligible existing human conversation
in that workspace and keeps it for its lifetime. It never creates or switches
conversations or groups. It exposes every admitted destination; unrelated
joined rooms remain hidden. An empty eligible set is a valid connected state
and lets onboarding complete before a later restart.
Each destination has an independent bounded FIFO context buffer. Group text
keeps the existing mention, display-label, and verified-reply triggers. Every
new ordinary external DM text starts one serialized Agent turn. Group prompt
records retain canonical `{ device_id, seq }` provenance and the startup source
`groupName`; DM prompts identify the source and sender display label but
intentionally omit message IDs, reply relations, and sender IDs. All records are
quoted, untrusted data.

When a Managed DM turn (including `/compact`) actually begins, the bridge marks
the triggering message read at its normalized chat index plus one and publishes
native typing activity. Typing refreshes every four seconds while the work is
active; activity calls are best-effort, and the receiving Keet client expires
the last typing timestamp naturally after its native five-second active window. Queued messages
remain unread and do not publish typing. A successful send to that DM, command
settlement, failure, cancellation, or bridge shutdown stops refresh ownership.

An ordinary Managed DM whose text is exactly `/compact` is intercepted before
the context buffer and Agent follow-up. It runs once through the composed
`@deepseek-ai/dsh-commands` service against the bound Active Conversation, creates no Agent turn or
model-history entry, and sends one bounded command outcome back to that same
DM. The command service and its compaction backend must be present in the DSH
composition; unavailable or empty outcomes receive a bounded generic result,
and delivery failures are reported without retrying or falling back to an
Agent turn. Whitespace, arguments, casing changes, and regular-group messages
remain ordinary bridge input.

An Agent turn's final DSH text is never relayed automatically. Call
`keet_list_groups` first, then pass one exact returned `groupName` to the common
destination tools:

- `keet_list_groups`: every discovered Managed Group and Managed DM, returned
  only as `{ groupName, kind }`;
- `keet_list_members`: at most 128 deterministic current display names (Member
  IDs remain Bridge-owned);
- `keet_read_recent_messages`: 1–50 chronological bounded plain-text records;
  regular groups include stable message IDs and optional reply targets, while
  DM results omit sender/message/reply IDs;
- `keet_send_message`: one non-empty text message up to 16,000 characters.
  Regular groups may use an exact `{ deviceId, seq }` reply target; successful
  sends return only `{ sent: true }`; DM sends are ordinary text and reject
  `replyTo`. After a successful send in the current turn, the injected Agent
  policy requires the final DSH response to be exactly `✓`, because the sent
  content is already visible in Keet. Without a successful send, the Agent
  responds normally.

Destination names are captured once per DSH restart from bounded titles (line
separators become spaces). Selectors trim input but otherwise match exactly and
case-sensitively. Every destination tool rejects an arbitrary or undiscovered
name before touching Core; normalized duplicate names fail closed, and an
ambiguous send says that no message was sent. The tools never accept
invitations, identity data, files, media, or formatting options.

## Verification

The ordinary checks use only fake workers and test-owned temporary directories:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
bun run pack-smoke
```

The official-runtime checks are explicit opt-ins and must use fresh temporary
identity directories. `bun run real-worker-smoke` is skipped unless
`KEET_OFFICIAL_RUNTIME_SMOKE=1` is set. The two-sidecar onboarding smoke is
similarly skipped unless `KEET_OFFICIAL_ONBOARDING_SMOKE=1` is set; see the
operator guide for its required runtime variables. Never use a real user's
identity, group, invitation, or data directory in tests.

The real-worker smoke verifies the official worker's Keet reply relation. The
opt-in two-sidecar onboarding smoke additionally accepts one human DM request,
resolves the DM on both identities, sends ordinary DM text, and propagates a
generated avatar observation. Neither smoke claims desktop UI rendering; the
manual circular-avatar check remains a separate disposable operator smoke.

## Scope and privacy

The public package contains only source-derived Host/client code, declarations,
the Cordis patch, documentation, license, and notices. Official binaries,
bundles, native addons, extracted source, identities, invitations, room IDs,
message data, and other local research material stay outside package artifacts.
The complete `.scratch/` tree is local-only and ignored. Raw
Hypercore/Hyperswarm transports are separate networks and are not Keet
compatibility substitutes.

MCP, OpenClaw, Hermes, a general chat CLI, multiple identities,
automatic final-text delivery, files/media/calls, moderation, avatar removal,
and private-only operation remain outside this v1 slice.
