# Keet for Agent

Keet for Agent exposes a deliberately narrow subset of Keet group and direct
chat to local agents while keeping transport adapters separate from the
reusable integration logic.

## Language

**Integration Core**:
The reusable TypeScript library that owns sidecar lifecycle and presents stable agent-facing Keet operations. It contains no MCP-, CLI-, or host-plugin-specific behavior.
_Avoid_: Core, Keet Core, daemon

**Official Keet Core**:
Holepunch's native Keet worker, controlled by the Integration Core through its pinned sidecar RPC interface.
_Avoid_: Integration Core, protocol reimplementation

**Official Runtime**:
The private, version-pinned executable, worker bundle, and native addons required to run the Official Keet Core. It is not part of the open-source distribution.
_Avoid_: Published runtime, bundled dependency

**Adapter**:
A thin host-specific interface over the Integration Core. The first Adapter is
the DSH Keet Bridge; MCP, OpenClaw, Hermes, and a general CLI adapter are later
work. The setup executable is intentionally narrower than a general CLI and
only performs human onboarding, searchable-username reservation, DM request
acceptance, and profile updates.
_Avoid_: Independent client implementation

**Managed Group**:
A pre-existing Keet `Default` room, already joined by the bridge identity, that
one DSH Keet Bridge discovers at startup and exposes to its Active
Conversation. Agents can read, reply to, and proactively send text or images
in that group; destination tools select it by the exact startup
`groupName`, never by an arbitrary room ID.
_Avoid_: Approved Room, arbitrary room, adapter-created group

**Managed Broadcast**:
A pre-existing Keet `Broadcast` room, already joined by the bridge identity,
that the DSH Keet Bridge discovers at startup. Agents can read its plain-text
history and proactively publish text or images, but its inbound messages do
not trigger Agent turns or accept reply relations. It has no Bridge state,
subscription, context buffer, typing/read activity, roster, or reaction
path; the Official Keet Core decides each posting attempt from the identity's
current native permission, so rejected posts are surfaced without retry.
_Avoid_: Managed Group, role-cached broadcast, arbitrary room

**Managed DM**:
An accepted complete one-to-one Keet room typed `DirectMessage`, discovered in
the canonical joined-room list when its peer is absent from the bounded pending
request snapshot. It shares the Integration Identity and Active Conversation
with every Managed Group and Managed Broadcast. Every new ordinary external DM text triggers a turn;
DM prompts and history omit canonical message IDs and reply relations.
_Avoid_: contact request, arbitrary private room, Agent-created DM

**Managed Destination**:
One entry in the bridge's immutable startup allowlist: every joined `Default`
room, joined `Broadcast` room, and accepted complete `DirectMessage` admitted
from the bounded snapshot. `keet_list_groups` returns these entries as an exact
`groupName` and `kind`; the other Keet tools require that exact returned name.
_Avoid_: all joined rooms, implicit target, arbitrary destination

**Managed Destination Name**:
The bounded, single-line name captured from a destination title when the bridge
starts. Leading/trailing whitespace is trimmed and record-breaking line
separators become spaces. Selectors trim their input, then compare this
restart-scoped snapshot exactly and case-sensitively. Equal names are ambiguous
and fail selected operations closed.
_Avoid_: alias, fuzzy name, live rename, group ID

**Single-session multiplexing**:
All discovered Managed Destinations share one existing DSH Active Conversation.
Each destination keeps its own context buffer, while arrival classification and
Agent turns remain serialized through that session.
_Avoid_: one session per destination, session switching

**Model-visible ID ownership**:
Group IDs and Member IDs remain Bridge/Core-owned routing and classification
state. Agent-visible list, roster, history, and send results omit those IDs;
regular-group and Managed Broadcast history may retain canonical Keet Message
IDs, while optional reply targets are useful only for regular-group sends.
Managed DM records expose no message or reply IDs.
_Avoid_: sender ID in prompts, roster Member ID, send receipt Message ID

**DSH Keet Bridge**:
The DSH Adapter that discovers joined/accepted Managed Destinations, carries
their new messages into one Active Conversation, and gives that conversation
explicit-destination Keet tools backed by the Integration Core.
_Avoid_: MCP server, Keet client implementation

**Active Conversation**:
The existing DSH conversation selected from the configured workspace when the DSH Keet Bridge starts. The bridge keeps that conversation for its lifetime and never creates or switches it.
_Avoid_: Keet conversation, configured session

**Destination Context Buffer**:
The bounded in-memory sequence of eligible messages for one Managed Destination
not yet supplied to the Active Conversation. A group Reply Trigger or any new
ordinary external DM text drains only that destination's buffer into one
serialized Keet-initiated turn.
_Avoid_: Durable queue, shared chat history

**Canonical Keet Message ID**:
The `{ deviceId, seq }` pair identifying one Keet message. It is distinct from
the Keet Member ID of the identity that authored the message; the bridge may
use an internal flattened key for set lookup, but never presents that key as
message provenance.
_Avoid_: Flattened message key, Member ID

**Keet Member ID**:
The stable identity identifier attached to a message sender or group member.
A Keet reply relation does not carry the target author's Member ID; it carries
only the target message's canonical Keet Message ID.
_Avoid_: Message ID, device ID alone

**Reply Trigger**:
A new Managed Group message that mentions the Keet identity,
contains its current non-empty group display label, or has a Keet replyTo
relation to one of its messages. Ordinary group messages add context without
independently starting a turn. Managed DM ordinary external text uses a
separate every-message trigger and is not a Reply Trigger.
_Avoid_: Every group message, mention only

**Native Mention**:
A regular Managed Group outbound message whose `mentions` are exact current
member display names. The Bridge resolves each name to one current Member ID at
send time and passes Keet's native `{ type: "mention", memberId }` record to
the Core. Missing or duplicate display names fail closed; Member IDs never
cross into Agent-visible prompts, tools, or results.
_Avoid_: literal `@name` text as a substitute, Member ID tool arguments

**Member Join Trigger**:
A bridge-owned observation that a Member ID appears in a regular Managed Group
roster after the first successful ten-second poll baseline. It carries only a
bounded, untrusted display name and source `groupName` into one serialized
Agent turn. Startup, missed-between-poll, failed-read, self, DM, Broadcast, and
leave/rejoin observations do not trigger; a claimed `(group, member)` receipt
remains consumed across DSH restarts.
_Avoid_: native membership event, startup catch-up, automatic welcome, Member ID in a prompt

**Durable Inbox Receipt**:
The adapter-private identifier attached to one DSH user message for admission.
DSH `agent/inbox/spliced` insertion makes a roster receipt pending; a
non-canceled removal consumes it, while `outcome: "canceled"` leaves it
eligible. Incomplete workspace-session inspection suppresses roster intake for
that bridge run without stopping ordinary message triggers.
_Avoid_: plugin receipt database, exactly-once Keet delivery, outbound send receipt

**DM Activity Signal**:

Bridge-owned, best-effort native read-anchor and typing metadata for one active
Managed DM turn. The read anchor is published from the triggering chat index
plus one at follow-up dispatch; typing refreshes every four seconds and stops
when that work settles, sends successfully, or its bridge owner is cancelled.
The signal is never model-visible and regular groups never emit it.
_Avoid_: Agent presence, delivery guarantee, group activity

**Recent Destination Read**:
A bounded retrieval of recent plain-text messages from one discovered
destination. Regular-group results include canonical message IDs and reply
targets and sender display labels; DM results include only display labels and
message data. Valid edited records expose their current text in explicit reads;
edited live updates remain suppressed and never independently start a turn.
Reads provide context without creating a group or independently starting a turn.
_Avoid_: Room export, automatic catch-up

**Inbound DM Image**:
One or more supported raster images received together in a new Managed DM
message, optionally with caption text. The complete message starts one Agent
turn; image retrieval from older messages is not part of a Recent Destination
Read.
_Avoid_: Historical image read, group image trigger, one turn per image

**Inbound DM Image Failure**:
A Managed DM image message that cannot be completely downloaded and admitted.
The bounded admission deadline also covers an unavailable or stalled native
file stream; expiry destroys that stream and uses the same one-notice path.
It produces one bounded sender notice and one non-triggering Destination
Context Buffer record for the next successful DM turn; no failed image bytes
enter the Active Conversation.
_Avoid_: Partial image turn, silent failure, automatic retry

**Managed Group Roster**:
The bounded list of current members in a selected Managed Destination rendered
to the Agent as display names only. The Bridge keeps stable Member IDs
internally for classification and setup, but the roster excludes them along
with device details, presence, historical membership, and identity secrets.
_Avoid_: Account directory, membership history

**Explicit Destination Send**:
A plain-text message deliberately sent by an Agent tool to one discovered
destination selected by its exact returned `groupName`. Regular-group sends
may carry one exact canonical `replyTo` target; Managed DM sends are ordinary
text and reject reply anchors. A send may optionally decorate the current Keet
trigger with one native reaction after the text is delivered. Completing an
Agent turn does not itself send anything to Keet.
_Avoid_: Automatic reply, arbitrary-room send

**Keet Reaction**:
A native Unicode emoji or bounded Keet wire-shortcode reaction attached to one
Keet message by a participant or assistant. Participant reactions are aggregate
signals that can inform a later interaction in the same destination without
starting one, and they do not imply reactor identity. Aggregate reaction
context is delivered at most once for an exact target-message, emoji, and
visible-count tuple, including across DSH restarts. A canceled inbox removal
does not consume the receipt; removing and re-adding the same tuple remains
suppressed, while a changed count is eligible once. The target is a
whitespace-normalized prefix of at most 48 Unicode code points, with one
ellipsis only when content was omitted. Wire tokens are an untrusted inbound
display form; outbound reactions remain Unicode emoji.
_Avoid_: Standalone response, sticker, reaction-triggered turn, reactor attribution

**Reaction Response**:
A written response sent through the explicit destination tool with an optional
Keet Reaction attached to the message that prompted it. The text is always
delivered first; the reaction is a best-effort decoration and never replaces
the response or causes a confirmed text send to be retried.
_Avoid_: Standalone reaction response, arbitrary historical target, automatic toggle/removal

**Explicit Destination Image Send**:
A supported raster image deliberately sent by an Agent tool to a Managed Destination,
selected by exact `groupName` and read only from within the Active
Conversation workspace. It may carry a caption; completing a turn or creating
an image in DSH does not send it automatically.
_Avoid_: Automatic image reply, arbitrary host file

**Keet reply relation**:
An Explicit Destination Send to a Managed Group that references one specific
existing message in that same group through the canonical `replyTo` identifier
so the official Keet worker records the reply relationship. Managed DM sends
do not use this relation. Desktop UI rendering remains a separate disposable
smoke.
_Avoid_: Plain follow-up, quoted-text imitation

**Group Onboarding**:
The one-time human operation that consumes an invitation to join the
integration identity to a Keet group and persists that identity. A human may
separately reserve a searchable username, list and accept pending DM requests,
and update the identity profile. Normal Agent tools never create, accept, or
reveal invitation/request material; DSH restarts to discover newly authorized
destinations.
_Avoid_: Agent invitation tool, automatic group creation

**Searchable Keet Username**:
The human-managed, globally unique registry reservation that lets another Keet
human find the dedicated Integration Identity and initiate a DM request. It is
not the display name or profile. The setup CLI invokes the Integration Core's
syntax validation, availability admission, native register/update selection,
and bounded lookup convergence; the bridge, Agent tools, settings, and model
context do not expose username mutation.
_Avoid_: Display name, Agent-editable username, contact alias

**Integration Identity Profile**:
The human-managed display name and optional avatar of the dedicated Keet
identity, updated through the narrow setup CLI. Setup converts a local PNG,
JPEG, or WebP into deterministic square 64/128/256 PNG variants and preserves
the current non-empty display name for avatar-only updates. Official clients
apply the circular presentation mask.
_Avoid_: Agent-editable identity, general profile manager
