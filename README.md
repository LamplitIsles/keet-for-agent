# Keet for Agent

`@lamplitisles/dsh-keet` is a narrow DeepSeek Harness (DSH) plugin for one
already-joined Keet group. It uses the official Keet Linux x86-64 runtime
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

## One-time onboarding

Create a fresh identity and join it to a pre-existing group with the human-only
setup command. Pass exactly one `keet://chat/<token>` URL on stdin; it is not
accepted in argv, environment variables, DSH settings, or Agent tools.

```sh
printf '%s\n' "$INVITATION" | dsh-keet-setup join \
  --workspace /path/to/dsh-workspace
```

The command prints one bounded machine-readable result containing the Managed
Group ID. Treat that output as sensitive operator data. Set the identity's
current group display name separately:

```sh
dsh-keet-setup profile \
  --workspace /path/to/dsh-workspace \
  --display-name "Keet Assistant"
```

The profile command changes only the display name. Avatar import is deferred:
the official profile RPC expects Keet's internal multi-size image-file value,
not a filesystem path. The setup executable has no chat, room creation,
invitation creation, biography, or avatar surface.

## Configure and use the bridge

The native DSH settings card has exactly two restart-scoped fields:

1. DSH workspace; and
2. Managed Group ID from onboarding.

The workspace can be saved before onboarding. On the next startup the Host
initializes its private identity directory beneath that workspace. Runtime and
identity paths are fixed Host conventions rather than browser-supplied values.

At startup the bridge selects the latest eligible existing human conversation
in that workspace and keeps it for its lifetime. It never creates or switches
conversations or groups. Ordinary new text is retained in a bounded FIFO
context buffer. External messages are rendered once as concise structured
`<message>` records containing their canonical `{ device_id, seq }` message ID
components and sender identity; the integration's own messages are retained
only for reply-target ownership. Only a mention of the identity, a literal
occurrence of its current non-empty display label, or a Keet replyTo relation to
one of its messages starts one serialized Agent turn. Group records are quoted,
untrusted data.

An Agent turn's final DSH text is never relayed automatically. Delivery is
always explicit through the fixed-group tools:

- `keet_list_members`: at most 128 deterministic current member records;
- `keet_read_recent_messages`: 1–50 chronological bounded plain-text records,
  including stable message and sender IDs and Keet replyTo targets;
- `keet_send_message`: one non-empty text message up to 16,000 characters,
  optionally using an exact `{ deviceId, seq }` Keet replyTo target from a
  recent read.

The tools never accept an arbitrary group selector, invitation, identity,
files, media, or formatting options.

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

The real-worker smoke verifies that the official worker round-trips a Keet
reply relation. It does not verify desktop UI rendering; that visual check
remains a separate disposable operator smoke.

## Scope and privacy

The public package contains only source-derived Host/client code, declarations,
the Cordis patch, documentation, license, and notices. Official binaries,
bundles, native addons, extracted source, identities, invitations, room IDs,
message data, and other local research material stay outside package artifacts.
The complete `.scratch/` tree is local-only and ignored. Raw
Hypercore/Hyperswarm transports are separate networks and are not Keet
compatibility substitutes.

MCP, OpenClaw, Hermes, a general chat CLI, multiple groups or identities,
automatic final-text delivery, files/media/calls, moderation, and avatar
import remain outside this v1 slice.
