# `@lamplitisles/dsh-keet`

This local DSH plugin discovers every joined Keet `Default` room and accepted
complete `DirectMessage` room in one existing DeepSeek Harness conversation. It
targets DSH `0.1.2-rc.1` and the
official Keet compatibility tuple documented in the workspace runtime guide.

Build the package with Bun and install the resulting directory or tarball in a
test-owned DSH profile:

```sh
bun install --frozen-lockfile
bun run build
npm pack ./packages/dsh-keet --pack-destination .local
dsh plugin --profile web add .local/lamplitisles-dsh-keet-0.1.0.tgz
```

The plugin has one restart-scoped setting: the DSH workspace. At startup the
bridge reads one bounded canonical joined-room snapshot and one bounded
pending-request snapshot. Joined `Default` rooms become Managed Groups;
complete `DirectMessage` rooms whose peer is not pending become Managed DMs.
Broadcasts, unknown or incomplete rooms, pending requests, and duplicate room
records are excluded. A pending-snapshot failure fails startup closed. An empty
eligible set is valid, so onboarding can be completed before a later restart.
Failure text is bounded and does not include invitations or worker-private
records.
The private official runtime is discovered at
`$DSH_HOME/runtimes/keet/4.21.0-linux-x64`, while identity data is initialized
under the selected workspace at `.dsh/dsh-keet/identity`. Join and name that
identity with `dsh-keet-setup`; invitation input is read from stdin and is
never an Agent tool or setting.

The bridge selects the latest eligible existing human conversation at startup.
Each discovered destination has an isolated bounded context buffer. Group
messages retain mention, current-label, and verified-reply triggers. Every new
ordinary external DM text opens one serialized Agent turn. Group prompts retain
canonical message IDs and reply provenance while identifying the source with its
startup `groupName`; DM prompts identify the source and sender label but omit
message IDs and reply relations. Sender IDs never enter Agent prompts.
Integration-authored messages and snapshot/history records never trigger. Human
reactions to an Integration-authored message are silent; changed aggregate
reactions may be included once as bounded, untrusted context on the next
ordinary trigger for that same destination. Keet picker/custom wire tokens that
match the bounded lowercase/digit/_+- grammar use colon-wrapped native names
such as `:heart:` in that context, while literal Unicode reactions remain
unchanged. Whitespace, unsafe punctuation, and arbitrary prose are omitted;
the grammar is forward-compatible display normalization, not an authenticity
assertion. The Agent's final text is not sent automatically.

At the start of active Managed DM work, the bridge marks the triggering chat
index plus one as read and publishes native typing activity. Typing refreshes
every four seconds until the work settles, fails, is cancelled, or a successful
send to that DM occurs; queued messages publish neither signal. These calls are
best-effort and the receiving Keet client eventually expires the last typing
timestamp after its native five-second active window. Regular groups never emit either
signal.

An ordinary DM text equal byte-for-byte to `/compact` is handled by the
composed `@deepseek-ai/dsh-commands` service before it enters the context buffer.
It runs once against the bound Active Conversation without an Agent follow-up or model
history entry, then sends one bounded outcome to the same DM. The DSH command
and compaction backend must be composed; unavailable/empty results use a
generic bounded response, and failures do not retry or fall back to an Agent
turn. Whitespace, arguments, casing changes, and group messages use the
ordinary bridge path.

Call `keet_list_groups` first. The other three tools require an exact returned
`groupName` (caller whitespace is trimmed, matching remains case-sensitive):

- `keet_list_groups` — every discovered Managed Group and Managed DM, each
  returned only as `{ groupName, kind }`;
- `keet_list_members` — current bounded roster of display names only;
- `keet_read_recent_messages` — 1–50 chronological ordinary text records;
  regular-group records retain canonical message IDs and optional reply targets,
  while DM records omit all message/reply IDs;
- `keet_send_message` — explicit bounded text delivery. Regular groups accept
  an exact `{ deviceId, seq }` reply target; DM sends are ordinary text and
  reject `replyTo`. An optional `reaction` is one bounded Unicode emoji applied
  only to the exact message that triggered the active ordinary Keet turn. Text
  is sent first and the reaction is best-effort: text-only success returns
  `{ sent: true }`, while a requested reaction returns
  `{ sent: true, reacted: true|false }`. A failed reaction never retries or
  turns a confirmed text send into a tool error.

After any confirmed `keet_send_message` text delivery, the injected Agent
policy requires the final DSH response to be exactly `✓`, whether or not its
optional reaction was confirmed; otherwise it responds normally. Outbound
reactions accept Unicode emoji only. Bounded Keet wire-shortcode values such as
`heart` and `+1` appear only as colon-wrapped inbound context labels such as
`:heart:` and `:+1:`.

Names are captured when DSH starts after trimming bounded titles and replacing
line separators with spaces. A missing title uses the bounded fallback name.
No match is rejected before Core access; normalized duplicate names fail closed,
and an ambiguous send explicitly reports that no message was sent. Human-only
onboarding supports the following operations:

```sh
dsh-keet-setup dm-requests --workspace /path/to/workspace
dsh-keet-setup dm-accept --workspace /path/to/workspace --member-id <peer-member-id>
dsh-keet-setup profile --workspace /path/to/workspace --avatar /path/to/avatar.png
```

Each setup operation needs exclusive ownership of the workspace identity.
Stop the running DSH bridge first and ensure it starts again afterward; for a
systemd user service, run the operation in a Bash subshell with an exit trap:

```sh
bash -lc '
  set -e
  trap "systemctl --user start dsh.service" EXIT
  systemctl --user stop dsh.service
  dsh-keet-setup profile --workspace /path/to/workspace \
    --avatar /path/to/avatar.png
'
```

DM requests are never created or accepted by the Agent. Join and acceptance
success results do not expose room IDs; restart DSH after either operation so
the next startup snapshot can discover the destination. Avatar setup accepts a
local PNG, JPEG, or WebP up to 8 MiB, honors orientation, center-crops to a
square, and prepares deterministic 64/128/256 pixel PNG variants below Keet's
512 KiB inline limit. The square is passed to official clients, which apply a
circular display mask. For an avatar-only CLI update, Core reads the current
non-empty display name and resends it with the avatar as required by Keet; the
operation fails if no current name exists. Avatar removal is not a v1
operation.

The artifact contains source-derived code, declarations, the client bundle,
Cordis patch, license, and notices. Runtime assets and identity/group data are
operator-local and are not part of this package.
