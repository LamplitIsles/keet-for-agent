# Keet for Agent context

## Managed Destination

A Keet room admitted to the MCP gateway's immutable startup collection. It is
one of:

- **Managed Group** — a joined Default room.
- **Managed Broadcast** — a joined Broadcast room; native permissions decide
  whether the integration identity may post.
- **Managed DM** — a complete accepted Direct Message whose peer is not
  pending.

The MCP name for its stable display selector is `destinationName`. Webhook event
records use the internal field `groupName`; that field is not an MCP argument.

## Integration Identity

The Keet identity exclusively owned by one running Core instance. An identity
directory cannot be shared concurrently by MCP, Impri, another gateway, or an
official-client process.

## Explicit Destination File Send

An agent-requested `send_file` operation for one workspace-contained local
file. All ordinary file types are admitted up to 100 MiB. Supported raster
images additionally carry native dimensions and preview metadata so Keet can
present them as images; other files remain ordinary file cards. File delivery
does not imply adjacent text delivery.

## Incoming Webhook

The optional ordered HTTP delivery path for admitted non-self text messages.
KFA persists each event before its first POST and retains it until a receiver
returns a 2xx response. `eventId` identifies at-least-once redelivery; no image
bytes, image-only event, local media path, or native identifier is delivered.

## Boundaries

The official Keet sidecar is the only native transport. Integration Core owns
normalization and bounded native operations; MCP owns agent-facing tools and
workspace file admission. There is no DSH-specific agent-tool path. Future
consumers should use MCP rather than duplicating those contracts.

## Triggering Message

An incoming message from another Keet participant that gives an agent a reason
to respond: an accepted DM, a Group mention of the Integration Identity, a
Group message containing its current display label, or a Group reply to one of
its messages. Other Group messages and Broadcast messages are observable but do
not trigger an agent. A webhook delivery may carry either kind of incoming
message; it is not a separate Keet message.
