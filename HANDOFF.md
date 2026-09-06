# Keet for Agent handoff

The implementation is a pnpm workspace with one public adapter and one private
reusable Integration Core:

```text
DSH Keet Bridge -> Integration Core -> fd-3 tiny-buffer-rpc -> official Bare sidecar
```

## Source of truth

- `packages/keet-core/src/` owns the typed sidecar lifecycle, pinned runtime
  admission, normalized room/group/member/message values (including bounded
  aggregate reaction summaries and image descriptors), canonical room-list DM
  resolution, subscriptions, text/native-image sends, image reads, native
  reaction add (RPC 156), onboarding, profile update, and globally searchable
  username registration/update with bounded lookup convergence. Core also owns
  the single Unicode reaction validator and username syntax validator.
- `packages/dsh-keet/src/` owns the DSH Host bridge, Managed Destination tools
  (including optional reaction decoration on `keet_send_message`), setup
  executable, settings schema/client, and protocol rendering.
- `tests/` uses fake workers and test-owned temporary paths for ordinary gates.
- `scripts/pack-smoke.ts` verifies the actual packed tarball through the
  installed DSH Loader and a disposable DSH home.
- `docs/runtime-extraction.md` is the operator guide for the private runtime.

Core test boundary: Integration Core normalization, policy, orchestration,
DM convergence, onboarding, profile, username, cancellation, native image stream and
file-lifecycle handling tests
use a real but unstarted `KeetSidecar` whose consumed methods are replaced by
a test-local scripted seam. The fake worker is reserved for the small fd-3
process contract suite: admission, one representative startup/RPC path, one
streaming path, terminal failure, intentional cleanup, and identity locking.
Mocks and the fake worker do not establish official-client interoperability;
the opt-in official-runtime smokes remain the only such evidence.
README.md, `packages/dsh-keet/README.md`, and `CONTEXT.md` describe the
reaction-facing behavior, including durable at-most-once aggregate context for
an exact target/emoji/count tuple, canceled-removal and same-count re-addition
semantics, and the concise 48-code-point target prefix. They also describe the
Managed Broadcast contract and glossary. Explicit recent reads expose current
edited text, while edited live updates never trigger turns. `AGENTS.md` owns
build commands, safety constraints, official-smoke policy, and
contributor/release workflow, including the scoped release-audit rule. The
public and package READMEs also document the DM-only image lifecycle, explicit
workspace-contained send tool, DSH durable attachment admission, text-only
recent reads, and the fact that official-client image interoperability remains
unverified. `CONTEXT.md` defines Inbound DM Image, Inbound DM Image Failure,
and Explicit DM Image Send. Inbound reaction normalization preserves literal
Unicode and wraps bounded Keet wire shortcodes (for example `heart` as
`:heart:`); outbound reaction validation remains Unicode-only. No ADR is needed;
the DM-only and text-history boundaries are specified and reversible.

## Product boundary

The bridge discovers every joined `Default` or `Broadcast` room and every
accepted complete `DirectMessage` room from one bounded startup snapshot, then
binds all admitted destinations to one existing DSH conversation selected from
the configured workspace. It never creates or switches conversations or
groups. Pending DM requests, unknown room types, incomplete DMs, and duplicate
room records are excluded; a pending-snapshot failure fails startup closed.
Regular groups keep mention, current-label, and verified-reply triggers; every
new ordinary external DM text triggers one serialized Agent turn. Managed
Broadcasts are listing/read/proactive-text destinations only: they have no
Bridge state, subscription, context buffer, inbound trigger, typing/read
activity, roster, image, reply-anchor, or reaction path. The native worker
adjudicates every post from current permissions. Group/DM destination buffers
and subscriptions are isolated, each injected context names its restart-scoped
source `groupName`, and the Agent's final text remains in DSH unless an
explicit delivery tool is called. After a confirmed text send in a turn (with
an optional reaction decoration), the injected policy reduces the final DSH
response to the exact `✓` acknowledgement so the already-delivered Keet
content is not duplicated.

The tools are `keet_list_groups`, `keet_list_members`,
`keet_read_recent_messages`, `keet_send_message`, and `keet_send_image`. The
first lists all
discovered destinations as `{ groupName, kind }`; the remaining tools require an
exact returned `groupName` (trimmed, case-sensitive, and restart-scoped).
Regular Group history preserves canonical message IDs, optional reply
provenance, and the current text of valid edited records; Managed Broadcast
history preserves canonical message IDs but omits reply provenance. Live edited
updates remain suppressed. Roster results contain only display names and
send results contain only bounded delivery booleans; Broadcast roster lookup is
rejected. `keet_send_message` always requires non-empty text and may optionally
attach one native Unicode emoji to the current Keet trigger for a regular Group
or DM; the bridge supplies that Message ID internally. Managed Broadcast sends
are plain text only and reject reply anchors and reactions. Text is sent first,
then an eligible reaction is attempted once as a best-effort decoration.
Text-only success returns `{ sent: true }`; a requested reaction returns
`{ sent: true, reacted: true }` or `{ sent: true, reacted: false }`. A failed
reaction, cancellation, or lost readiness after text confirmation never retries
or converts the tool into an error. Optional reactions are unavailable outside
an active ordinary Keet turn, for `/compact`, stale/settled work, Broadcasts,
or another destination. DM history and prompts omit sender/message/reply IDs,
and DM sends are ordinary text. Human reactions never trigger a turn; aggregate
reaction context on Integration-authored messages is best-effort bounded and
delivered at most once for an exact target/emoji/count tuple across restarts.
The Bridge replays DSH's durable `agent/inbox/spliced` events from every
inspected workspace session as the restart source of truth; a failed session
inspection disables only reaction context recovery for that run. The live
receipt set remains a projection updated at the claim boundary.
Canceled inbox removals leave a receipt eligible, while same-count removal and
re-addition remains suppressed; targets are whitespace-normalized 48-code-point
prefixes with an ellipsis only when omitted. No reactor or Member IDs enter
context.
`keet_send_image` is DM-only, accepts one PNG, JPEG,
WebP, or GIF from the bound Active Conversation workspace, preserves the
source bytes, and sends an optional caption as adjacent text. It rejects URLs,
outside-workspace paths, malformed/corrupt content, and unsupported formats
before native delivery; image-success/caption-failure is reported as a bounded
no-retry partial delivery. Normalized duplicate names fail selected operations
closed before Core access, with ambiguous sends confirming that no message was
sent.
Setup is human-only: `join` reads exactly one invitation URL from stdin,
`username` reserves or changes the globally unique searchable registry name,
`dm-requests` lists bounded sender identities, `dm-accept` accepts one exact
pending sender, and `profile` can independently update display name and a
prepared avatar. Username is not profile data at the product interface and is
not exposed through bridge/model tools or settings. Join and DM acceptance
results do not expose room IDs;
restart DSH after either operation so the next startup snapshot can admit the
destination.

A workspace with no eligible destinations is a valid connected state. When an
Agent is bound, readiness and tools are available with an empty destination
list until a later restart after onboarding.

While active Managed DM work is running, the bridge publishes best-effort
native activity: the triggering message is marked read at chat index plus one,
and typing refreshes every four seconds until the work settles or a successful
same-DM send stops ownership. Queued messages remain unread; the receiving
client expires the last typing timestamp after its native five-second window.
An exact ordinary DM text of `/compact` is intercepted before context/model
input, executed once through the composed DSH command registry against the
bound Agent, and returned as one bounded message in that DM. It creates no
Agent turn or model-history entry; unavailable or failed command/delivery
paths do not retry or fall back. The Host composition must inject the
`commands` service (and its compaction backend), DSH's `attachments` service
for image admission, and the DSH `fs` service for workspace-contained sends.
A newly received DM image is streamed through Core using one finite
`readFileStream` request: Core sends one argument tuple, half-closes its request
side, and consumes the response to completion. The complete ordered batch has
a fixed 60-second admission deadline; expiry or read failure destroys the
active stream, creates no session image event or turn, retains one bounded,
non-triggering failure record for the next successful same-DM turn, and attempts
one generic notice without retry. Later destination messages continue after
that bounded failure. Successful batches are admitted atomically through
`attachments` and passed to one Agent turn as ordered durable image blocks plus
their caption.
Initial snapshots, self-authored/group/historical images, and
`keet_read_recent_messages` never fetch image bytes.

## Compatibility and safety

Only Linux x86-64 with Keet 4.21.0, `@holepunchto/keet-core` 4.21.5, and ABI
35 is admitted. Runtime files are operator-supplied, read-only assets at
`$DSH_HOME/runtimes/keet/4.21.0-linux-x64`. Identity data is persistent
writable state under `<workspace>/.dsh/dsh-keet/identity`. Core owns that
directory through the persistent mode-0600 `.keet-sidecar.lock` file, held
open for the sidecar lifetime with Holepunch's nonblocking kernel lock. A
live owner causes immediate startup failure; the kernel releases ownership
after normal close or abnormal process death. The file's presence is never
interpreted as ownership, and operators must not delete it manually. Keep
runtime files and identity state outside package artifacts and never use live
state in tests. Sidecar diagnostics and wrapped errors are bounded and
redacted.

The pinned worker exposes username RPCs 195–202. This implementation uses
`checkUsername` (202), `registerUsername` (198) or `updateUsername` (199), then
polls `lookupUsername` (195) until the configured 60-second deadline. Extracted
4.21.0 worker evidence shows availability is boolean, both mutations delegate
to `userRegistry.update(name)` and return a submission boolean, and lookup
returns `null` or an encoded user containing `memberId` and `username`. Core
therefore accepts only exact booleans and an exact converged lookup; malformed
results and ownership conflicts fail closed. Its narrow result is
`{ status: "searchable" | "pending", submitted: boolean }`; `submitted`
records whether this call accepted a native mutation, while exact current-name
input skips availability and mutation but still verifies lookup convergence.
Setup keeps the confirmed success JSON unchanged. A deadline without exact
lookup exits 1 with bounded `ok: false`, `status: "pending"`, `submitted`, and
`retryable: true` facts so the operator can retry the exact same username; no
background job or alternate name is created. The registry retains five records
per Member key (initial registration plus four changes), so prior names cannot
be reused. No official-runtime username smoke was authorized, so official-client
interoperability remains unverified.

The root `.scratch/` tree is intentionally ignored and includes active plans,
deferred notes, and preserved archived local material. Do not add it to Git.
Do not push this branch. Release-audit scope is defined in `AGENTS.md`.

## Gates

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm pack-smoke
```

Official-runtime checks are explicit opt-ins only:

```sh
KEET_OFFICIAL_RUNTIME_SMOKE=1 pnpm real-worker-smoke
KEET_OFFICIAL_ONBOARDING_SMOKE=1 pnpm official-onboarding-smoke
```

Without those environment variables they must report a skip. Fake-worker and
Loader passes do not establish official-client interoperability. The real-worker
smoke verifies only the official worker's Keet reply relation round-trip; it does
not verify desktop UI rendering. The opt-in two-sidecar onboarding smoke also
creates a fresh Broadcast, observes its normalized type on both identities,
confirms a moderator post persists, confirms a non-moderator post is rejected,
and observes generated profile/avatar propagation.

Profile avatar input is prepared by setup from a local PNG, JPEG, or WebP up to
8 MiB into deterministic square 64/128/256 PNG variants below Keet's 512 KiB
inline limit. Avatar-only updates preserve the current display name. Official
clients apply the circular presentation mask; this repository does not claim a
desktop visual smoke.

The image path uses the pinned native `saveFileBlob`, `sendFile`, and finite
`readFileStream` RPCs. Native external file pointers use the Official
`externalBlob.id` plus `blob` descriptor. Obsolete `addFile` and `addFileBlob`
calls remain unsupported and are not wrapped by compatibility fallbacks. Runtime files,
identity data, downloaded images, and transient previews remain outside source
and package artifacts. No official-runtime image interoperability smoke was
authorized for this change, so official-client image compatibility is
unverified.

The development toolchain has one compiler generation: TypeScript 7.0.2. The
normal `pnpm check` gate composes `pnpm typecheck` (`tsc --noEmit`) with
`pnpm lint`, which runs Oxlint 1.81.0 through the native
`oxlint-tsgolint` type-aware engine and requires `typescript/unbound-method`.
The separate Oxlint `--type-check` mode and style/formatting policy are not
enabled. The package build uses tsdown 0.23.0 with the explicit native `tsgo`
declaration generator; its bounded config ports the existing CSS load hook and
preserves the Node ESM, browser CJS, and `client.d.cts` artifact contract.
The Managed Broadcast domain language changed in this slice, so `CONTEXT.md`,
the root/package READMEs, and this handoff now describe its read/proactive-text
boundary. `AGENTS.md` was inspected and needs no update: contributor workflow,
commands, safety rules, and official-smoke opt-in policy are unchanged. No ADR
is needed because this is a reversible adapter capability extension.
