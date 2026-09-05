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
only performs human onboarding, DM request acceptance, and profile updates.
_Avoid_: Independent client implementation

**Managed Group**:
A pre-existing Keet group, already joined by the configured identity, that one DSH Keet Bridge exposes to its Active Conversation. Agents can read, reply to, and proactively send plain-text messages in that group; Keet tools do not accept an arbitrary room ID.
_Avoid_: Approved Room, arbitrary room, adapter-created group

**Managed DM**:
An accepted one-to-one Keet room typed `DirectMessage`, resolved from the
canonical joined-room list by the other participant's stable Member ID. The
resolution requires exactly one matching room; there is no dedicated Member-ID
lookup RPC. It is optional, shares the Integration Identity and Active
Conversation with the Managed Group, and is the only private destination the
bridge may expose. Every new ordinary external DM text triggers a turn; DM
prompts and history omit canonical message IDs and reply relations.
_Avoid_: contact request, arbitrary private room, Agent-created DM

**Managed Destination**:
One entry in the bridge's immutable startup allowlist: the required Managed
Group and, at most, one resolved Managed DM. `keet_list_groups` returns these
entries; the other Keet tools require one exact returned `groupId`.
_Avoid_: all joined rooms, implicit target, arbitrary destination

**DSH Keet Bridge**:
The DSH Adapter that carries new messages from the configured Managed Group and
optional Managed DM into one Active Conversation and gives that conversation
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
A new Managed Group message that mentions the configured Keet identity,
contains its current non-empty group display label, or has a Keet replyTo
relation to one of its messages. Ordinary group messages add context without
independently starting a turn. Managed DM ordinary external text uses a
separate every-message trigger and is not a Reply Trigger.
_Avoid_: Every group message, mention only

**Recent Destination Read**:
A bounded retrieval of recent plain-text messages from one configured
destination. Regular-group results include canonical message IDs and reply
targets; DM results omit those fields. Reads provide context without creating a
group or independently starting a turn.
_Avoid_: Room export, automatic catch-up

**Managed Group Roster**:
The bounded list of current members in the Managed Group, identified by stable member ID and current display name. It excludes other groups, device details, presence, historical membership, and identity secrets.
_Avoid_: Account directory, membership history

**Explicit Destination Send**:
A plain-text message deliberately sent by an Agent tool to one configured
destination. Regular-group sends may carry one exact canonical `replyTo` target;
Managed DM sends are ordinary text and reject reply anchors. Completing an
Agent turn does not itself send anything to Keet.
_Avoid_: Automatic reply, arbitrary-room send

**Keet reply relation**:
An Explicit Destination Send to a Managed Group that references one specific
existing message in that same group through the canonical `replyTo` identifier
so the official Keet worker records the reply relationship. Managed DM sends
do not use this relation. Desktop UI rendering remains a separate disposable
smoke.
_Avoid_: Plain follow-up, quoted-text imitation

**Group Onboarding**:
The one-time human operation that consumes an invitation to join the
integration identity to its Managed Group and persists that identity. A human
may separately list and accept one pending DM request and update the identity
profile. Normal Agent tools never create, accept, or reveal invitation/request
material.
_Avoid_: Agent invitation tool, automatic group creation

**Integration Identity Profile**:
The human-managed display name and optional avatar of the dedicated Keet
identity, updated through the narrow setup CLI. Setup converts a local PNG,
JPEG, or WebP into deterministic square 64/128/256 PNG variants and preserves
the current non-empty display name for avatar-only updates. Official clients
apply the circular presentation mask.
_Avoid_: Agent-editable identity, general profile manager
