# `@lamplitisles/dsh-keet`

This local DSH plugin connects one already-joined Keet Managed Group and,
optionally, one accepted Managed DM to one existing DeepSeek Harness
conversation. It targets DSH `0.1.2-rc.1` and the
official Keet compatibility tuple documented in the workspace runtime guide.

Build the package with Bun and install the resulting directory or tarball in a
test-owned DSH profile:

```sh
bun install --frozen-lockfile
bun run build
npm pack ./packages/dsh-keet --pack-destination .local
dsh plugin --profile web add .local/lamplitisles-dsh-keet-0.1.0.tgz
```

The plugin has three restart-scoped settings: Managed Group ID, DSH workspace,
and an optional accepted DM peer Member ID. Settings take effect after a DSH
restart. The bridge validates the regular room as `Default`, resolves the
configured peer from the canonical joined-room list as exactly one
`DirectMessage`, and exposes no other joined rooms. A missing, duplicate,
pending, mismatched, or non-DM room fails readiness closed.
If readiness fails, verify the workspace and joined regular group first, then
verify that the configured DM peer was accepted and copied exactly before
restarting DSH. Failure text is bounded and does not include invitations or
worker-private records.
The private official runtime is discovered at
`$DSH_HOME/runtimes/keet/4.21.0-linux-x64`, while identity data is initialized
under the selected workspace at `.dsh/dsh-keet/identity`. Join and name that
identity with `dsh-keet-setup`; invitation input is read from stdin and is
never an Agent tool or setting.

The bridge selects the latest eligible existing human conversation at startup.
Each configured destination has an isolated bounded context buffer. Group
messages retain mention, current-label, and verified-reply triggers. Every new
ordinary external DM text opens one serialized Agent turn. Group prompts retain
canonical message IDs and reply provenance; DM prompts identify the sender but
omit message IDs and reply relations. Integration-authored messages and
snapshot/history records never trigger. The Agent's final text is not sent
automatically.

Call `keet_list_groups` first. The other three tools require an exact returned
`groupId`:

- `keet_list_groups` — configured Managed Group and optional Managed DM;
- `keet_list_members` — current bounded roster;
- `keet_read_recent_messages` — 1–50 chronological ordinary text records;
  DM records omit message IDs and reply targets;
- `keet_send_message` — explicit bounded text delivery. Regular groups accept
  an exact `{ deviceId, seq }` reply target; DM sends are ordinary text and
  reject `replyTo`.

Unconfigured group IDs are rejected before Core access. Human-only onboarding
supports the following operations:

```sh
dsh-keet-setup dm-requests --workspace /path/to/workspace
dsh-keet-setup dm-accept --workspace /path/to/workspace --member-id <peer-member-id>
dsh-keet-setup profile --workspace /path/to/workspace --avatar /path/to/avatar.png
```

DM requests are never created or accepted by the Agent. Avatar setup accepts a
local PNG, JPEG, or WebP up to 8 MiB, honors orientation, center-crops to a
square, and prepares deterministic 64/128/256 pixel PNG variants below Keet's
512 KiB inline limit. The square is passed to official clients, which apply a
circular display mask. Avatar-only updates preserve the current display name;
avatar removal is not a v1 operation.

The artifact contains source-derived code, declarations, the client bundle,
Cordis patch, license, and notices. Runtime assets and identity/group data are
operator-local and are not part of this package.
