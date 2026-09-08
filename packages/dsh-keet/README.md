# `@lamplitisles/dsh-keet`

This local DSH plugin discovers every joined Keet `Default` or `Broadcast` room
and accepted complete `DirectMessage` room in one existing DeepSeek Harness
conversation, and can admit additional rooms through human settings actions
while the bridge is running. It targets DSH `0.1.2-rc.1` and the
official Keet compatibility tuple documented in the workspace runtime guide.

Build the package with pnpm and Node.js and install the resulting directory or tarball in a
test-owned DSH profile:

```sh
pnpm install --frozen-lockfile
pnpm build
npm pack ./packages/dsh-keet --pack-destination .local
dsh plugin --profile web add .local/lamplitisles-dsh-keet-0.1.0.tgz
```

The plugin has one saved, restart-scoped setting: the DSH workspace, plus
durable live Member Join Trigger preferences keyed by workspace and stable
ordinary-group ID. At startup the bridge reads one bounded canonical joined-room
snapshot and one bounded pending-request snapshot. Joined `Default` rooms become
Managed Groups, joined `Broadcast` rooms become Managed Broadcasts, and complete
`DirectMessage` rooms whose peer is not pending become Managed DMs. Unknown or
incomplete rooms, pending requests, and duplicate room records are excluded. A
pending-snapshot failure fails startup closed. An empty eligible set is valid.
Managed Broadcasts are
destinations for reading history and sending text or images. They have no
bridge state, subscription, inbound Agent trigger, context buffer, typing/read activity, roster lookup,
reply anchor or reaction decoration. The native Keet Core
adjudicates every post from current permission; a rejected post is a bounded
safe send failure with no retry.
Failure text is bounded and does not include invitations or worker-private
records.
The private official runtime is discovered at
`$DSH_HOME/runtimes/keet/4.21.0-linux-x64`, while identity data is initialized
under the selected workspace at `.dsh/dsh-keet/identity`. Profile and searchable
username changes remain available through `dsh-keet-setup`; room invitations and
DM requests are handled by the running settings card and are never Agent tools
or persisted settings.

The bridge selects the latest eligible existing human conversation at startup
and keeps it for its lifetime. Human settings actions can extend the admitted
destination collection without creating another conversation or restarting DSH.
Each Managed Group and Managed DM has an isolated bounded context buffer;
Managed Broadcasts have no inbound state or subscription. Group messages retain
mention, current-label, and verified-reply triggers. Every new ordinary
external DM text opens one serialized Agent turn. Group prompts retain
canonical message IDs and reply provenance while identifying the source with its
admission-time `groupName`; DM prompts identify the source and sender label but omit
message IDs and reply relations. Sender IDs never enter Agent prompts.
Integration-authored messages and snapshot/history records never trigger. Human
reactions to an Integration-authored message are silent. Aggregate reaction
context is delivered at most once for each exact target-message, emoji, and
visible-count tuple, including across DSH restarts; a new count remains eligible.
A canceled inbox removal leaves its receipt eligible, while removing and later
re-adding the same tuple does not notify again. Targets are whitespace-normalized
prefixes of at most 48 Unicode code points, followed by one ellipsis only when
content was omitted. These bounded summaries are untrusted context on the next
ordinary trigger for that same destination. Keet picker/custom wire tokens that
match the bounded lowercase/digit/_+- grammar use colon-wrapped native names
such as `:heart:` in that context, while literal Unicode reactions remain
unchanged. Whitespace, unsafe punctuation, and arbitrary prose are omitted;
the grammar is forward-compatible display normalization, not an authenticity
assertion. The Agent's final text is not sent automatically. A newly admitted
group or DM establishes its history baseline and subscription before
publication, so only messages received after that intake boundary can trigger a
turn; history is not replayed.

While ready, the bridge polls each enabled ordinary Managed Group roster every
ten seconds. Member Join Trigger is off by default and independently selectable
in the settings card; DMs and Broadcasts have no toggle. The first successful
read for each enabled admitted group is its startup or admission baseline. A
later observed member addition produces one bounded Member Join turn at most
once per group/member pair across restarts. Enabling takes effect live and
resets that group's baseline, so disabled-period arrivals are not replayed;
disabling suppresses queued observations without interrupting a turn already
running. Startup members, missed between-poll joins, failed reads, the
Integration Identity, DMs, Broadcasts, and leave/rejoin churn do not produce
turns. Member Join context contains only an untrusted display name and source
`groupName`, with no message/reply ID, image, activity, or reaction capability.
DSH's durable inbox splice history is the at-most-once receipt authority;
ordinary canceled inbox work remains eligible, while preference-suppressed
work does not.

New external Managed DM messages may contain one or more PNG, JPEG, WebP, or
GIF images with an optional caption. The bridge sends one tuple through a
finite `readFileStream` request, half-closes the request side, admits the
complete batch through DSH's durable `attachments` service, and submits one
Agent turn with the caption and ordered durable image blocks. The complete
batch is bounded by 60 seconds; expiry destroys the active stream. A download,
validation, or storage failure creates no image reference, session event, or
Agent turn; when possible one bounded DM failure notice is sent and a
non-triggering failure record remains for the next successful turn in that DM,
while later messages continue. Group/self/snapshot/historical images do no
image work, and `keet_read_recent_messages` remains plain-text-only.

At the start of active Managed DM work, the bridge marks the triggering chat
index plus one as read and publishes native typing activity. Typing refreshes
every four seconds until the work settles, fails, is cancelled, or a successful
send to that DM occurs; queued messages publish neither signal. These calls are
best-effort and the receiving Keet client eventually expires the last typing
timestamp after its native five-second active window. Regular groups never emit either
signal.

An ordinary DM text equal byte-for-byte to `/compact` is handled by the
composed `@deepseek-ai/dsh-commands` service before it enters the context buffer.
It runs once against the bound Active Conversation without an Agent follow-up or model
history entry, then sends one bounded outcome to the same DM. The DSH command
and compaction backend must be composed; unavailable/empty results use a
generic bounded response, and failures do not retry or fall back to an Agent
turn. Whitespace, arguments, casing changes, and group messages use the
ordinary bridge path.

Use the exact destination `groupName` from inbound context or destination
discovery. Call `keet_list_groups` when discovering destinations or resolving an
uncertain target. Caller whitespace is trimmed; matching remains case-sensitive:

- `keet_list_groups` — every admitted Managed Group, Managed Broadcast, and
  Managed DM, each returned only as `{ groupName, kind }`;
- `keet_list_members` — current bounded roster of display names only; Managed
  Broadcast roster lookup is rejected;
- `keet_read_recent_messages` — 1–50 chronological ordinary text records;
  valid edited records expose their current text in explicit reads, while an
  edit never triggers an Agent turn. Managed Group records retain canonical
  message IDs and optional reply targets; Managed Broadcast records retain
  canonical message IDs but omit reply targets, while DM records omit all
  message/reply IDs;
- `keet_send_message` — explicit bounded text delivery. Regular groups accept
  an exact `{ deviceId, seq }` reply target and native `mentions` by exact
  current member display name. The bridge resolves names immediately and fails
  before delivery for missing or ambiguous members; Member IDs never reach the
  Agent. Managed Broadcast and DM sends are ordinary text and reject `replyTo`
  and native mentions. An optional `reaction` is one bounded
  Unicode emoji applied only to the exact message that triggered the active
  ordinary Keet turn for a regular group or DM; it is unavailable for Managed
  Broadcasts. Text is sent first and the reaction is best-effort: text-only
  success returns `{ sent: true }`, while a requested reaction returns
  `{ sent: true, reacted: true|false }`. A failed reaction never retries or
  turns a confirmed text send into a tool error.
- `keet_send_image` — delivery to any Managed Destination of one PNG, JPEG, WebP, or GIF read via
  the bound DSH `ctx.fs` Active Conversation workspace filesystem. The path must
  remain inside that workspace; URLs, unsupported/corrupt/oversized content,
  unknown names and ambiguous names are rejected before
  delivery. Source bytes are preserved for native Keet delivery and a bounded
  preview is used only for presentation. Native records use the Official
  `externalBlob.id` plus `blob` descriptor. An optional caption follows as one
  adjacent ordinary text send. Complete success returns only `{ sent: true }`;
  if the image succeeds but the caption fails, the bounded error says the image
  was delivered and must not be retried. Nothing is sent automatically after a
  turn or image creation.

The injected Agent policy avoids repeating delivered Keet content in DSH.
The final response is exactly `✓` only when the turn solely completes a Keet
reply, delivery is confirmed, and no other result or failure needs reporting.
Other turns finish the requested work and report its outcome, including partial
delivery or failures. Outbound reactions accept Unicode emoji only. Bounded Keet
wire-shortcode values such as `heart` and `+1` appear only as colon-wrapped
inbound context labels such as `:heart:` and `:+1:`.

Names are captured when a destination is admitted, either at startup or through
live onboarding, after trimming bounded titles and replacing line separators
with spaces. A missing title uses the bounded fallback name. No match is rejected
before Core access; normalized duplicate names fail closed, and an ambiguous
send explicitly reports that no message was sent.

## Live human onboarding

After saving the workspace, open the native settings card while readiness is
`Ready` or `Unbound`. Paste one `keet://chat/<token>` URL into the transient
Invitation field and choose `Join`. The card loads bounded Pending DM Requests
when opened; `Refresh` rereads them, and `Accept` submits the exact hidden peer
selector shown with its bounded display name and identity hint. These actions
use the already-running Integration Identity, initialize the resulting room,
and publish the destination to the current Agent tools immediately. They do not
persist invitations or peer IDs, and they do not require a DSH restart.

The card disables actions for unsaved or workspace-mismatched settings and for
unavailable readiness. A successful native mutation followed by an admission
failure is shown as partial and can be retried through admission only; the
confirmed native join or acceptance is never repeated. An `Unbound` bridge can
admit a destination while remaining unbound if no existing DSH conversation is
available. Empty, failed, loading, and new-message-only states are explicit.

`dsh-keet-setup` now supports only the independent human profile and searchable
username operations:

```sh
dsh-keet-setup profile --workspace /path/to/workspace --avatar /path/to/avatar.png
dsh-keet-setup username --workspace /path/to/workspace --username agent_name1
```

Each remaining setup operation needs exclusive ownership of the workspace identity. Core
holds that ownership with an exclusive kernel lock on the persistent
mode-0600 `.keet-sidecar.lock` file. Ownership follows the open descriptor and is
released by the kernel after an abnormal process death; a live owner still
fails another opener immediately. The file is not a stale PID record and must
never be deleted manually. Stop the running DSH bridge before these setup
operations; for a systemd user service, run the operation in a Bash subshell
with an exit trap:

```sh
bash -lc '
  set -e
  trap "systemctl --user start dsh.service" EXIT
  systemctl --user stop dsh.service
  dsh-keet-setup profile --workspace /path/to/workspace \
    --avatar /path/to/avatar.png
'
```

DM requests are never created or accepted by the Agent. The settings card
accepts only the human-selected request and does not expose room IDs. Avatar
setup accepts a
local PNG, JPEG, or WebP up to 8 MiB, honors orientation, center-crops to a
square, and prepares deterministic 64/128/256 pixel PNG variants below Keet's
512 KiB inline limit. The square is passed to official clients, which apply a
circular display mask. For an avatar-only CLI update, Core reads the current
non-empty display name and resends it with the avatar as required by Keet; the
operation fails if no current name exists. Avatar removal is not a v1
operation.

The human-only `username` operation is distinct from `profile`: it reserves or
changes the globally unique registry name that makes this identity searchable
for an incoming DM request. Names are 3–64 characters, contain a Latin letter
and a digit, and otherwise contain only Latin letters, digits, or underscore.
Exact current-name requests are idempotent. New requests fail closed on an
unavailable or malformed registry response and return success only after the
name resolves to the current Member ID. The operation waits through the full
60-second convergence budget. If a native mutation was accepted but the exact
lookup is still pending, setup exits 1 with one bounded JSON result containing
`ok: false`, `operation: "username"`, the requested `username`,
`status: "pending"`, `submitted: true`, and `retryable: true`.
`submitted: false` is used when an exact current-name request only verified
lookup convergence. Retry the exact same name; there is no alternate-name or
background polling behavior. Previously used names remain reserved; the
official client permits four changes after initial registration.

The artifact contains source-derived code, declarations, the client bundle,
Cordis patch, license, and notices. Runtime assets and identity/group data are
operator-local and are not part of this package. The local fake-worker and
Loader gates do not establish official-client image interoperability. The
explicit two-sidecar onboarding smoke verifies fresh Broadcast room typing,
moderator posting, and non-moderator rejection when it is run with its opt-in
environment variable; it does not claim desktop UI rendering or image
interoperability.
