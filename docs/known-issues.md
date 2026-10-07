# Known issues in the 4.22 runtime line

These were reproduced against the official Linux x64 runtime while integrating
the MCP gateway. They are documented here because they affect any host that
drives `@holepunchto/keet-core` through the fd-3 sidecar.

## 1. Room messages are only appendable inside a short window

`addChatMessage` (worker opcode 104) drops a message **silently** when the room's
local record is not available at that instant. In `keet-core`, `_addChatMessage`
does:

```js
const r = await this.keet.local.get("@local/rooms", { roomKey: o })
if (!r) return            // no error, no write, caller still reports success
```

Observed consequences:

- Messages sent back-to-back (a burst with no await gap) **all persist**.
- A message sent after an idle gap of roughly 0.5-1 s is **not written**.
- A fresh process re-opening the identity and sending **immediately** after the
  swarm reports ready still loses the message; the DHT being ready does not mean
  the room is subscribed for writing yet.
- The failure is permanent for that room: retrying with read-back never
  succeeds; only a freshly created room accepts writes, and only in its first
  moments.
- A long-lived process is not a workaround: a room created and then written to
  20 s later is already non-writable.

Minimum reproduction (swarming false, fresh identity):

```ts
const core = await KeetIntegrationCore.start({ executablePath, bundlePath, dataPath, swarming: false })
const gid = await core.createRoom({ title: "t" })
await core.sendMessage(gid, "burst-1"); await core.sendMessage(gid, "burst-2") // both visible
// restart, reopen the same dataPath, then:
await core.sendMessage(gid, "later")   // returns an id, never appears
```

Any host that opens the core per operation, or awaits between sends, therefore
cannot deliver messages at all.

## 2. `createInvitation` throws once the room has a message

Calling `createInvitation` on a room that already contains a chat message fails
with:

```
TypeError: Cannot read properties of null (reading 'anchor')
  at keet-core._createInvitation
```

The failing read is `(await db.get("@keet/invitations", { id })).anchor`.
Creating the invitation **before** the first message works, so the required
order is: create room -> create invitation -> then send.

## 3. The compatibility tuple is pinned to an unpublished release

`docs/runtime-extraction.md` admits Keet 4.22.0 / core 4.22.20 / ABI 35, but
`https://static.keet.io/downloads/4.22.0/Keet-x64.tar.gz` now returns 404.
4.22.4 carries core 4.22.23 with the same ABI 35 and works with the sidecar
protocol. Newer lines are **not** drop-in:

- Keet 4.21.0 (core 4.21.5, ABI 35): the worker rejects the sidecar's RPC
  contract (`TypeError: this._onrequest is not a function`).
- Keet 4.23.0 (core 4.23.8, ABI 37): same RPC failure, and the ABI moved to 37.
