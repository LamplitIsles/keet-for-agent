# Keet for Agent workspace instructions

Read `HANDOFF.md` before changing code. Implementation lives in the Bun
workspace packages under `packages/`: `@lamplitisles/keet-integration-core` is
private and `@lamplitisles/dsh-keet` is the public adapter package. Keep
`.scratch/` wholly ignored; it contains local plans, tickets, deferred notes,
and archived research only.

Use Bun and the pinned Keet 4.21.0 / `@holepunchto/keet-core` 4.21.5 / ABI 35
tuple on Linux x86-64. The official runtime is operator-supplied and must
remain outside package artifacts. The Core admits no other tuple and owns one
identity-data directory exclusively per process. Tests use only fake workers,
fixtures, and fresh test-owned temporary directories; they never inspect or
modify live identities, credentials, groups, invitations, or services.

Before claiming a capability works, run the smallest complete local gates:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
bun run pack-smoke
```

`bun run pack-smoke` packs the local npm-shaped artifact and activates it
through the real DSH Loader in a disposable DSH home. It is the v1 local/link
or tarball operator path. There is no publication, registry, or release
workflow, and nothing may be pushed from this task.

## Git and release audit

For this already-public repository, scope ordinary follow-up PR audits to the
changed diff and files; use a whole-history or broad publish audit only for
first publication, an explicit user request, or concrete evidence of sensitive
artifact or history risk.

Official runtime tests are high-cost operator checks. Run them only when the
user explicitly requests an official-runtime smoke in the current task; the
opt-in environment variables enable execution but do not grant permission.
`bun run real-worker-smoke` requires `KEET_OFFICIAL_RUNTIME_SMOKE=1`; the
two-sidecar onboarding smoke requires `KEET_OFFICIAL_ONBOARDING_SMOKE=1`.
Both use fresh temporary identity paths. When they are not requested, report
official-client interoperability as unverified rather than running them.
Never infer it from fake-worker or Loader tests.

The implementation seam is the official fd-3 `tiny-buffer-rpc` sidecar. Raw
Hypercore/Hyperswarm transports are different networks and do not satisfy
Keet compatibility. Keep runtime files, identity data, invitations, group and
message identifiers, and private research material out of source and package
files. Keep obsolete local probes out of tracked source.
