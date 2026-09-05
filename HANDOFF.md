# Keet for Agent handoff

The implementation is a Bun workspace with one public adapter and one private
reusable Integration Core:

```text
DSH Keet Bridge -> Integration Core -> fd-3 tiny-buffer-rpc -> official Bare sidecar
```

## Source of truth

- `packages/keet-core/src/` owns the typed sidecar lifecycle, pinned runtime
  admission, normalized room/group/member/message values, canonical room-list
  DM resolution, subscriptions, sends, onboarding, and profile update.
- `packages/dsh-keet/src/` owns the DSH Host bridge, Managed Destination tools, setup
  executable, settings schema/client, and protocol rendering.
- `tests/` uses fake workers and test-owned temporary paths for ordinary gates.
- `scripts/pack-smoke.ts` verifies the actual packed tarball through the
  installed DSH Loader and a disposable DSH home.
- `docs/runtime-extraction.md` is the operator guide for the private runtime.

## Product boundary

The bridge binds one already-joined Managed Group and, optionally, one accepted
Managed DM to one existing DSH conversation selected from the configured
workspace. It never creates or switches conversations or groups. The regular
group keeps mention, current-label, and verified-reply triggers; every new
ordinary external DM text triggers one serialized Agent turn. Destination
buffers and subscriptions are isolated, each injected context names its
restart-scoped source `groupName`, and the Agent's final text remains in DSH
unless `keet_send_message` is explicitly called.

The optional DM is admitted only from the canonical joined-room list: exactly
one normalized `DirectMessage` room must name the configured peer Member ID.
There is no dedicated DM Member-ID lookup RPC or compatibility fallback;
pending, missing, duplicate, and non-DM matches fail closed.

The tools are `keet_list_groups`, `keet_list_members`,
`keet_read_recent_messages`, and `keet_send_message`. The first lists only the
configured destinations as `{ groupName, kind }`; the other three require an
exact returned `groupName` (trimmed, case-sensitive, and restart-scoped).
Regular history preserves canonical message IDs and optional reply provenance,
while roster results contain only display names and send results contain only
delivery success. DM history and prompts omit sender/message/reply IDs, and DM
sends are ordinary text. Normalized duplicate names fail selected operations
closed before Core access, with ambiguous sends confirming that no message was
sent.
Setup is human-only: `join` reads exactly one invitation URL from stdin,
`dm-requests` lists bounded sender identities, `dm-accept` accepts one exact
pending sender, and `profile` can independently update display name and a
prepared avatar.

## Compatibility and safety

Only Linux x86-64 with Keet 4.21.0, `@holepunchto/keet-core` 4.21.5, and ABI
35 is admitted. Runtime files are operator-supplied, read-only assets at
`$DSH_HOME/runtimes/keet/4.21.0-linux-x64`. Identity data is persistent
writable state under `<workspace>/.dsh/dsh-keet/identity`. Keep both outside
package artifacts and never use live state in tests. Sidecar diagnostics and
wrapped errors are bounded and redacted.

The root `.scratch/` tree is intentionally ignored and includes active plans,
deferred notes, and preserved archived local material. Do not add it to Git.
Do not push this branch. Before any future owner-authorized push, audit every
committed tree for private artifacts and sensitive path disclosure.

## Gates

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
bun run pack-smoke
```

Official-runtime checks are explicit opt-ins only:

```sh
KEET_OFFICIAL_RUNTIME_SMOKE=1 bun run real-worker-smoke
KEET_OFFICIAL_ONBOARDING_SMOKE=1 bun run official-onboarding-smoke
```

Without those environment variables they must report a skip. Fake-worker and
Loader passes do not establish official-client interoperability. The real-worker
smoke verifies only the official worker's Keet reply relation round-trip; it does
not verify desktop UI rendering.

Profile avatar input is prepared by setup from a local PNG, JPEG, or WebP up to
8 MiB into deterministic square 64/128/256 PNG variants below Keet's 512 KiB
inline limit. Avatar-only updates preserve the current display name. Official
clients apply the circular presentation mask; this repository does not claim a
desktop visual smoke.
