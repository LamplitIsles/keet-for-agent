# Keet for Agent handoff

The implementation is a Bun workspace with one public adapter and one private
reusable Integration Core:

```text
DSH Keet Bridge -> Integration Core -> fd-3 tiny-buffer-rpc -> official Bare sidecar
```

## Source of truth

- `packages/keet-core/src/` owns the typed sidecar lifecycle, pinned runtime
  admission, normalized group/member/message values, subscriptions, sends,
  onboarding, and profile update.
- `packages/dsh-keet/src/` owns the DSH Host bridge, fixed-group tools, setup
  executable, settings schema/client, and protocol rendering.
- `tests/` uses fake workers and test-owned temporary paths for ordinary gates.
- `scripts/pack-smoke.ts` verifies the actual packed tarball through the
  installed DSH Loader and a disposable DSH home.
- `docs/runtime-extraction.md` is the operator guide for the private runtime.

## Product boundary

The bridge binds one already-joined Managed Group to one existing DSH
conversation selected from the configured workspace. It never creates or
switches conversations or groups. Ordinary text is bounded context; a mention,
the current non-empty display label, or a Keet replyTo relation to an integration-authored
message triggers one serialized Agent turn. The Agent's final text remains in
DSH unless `keet_send_message` is explicitly called.

The only tools are `keet_list_members`, `keet_read_recent_messages`, and
`keet_send_message`. All are fixed to the configured group and bounded. Setup
is human-only: `dsh-keet-setup join --workspace <path>` reads exactly one
invitation URL from stdin, and `profile` updates only the display name.

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

Avatar import remains deferred because the official profile operation expects
Keet's internal multi-size image-file representation rather than a path.
