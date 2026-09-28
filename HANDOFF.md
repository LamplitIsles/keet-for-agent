# Keet for Agent handoff

## Source of truth

- `packages/keet-core/src/` owns official-sidecar lifecycle, admission of the
  pinned runtime tuple, identity locking, normalized destinations/messages,
  native reads, reactions, onboarding primitives, profile operations, and
  native text/file delivery.
- `packages/keet-mcp/src/` owns the bearer-protected MCP gateway, its immutable
  Managed Destination snapshot, workspace-contained file preparation, the
  optional durable incoming-message webhook and retained original images, plus
  the human-only local setup CLI over the same Core identity.
- `packages/impri-keet/src/` owns the independent Impri approval channel.
- `tests/` uses fake workers, fixtures, and test-owned temporary paths.

There is no DSH adapter or DSH tool contract. A future DSH integration must
consume the MCP surface instead of adding another model-tool adapter to Core.

## MCP contract

The tools are `list_destinations`, `list_members`, `read_recent_messages`,
`send_message`, and `send_file`. Destination-facing arguments and results use
`destinationName`; webhook events retain the event-owned `groupName`
field.

`send_message` requires nonblank text and may request one Unicode emoji
reaction to a canonical target in the same Managed Group or DM. The text is
sent first; reaction success or failure is reported separately from confirmed
text delivery. Broadcast and standalone reaction sends are unsupported.
Qualifying Group and DM webhook message events may include a bounded snapshot of
external aggregate reactions to recent identity-authored messages. Reaction
changes alone do not create events. Core's complete reaction read verifies
ownership for each candidate; a failed read omits that target and preserves
text delivery.

`send_file` supports every admitted Managed Destination. It accepts one
workspace-contained ordinary file up to 100 MiB. PNG, JPEG, WebP, and GIF
retain their source bytes and include dimensions plus a generated native
preview; other files are ordinary Keet file records. Text is delivered
separately with `send_message`.

The gateway admits joined Default rooms, Broadcasts, and complete accepted
Direct Messages from one bounded startup snapshot. Native Keet permissions
remain authoritative. The optional webhook observes non-self text and image
messages, including pure images, persists validated originals and then their
reference events, and retries in order until a 2xx acknowledgement. Failed
image reads or validation are marked unavailable without dropping the message.
Originals remain under `KEET_MCP_STATE_DIR/images/` until manually removed;
`GET /images/{ref}` uses the MCP bearer and returns 404 after removal. It never
injects model context or sends replies. The `/cfl` route is removed.

## Compatibility and safety

Only Keet 4.22.0, `@holepunchto/keet-core` 4.22.20, ABI 35, and Linux x86-64
are admitted. Runtime files are operator-supplied and excluded from packages.
One process exclusively owns each identity directory through the Core lock.
Runtime files, identities, invitations, tokens, and downloaded media never
belong in Git.

The Core uses `sendFile` as its single outbound native-file operation. Its
source-file limit is 100 MiB for both images and non-images. The separate
16 MiB bound applies only to inbound image admission and reads.

## Gates

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm pack-smoke
```

The opt-in `pnpm real-worker-smoke` may run only when explicitly authorized.
Fake-worker tests and package smoke do not establish official-client rendering.
