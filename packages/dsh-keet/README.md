# `@lamplitisles/dsh-keet`

This local DSH plugin connects one already-joined Keet Managed Group to one
existing DeepSeek Harness conversation. It targets DSH `0.1.2-rc.1` and the
official Keet compatibility tuple documented in the workspace runtime guide.

Build the package with Bun and install the resulting directory or tarball in a
test-owned DSH profile:

```sh
bun install --frozen-lockfile
bun run build
npm pack ./packages/dsh-keet --pack-destination .local
dsh plugin --profile web add .local/lamplitisles-dsh-keet-0.1.0.tgz
```

The plugin has two restart-scoped settings: Managed Group ID and DSH workspace.
The private official runtime is discovered at
`$DSH_HOME/runtimes/keet/4.21.0-linux-x64`, while identity data is initialized
under the selected workspace at `.dsh/dsh-keet/identity`. Join and name that
identity with `dsh-keet-setup`; invitation input is read from stdin and is
never an Agent tool or setting.

The bridge selects the latest eligible existing human conversation at startup.
Incoming external text is bounded as untrusted context and rendered once per
message as a structured record containing the canonical message ID components
and sender identity. Integration-authored messages are tracked internally for
reply ownership and are never replayed as human context. A mention, the
identity's current non-empty display label, or a Keet replyTo relation opens one
serialized Agent turn. The Agent's final text is not sent automatically.

Only these fixed-group tools are registered:

- `keet_list_members` — current bounded roster;
- `keet_read_recent_messages` — 1–50 chronological ordinary text records;
- `keet_send_message` — explicit bounded text delivery with an optional exact
  `{ deviceId, seq }` Keet replyTo target.

The artifact contains source-derived code, declarations, the client bundle,
Cordis patch, license, and notices. Runtime assets and identity/group data are
operator-local and are not part of this package.
