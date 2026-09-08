# Keet for Agent

`@lamplitisles/dsh-keet` is a narrow DeepSeek Harness (DSH) plugin for every
joined Keet `Default` or `Broadcast` room and every accepted complete
`DirectMessage` room discovered at startup, plus rooms a human admits while the
bridge is running from its settings card. It uses the official Keet Linux
x86-64 runtime through a typed Integration Core; the runtime itself is supplied
privately by the operator and is never included in this repository or package
artifact.

The workspace also includes a private [Impri Keet approval channel](packages/impri-keet/README.md).
It uses a separate bot identity and a private DM with ✅ / ❌ reactions to
decide existing Impri actions. Action producers retain execution ownership.

## Install locally

This repository is a pnpm workspace targeting Node.js. Build and inspect the package, then add
the exact local tarball to a disposable DSH profile:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm pack-smoke
```

`pnpm check` composes the independent `pnpm typecheck` and `pnpm lint`
commands. Typechecking uses the pinned TypeScript 7 compiler; linting uses
Oxlint's type-aware correctness engine with `typescript/unbound-method`
required. The package build uses tsdown with native TypeScript 7 declarations;
there is one compiler generation.

For a local/link or tarball installation, use the DSH CLI's normal plugin
installer. The tarball is an npm-shaped local artifact only; this project has
no publication or release workflow.

```sh
npm pack ./packages/dsh-keet --pack-destination .local
dsh plugin --profile web add .local/lamplitisles-dsh-keet-0.1.0.tgz
```

`pnpm pack-smoke` performs this operation in a fresh temporary DSH home,
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
owns that directory at a time. Core holds that ownership with an exclusive
kernel lock on the persistent mode-0600 `.keet-sidecar.lock` file. The lock
belongs to the open descriptor, so the kernel releases it after an abnormal
process death; a live owner still rejects another opener immediately. The file
is not a stale PID record and must never be deleted manually.

The running bridge owns the workspace identity. Stop it before using the
human-only `dsh-keet-setup` commands for profile or searchable-username changes.
If DSH runs as the user service shown below, this Bash wrapper attempts to start
the service again when setup succeeds or fails:

```sh
bash -lc '
  set -e
  trap "systemctl --user start dsh.service" EXIT
  systemctl --user stop dsh.service
  dsh-keet-setup profile --workspace /path/to/dsh-workspace \
    --avatar /path/to/avatar.png
'
```

Operators using another service manager should stop and restart the process that
owns the identity directory by its equivalent mechanism. Group joining and DM
request acceptance are different: they are performed from the running settings
card and must not start a second Core against the same identity.

## Human onboarding and identity profile

The DSH settings card is the human-only room-access surface. First select and
save the DSH workspace. Once the bridge reports `Ready` or `Unbound`, open the
card and paste one `keet://chat/<token>` invitation into the transient
Invitation field, then choose `Join`. The invitation is sent only to the
running workspace identity; it is not persisted, exposed to the Agent, or
accepted through setup argv or environment variables.

The card loads bounded Pending DM Requests when that section opens and has a
manual `Refresh` action. Each request shows a bounded display name and a short
identity hint so duplicate names remain distinguishable; `Accept` submits the
exact hidden peer selector. Joining or accepting mutates the live Integration
Identity and immediately publishes the fully initialized destination to the
current bridge and Agent tools. No DSH restart is needed.

Live onboarding is disabled while the workspace has unsaved changes, the
selected workspace does not match the running bridge, or readiness is not
`Ready`/`Unbound`. A connected `Unbound` bridge can still admit a room while
remaining unbound when no existing DSH conversation is available. A new
destination starts with new messages only: its historical snapshot and messages
received before intake is established never trigger an Agent turn. If the native
mutation succeeds but admission cannot finish, the card reports a partial
result and offers an admission-only `Retry`; it never repeats the confirmed
join or acceptance.

`dsh-keet-setup` remains available for profile and searchable-username changes.
Set the identity's current display name separately:

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

Reserve the dedicated identity's globally searchable Keet username separately
from its display name/profile:

```sh
dsh-keet-setup username --workspace /path/to/dsh-workspace \
  --username agent_name1
```

A username is 3–64 characters, uses only Latin letters, digits, and underscore,
and contains at least one letter and one digit. The command is idempotent only
when the requested username exactly matches the current username. Otherwise it
checks availability, submits the native registration or update, and reports
success only after the requested name resolves to this identity's Member ID.
Previously used names cannot be reused, including after a change, and the
official client allows at most four changes after the initial registration.
The command waits through the full 60-second registry convergence budget. A
confirmed result is one JSON line such as
`{"ok":true,"operation":"username","username":"agent_name1"}`. If the
registry accepted a mutation but the exact lookup is still not searchable when
the budget expires, setup exits 1 and emits only the bounded pending result
`{"ok":false,"operation":"username","username":"agent_name1","status":"pending","submitted":true,"retryable":true}`.
`submitted` is `false` when an exact current-name request was only verifying
lookup convergence. Retry the exact same username; no alternate name or
persistent background job is created. Unavailable, malformed, cancelled, and
other registry failures retain the bounded generic setup error, and no
identity key is printed.

## Configure and use the bridge

The native DSH settings card has one saved, restart-scoped field: the DSH
workspace, plus durable live Member Join Trigger preferences for individual
ordinary groups. No room, invitation, or peer ID is copied into settings. The
bridge derives initial destinations from the Keet identity's canonical
joined-room snapshot and extends that collection only through the settings
actions described above.

The workspace can be saved before onboarding. On the next startup the Host
initializes its private identity directory beneath that workspace. Runtime and
identity paths are fixed Host conventions rather than browser-supplied values.
If readiness is unavailable, verify the selected workspace and the fixed
runtime, then save the settings and restart DSH when changing the selected
workspace. Diagnostics stay bounded and do not echo invitations or Core-private
records.

The Integration Core reads the canonical joined-room list once at startup and
also obtains one bounded pending-request snapshot. Joined `Default` rooms are
Managed Groups, joined `Broadcast` rooms are Managed Broadcasts, and complete
`DirectMessage` rooms whose peer is not pending are Managed DMs. Pending
requests, unknown or incomplete records, and duplicate room IDs are excluded;
failure to obtain the pending snapshot fails startup closed without admitting a
DM. A Managed Broadcast supports reading history and sending text or images.
It has no bridge state, subscription, inbound trigger, context buffer, typing/read activity, roster,
reply or reaction path. The native Keet Core decides each post from
the identity's current permission, so a non-moderator rejection is surfaced as
an ordinary safe send failure without retrying. A live Join or Accept performs
the native mutation first, re-reads the canonical resulting room, and admits it
through the same initialization path without disturbing existing destinations.

At startup the bridge selects the latest eligible existing human conversation
in that workspace and keeps it for its lifetime. It never creates or switches
conversations or groups. It exposes every startup destination and every fully
initialized destination admitted by the settings card; unrelated joined rooms
remain hidden. An empty eligible set is a valid connected state, and live
onboarding can still add a destination when the bridge is `Unbound`.
Each Managed Group and Managed DM has an independent bounded FIFO context
buffer; Managed Broadcasts do not have bridge state or inbound subscriptions.
Admission establishes a new group/DM history baseline and subscription before
publishing the destination. Historical records and messages arriving before
that intake boundary are not replayed or used as triggers.
Group text keeps the existing mention, display-label, and verified-reply
triggers. Every new ordinary external DM text starts one serialized Agent turn.
Group prompt
records retain canonical `{ device_id, seq }` provenance and the admission-time source
`groupName`; DM prompts identify the source and sender display label but
intentionally omit message IDs, reply relations, and sender IDs. All records are
quoted, untrusted data. Human reactions to Integration-authored messages do not
trigger a turn. An aggregate reaction context receipt is delivered at most once
for each exact target-message, emoji, and visible-count tuple, including across
DSH restarts; a previously unseen count remains eligible. A canceled inbox
removal does not consume its receipt, while removing and later re-adding the
same tuple does not notify again. Reaction targets are whitespace-normalized
prefixes of at most 48 Unicode code points, with one ellipsis only when content
was omitted. These bounded summaries remain untrusted context on the next
ordinary trigger for that same destination.
Keet picker/custom wire tokens that match the bounded lowercase/digit/_+-
grammar appear by colon-wrapped native names (for example `:heart:`); literal
Unicode reactions remain unchanged. Whitespace, unsafe punctuation, and
arbitrary prose are omitted; the grammar is forward-compatible display
normalization, not an authenticity assertion.

While the bridge is ready, each enabled ordinary Managed Group is polled every
ten seconds. Member Join Trigger is off by default and independently selectable
in the settings card for each group; DMs and Broadcasts have no toggle. The
first successful roster read for each enabled admitted group is its startup or
admission baseline. Enabling a group applies without restart and establishes a
fresh baseline, so members who arrived while it was disabled are not replayed;
disabling suppresses queued join turns without interrupting one already
running. Later observed additions (excluding the Integration Identity) produce
at most one Member Join turn for that group/member pair across DSH restarts.
Joins missed between polls, startup members, failed reads, DMs, Broadcasts, and
leave/rejoin churn do not create turns. The prompt contains only a bounded,
untrusted display name and source `groupName`; it has no Keet message/reply ID,
activity, image, or reaction capability. DSH's durable inbox splice history is
the receipt authority, so a claimed observation is not delivered again.

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

### DM images

New external Managed DM messages may contain one or more PNG, JPEG, WebP, or
GIF images and an optional caption. The bridge downloads every image in order
through a finite `readFileStream` request (the request side is half-closed
after its one tuple), admits the complete batch through DSH's durable
`attachments` service, and starts one Agent turn containing the caption and
durable image blocks. The complete batch has a fixed 60-second deadline;
expiry or another download, validation, or storage failure destroys the active
stream, starts no turn, and publishes no image reference. When possible the
bridge sends one short failure notice and retains one non-triggering failure
record for the next successful turn in that DM, so later messages continue.
Incoming group images, self-authored images, snapshots, and historical reads do
no image work. `keet_read_recent_messages` remains strictly plain-text-only.

The explicit `keet_send_image` tool sends one supported image to an exact
Managed Destination by reading a workspace-contained path through DSH `ctx.fs`
Active Conversation filesystem. It rejects URLs, outside-workspace paths, corrupt or
unsupported content, and oversized images. Source bytes are preserved for the
native Keet file send; the pinned worker's `externalBlob.id` plus `blob`
descriptor is used for the native file record, and a bounded preview is
generated only for presentation.
An optional caption is sent as one adjacent ordinary text message. A fully
successful call returns `{ sent: true }`; if the image is delivered but its
caption fails, the tool reports a bounded error that says not to retry. Images
are never sent automatically when an Agent turn completes or creates an image.

An Agent turn's final DSH text is never relayed automatically. Call
`keet_list_groups` first, then pass one exact returned `groupName` to the common
destination tools:

- `keet_list_groups`: every admitted Managed Group, Managed Broadcast, and
  Managed DM, returned only as `{ groupName, kind }`;
- `keet_list_members`: at most 128 deterministic current display names (Member
  IDs remain Bridge-owned); Managed Broadcast roster lookup is rejected;
- `keet_read_recent_messages`: 1–50 chronological bounded plain-text records;
  valid edited records expose their current text in explicit reads, while an
  edit never triggers an Agent turn. Managed Group results include stable
  message IDs and optional reply targets; Managed Broadcast results include
  stable message IDs but omit reply targets; DM results omit sender/message/
  reply IDs;
- `keet_send_message`: one non-empty text message up to 16,000 characters.
  Regular groups may use an exact `{ deviceId, seq }` reply target and native
  `mentions` containing exact current member display names. Names are resolved
  immediately against the roster; absent or ambiguous names fail before a
  message is sent, and Member IDs never reach the Agent. Managed Broadcast and
  DM sends are ordinary text and reject `replyTo` and native mentions. An optional
  `reaction` is one bounded Unicode emoji applied only to the exact message
  that triggered the active ordinary Keet turn for a regular group or DM;
  reactions are unavailable for Managed Broadcasts. Text is sent first and a
  requested reaction is best-effort: text-only success returns `{ sent: true }`,
  while a requested reaction returns `{ sent: true, reacted: true|false }`. A
  failed reaction never retries or turns a confirmed text send into a tool
  error.
- `keet_send_image`: one workspace-contained PNG, JPEG, WebP, or GIF to an
  exact Managed Destination, optionally followed by an adjacent caption. The tool is
  available when the host composes the Active Conversation filesystem service;
  inbound image admission additionally requires DSH's attachment service. It
  returns only `{ sent: true }` on complete success.

After any confirmed `keet_send_message` text delivery or successful
`keet_send_image`, the injected Agent policy requires the final DSH response to
be exactly `✓`, whether or not an optional reaction was confirmed. Without a
successful delivery, the Agent responds normally. Outbound reactions accept
Unicode emoji only; bounded Keet wire shortcodes such as `heart` appear only as
colon-wrapped inbound context labels such as `:heart:`.

Destination names are captured from bounded titles when a room is admitted at
startup or by live onboarding (line separators become spaces). They remain
stable for the bridge run. Selectors trim input but otherwise match exactly and
case-sensitively. Every destination tool rejects an arbitrary or undiscovered
name before touching Core; normalized duplicate names fail closed, and an
ambiguous send says that no message was sent. The tools never accept
invitations, identity data, arbitrary files, media, or formatting options;
`keet_send_image` accepts only its bounded workspace-contained raster input.

## Verification

The ordinary checks use only fake workers and test-owned temporary directories:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm pack-smoke
```

The official-runtime checks are explicit opt-ins and must use fresh temporary
identity directories. `pnpm real-worker-smoke` is skipped unless
`KEET_OFFICIAL_RUNTIME_SMOKE=1` is set. The two-sidecar onboarding smoke is
similarly skipped unless `KEET_OFFICIAL_ONBOARDING_SMOKE=1` is set; see the
operator guide for its required runtime variables. Never use a real user's
identity, group, invitation, or data directory in tests.

The real-worker smoke verifies the official worker's Keet reply relation. The
opt-in two-sidecar onboarding smoke additionally creates a fresh Broadcast,
observes its room type on both identities, verifies a moderator post is
persisted and a non-moderator post is rejected, and propagates a generated
profile/avatar observation. Neither smoke claims desktop UI rendering; the
manual circular-avatar check remains a separate disposable operator smoke.
No official-runtime image interoperability smoke was authorized for this
feature, so official-client image compatibility is unverified.

## Scope and privacy

The public package contains only source-derived Host/client code, declarations,
the Cordis patch, documentation, license, and notices. Official binaries,
bundles, native addons, extracted source, identities, invitations, room IDs,
message data, and other local research material stay outside package artifacts.
The complete `.scratch/` tree is local-only and ignored. Raw
Hypercore/Hyperswarm transports are separate networks and are not Keet
compatibility substitutes.

MCP, OpenClaw, Hermes, a general chat CLI, multiple identities,
automatic final-text delivery, non-image files/media/calls, role management or
inspection, avatar removal, and private-only operation remain outside this v1
slice.
