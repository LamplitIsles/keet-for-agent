# Keet for Agent handoff

The implementation is a Bun workspace with one public adapter and one private
reusable Integration Core:

```text
DSH Keet Bridge -> Integration Core -> fd-3 tiny-buffer-rpc -> official Bare sidecar
```

## Source of truth

- `packages/keet-core/src/` owns the typed sidecar lifecycle, pinned runtime
  admission, normalized room/group/member/message values (including bounded
  aggregate reaction summaries), canonical room-list DM resolution,
  subscriptions, text sends, native reaction add (RPC 156), onboarding, and
  profile update. Core also owns the single Unicode reaction validator.
- `packages/dsh-keet/src/` owns the DSH Host bridge, Managed Destination tools
  (including optional reaction decoration on `keet_send_message`), setup
  executable, settings schema/client, and protocol rendering.
- `tests/` uses fake workers and test-owned temporary paths for ordinary gates.
- `scripts/pack-smoke.ts` verifies the actual packed tarball through the
  installed DSH Loader and a disposable DSH home.
- `docs/runtime-extraction.md` is the operator guide for the private runtime.

Core test boundary: Integration Core normalization, policy, orchestration,
DM convergence, onboarding, profile, cancellation, and stream handling tests
use a real but unstarted `KeetSidecar` whose consumed methods are replaced by
a test-local scripted seam. The fake worker is reserved for the small fd-3
process contract suite: admission, one representative startup/RPC path, one
streaming path, terminal failure, intentional cleanup, and identity locking.
Mocks and the fake worker do not establish official-client interoperability;
the opt-in official-runtime smokes remain the only such evidence.
README.md, `packages/dsh-keet/README.md`, and `CONTEXT.md` describe the
reaction-facing behavior and glossary. `AGENTS.md` owns build commands, safety
constraints, official-smoke policy, and contributor/release workflow, including
the scoped release-audit rule. Runtime extraction/setup documentation remains
unchanged because reactions require no operator configuration or additional
private runtime files. Inbound reaction normalization preserves literal Unicode
and wraps bounded Keet wire shortcodes (for example `heart` as `:heart:`);
outbound reaction validation remains Unicode-only.

## Product boundary

The bridge discovers every joined `Default` room and every accepted complete
`DirectMessage` room from one bounded startup snapshot, then binds all admitted
destinations to one existing DSH conversation selected from the configured
workspace. It never creates or switches conversations or groups. Pending DM
requests, broadcasts, unknown room types, incomplete DMs, and duplicate room
records are excluded; a pending-snapshot failure fails startup closed. Regular
groups keep mention, current-label, and verified-reply triggers; every new
ordinary external DM text triggers one serialized Agent turn. Destination
buffers and subscriptions are isolated, each injected context names its
restart-scoped source `groupName`, and the Agent's final text remains in DSH
unless an explicit delivery tool is called. After a confirmed text send in a
turn (with an optional reaction decoration), the injected policy reduces the
final DSH response to the exact `✓` acknowledgement so the already-delivered
Keet content is not duplicated.

The tools are `keet_list_groups`, `keet_list_members`,
`keet_read_recent_messages`, and `keet_send_message`. The first lists all
discovered destinations as `{ groupName, kind }`; the other three require an
exact returned `groupName` (trimmed, case-sensitive, and restart-scoped).
Regular history preserves canonical message IDs and optional reply provenance,
while roster results contain only display names and send results contain only
bounded delivery booleans. `keet_send_message` always requires non-empty text and may
optionally attach one native Unicode emoji to the current Keet trigger; the
bridge supplies that Message ID internally. It sends text first, then attempts
the reaction once as a best-effort decoration. Text-only success returns
`{ sent: true }`; a requested reaction returns `{ sent: true, reacted: true }`
or `{ sent: true, reacted: false }`. A failed reaction, cancellation, or lost
readiness after text confirmation never retries or converts the tool into an
error. Optional reactions are unavailable outside an active ordinary Keet turn,
for `/compact`, stale/settled work, or another destination. DM history and
prompts omit sender/message/reply IDs, and DM sends are ordinary text. Human
reactions never trigger a turn; changed aggregate reactions on
Integration-authored messages are best-effort bounded context on the next
ordinary trigger for that same destination, with no reactor or Member IDs.
Normalized duplicate names fail selected operations closed before Core access,
with ambiguous sends confirming that no message was sent.
Setup is human-only: `join` reads exactly one invitation URL from stdin,
`dm-requests` lists bounded sender identities, `dm-accept` accepts one exact
pending sender, and `profile` can independently update display name and a
prepared avatar. Join and DM acceptance results do not expose room IDs;
restart DSH after either operation so the next startup snapshot can admit the
destination.

A workspace with no eligible destinations is a valid connected state. When an
Agent is bound, readiness and tools are available with an empty destination
list until a later restart after onboarding.

While active Managed DM work is running, the bridge publishes best-effort
native activity: the triggering message is marked read at chat index plus one,
and typing refreshes every four seconds until the work settles or a successful
same-DM send stops ownership. Queued messages remain unread; the receiving
client expires the last typing timestamp after its native five-second window.
An exact ordinary DM text of `/compact` is intercepted before context/model
input, executed once through the composed DSH command registry against the
bound Agent, and returned as one bounded message in that DM. It creates no
Agent turn or model-history entry; unavailable or failed command/delivery
paths do not retry or fall back. The Host composition must inject the
`commands` service (and its compaction backend).

## Compatibility and safety

Only Linux x86-64 with Keet 4.21.0, `@holepunchto/keet-core` 4.21.5, and ABI
35 is admitted. Runtime files are operator-supplied, read-only assets at
`$DSH_HOME/runtimes/keet/4.21.0-linux-x64`. Identity data is persistent
writable state under `<workspace>/.dsh/dsh-keet/identity`. Keep both outside
package artifacts and never use live state in tests. Sidecar diagnostics and
wrapped errors are bounded and redacted.

The root `.scratch/` tree is intentionally ignored and includes active plans,
deferred notes, and preserved archived local material. Do not add it to Git.
Do not push this branch. Release-audit scope is defined in `AGENTS.md`.

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
