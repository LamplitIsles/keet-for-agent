# Keet for Agent

Keet for Agent exposes a deliberately narrow subset of Keet group chat to local agents while keeping transport adapters separate from the reusable integration logic.

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
only performs human onboarding and display-name updates.
_Avoid_: Independent client implementation

**Managed Group**:
A pre-existing Keet group, already joined by the configured identity, that one DSH Keet Bridge exposes to its Active Conversation. Agents can read, reply to, and proactively send plain-text messages in that group; Keet tools do not accept an arbitrary room ID.
_Avoid_: Approved Room, arbitrary room, adapter-created group

**DSH Keet Bridge**:
The DSH Adapter that carries new messages from one Managed Group into one Active Conversation and gives that conversation fixed-group Keet tools backed by the Integration Core.
_Avoid_: MCP server, Keet client implementation

**Active Conversation**:
The existing DSH conversation selected from the configured workspace when the DSH Keet Bridge starts. The bridge keeps that conversation for its lifetime and never creates or switches it.
_Avoid_: Keet conversation, configured session

**Group Context Buffer**:
The bounded in-memory sequence of eligible Managed Group messages not yet supplied to the Active Conversation. A Reply Trigger drains it into one Keet-initiated turn.
_Avoid_: Durable queue, chat history

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
A new Managed Group message that mentions the configured Keet identity, contains its current non-empty group display label, or has a Keet replyTo relation to one of its messages. Ordinary messages add context without independently starting an agent turn.
_Avoid_: Every message, mention only

**Recent Group Read**:
A bounded retrieval of recent plain-text messages from one Managed Group. It provides conversational context without creating a group or independently starting an agent turn.
_Avoid_: Room export, automatic catch-up

**Managed Group Roster**:
The bounded list of current members in the Managed Group, identified by stable member ID and current display name. It excludes other groups, device details, presence, historical membership, and identity secrets.
_Avoid_: Account directory, membership history

**Explicit Group Send**:
A plain-text message deliberately sent by an agent tool to one Managed Group, either proactively or with a Keet replyTo relation. Completing an agent turn does not itself send anything to Keet.
_Avoid_: Automatic reply, arbitrary-room send

**Keet reply relation**:
An Explicit Group Send that references one specific existing message in the same Managed Group through the canonical `replyTo` identifier so the official Keet worker records the reply relationship. The relation carries only the target's canonical Keet Message ID, not the target author's Keet Member ID. Desktop UI rendering remains a separate disposable smoke.
_Avoid_: Plain follow-up, quoted-text imitation

**Group Onboarding**:
The one-time human operation that consumes an invitation to join the integration identity to its Managed Group and persists that identity. Normal Agent tools never accept or reveal invitation material.
_Avoid_: Agent invitation tool, automatic group creation

**Integration Identity Profile**:
The human-managed display name of the dedicated Keet identity, updated through the narrow setup CLI. Avatar import is deferred because the Official Keet Core requires an internal multi-size image-file representation rather than an ordinary path.
_Avoid_: Agent-editable identity, general profile manager
