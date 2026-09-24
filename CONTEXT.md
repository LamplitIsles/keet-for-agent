# Keet for Agent context

## Managed Destination

A Keet room admitted to the MCP gateway's immutable startup collection. It is
one of:

- **Managed Group** — a joined Default room.
- **Managed Broadcast** — a joined Broadcast room; native permissions decide
  whether the integration identity may post.
- **Managed DM** — a complete accepted Direct Message whose peer is not
  pending.

The MCP name for its stable display selector is `destinationName`. CFL event
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

## CFL Event Feed

The gateway-owned bounded, replayable WebSocket journal of incoming Keet
events. It classifies relevant Group and DM triggers but does not choose an
agent, inject context, or deliver replies.

## CFL Media Library

The durable local collection of inbound DM image files materialized by the
gateway and referenced by CFL conversation history. Journal retention and
media retention are separate ownership concerns.

## Boundaries

The official Keet sidecar is the only native transport. Integration Core owns
normalization and bounded native operations; MCP owns agent-facing tools and
workspace file admission. There is no DSH-specific agent-tool path. Future
consumers should use MCP rather than duplicating those contracts.
