# Impri Keet approval channel

Approve Impri actions from one private Keet DM with **✅ / ❌** reactions.

```sh
node packages/impri-keet/dist/cli.js run --config /path/to/private/config.json
```

This private workspace adapter reuses the Integration Core. It runs with its
own Keet identity and uses Impri's existing action API. Organon and other
action producers retain execution ownership; the channel presents requests,
submits decisions, and reflects Impri status.

Connect it to your existing Impri instance. It polls the action API and records
decisions with `channel: "keet"`; no notification-channel row, public webhook,
or Impri API/UI changes are required. Bot messages and setup prompts are in English;
action titles and previews retain the text supplied by their producer.

## Build

From the repository root, using the pinned pnpm version and Node.js 22 or later:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

The CLI runs directly from `packages/impri-keet/dist/cli.js` in this checkout.
It needs no DSH conversation or plugin installation.

## Configure and onboard

Prepare the [operator-supplied runtime](../../docs/runtime-extraction.md).
The supported tuple is Keet 4.21.0 / Official Core 4.21.5 / ABI 35 on Linux
x86-64. The runtime can be shared with DSH; the bot's identity must be separate.

Create a private JSON config:

```json
{
  "baseUrl": "http://localhost:8484",
  "inboxUrl": "http://localhost:5173",
  "apiKey": "im_replace_with_a_project_actions_key",
  "runtimeDir": "/absolute/path/to/4.21.0-linux-x64",
  "dataDir": "/absolute/path/to/impri-keet-data"
}
```

| Field | Meaning |
|---|---|
| `baseUrl` | Impri API base, without `/v1`. |
| `inboxUrl` | Impri web inbox base, for `/inbox/:id` links. |
| `apiKey` | Operator-provisioned key with the `actions` scope for the intended Impri project. Admin scope is unnecessary. |
| `runtimeDir` | Absolute directory containing `bare`, `core-worker.bundle`, and its native addons. |
| `dataDir` | Dedicated writable absolute directory for this bot's identity, DM binding, and outstanding requests. |

Protect the config with mode 0600. Paths in JSON are absolute; `~` is not
expanded. When rotating the key, keep it scoped to the same Impri project.

Run setup once, choosing a Keet username containing a Latin letter and a digit:

```sh
chmod 600 /path/to/private/config.json
node packages/impri-keet/dist/cli.js setup \
  --config /path/to/private/config.json --username impribot123
```

Setup creates the dedicated identity, sets its display name to `Impri`, and
reserves the username. In your Keet client, search for that username and send
a DM request. Return to the terminal, refresh the request list, and select
your private DM by number. Only the selected request is accepted and saved;
a running bot never accepts additional DM requests.

If username propagation is pending, rerun setup with the same username.
If already bound, setup verifies the existing destination. Stop the running
bot before rerunning setup: both commands exclusively own the data directory.

Start the channel with the command at the top of this page. Keep it running
in the foreground or under your process supervisor. SIGINT and SIGTERM cancel
pending work, stop the native worker, and release the directory lock.

## Interaction and recovery

The bot picks up pending actions from the configured Impri project, including
ones created while it was offline. Each message carries the title, preview,
inbox link, and the bot's own ✅ and ❌ reactions. Long previews are explicitly
shortened with a link to the complete inbox preview.

- Clicking ✅ submits `approve`; clicking ❌ submits `reject`, with audit
  channel `keet`.
- Bot reactions never count as a choice. In this single private DM, all other
  contributions count; there is no approver Member ID allowlist.
- If both choices are present, the bot asks you to keep only one and submits
  neither. Removing a choice before it is observed leaves nothing to submit.
- Reconnection reads current reactions for actions still pending in Impri;
  it does not replay historical clicks.
- Impri owns the first accepted decision. Later reaction changes cannot undo
  it, and a decision already made through another channel wins.
- Approval is tracked silently. The bot sends a final result when Impri reports
  `executed` or `execute_failed`, and also reports rejection or expiry.

Polling runs serially with a 500-millisecond delay between rounds. Temporary
failures wait five seconds before reconnecting using saved state. Reaction reads address each saved
message directly, so old pending requests remain usable outside recent chat
history. Up to 512 outstanding requests are retained; additional pending
actions are admitted as earlier requests finish.

Preserve the whole data directory across restarts. It contains `identity/`
and `state.json`; its persistent lock files must not be deleted to bypass a
live owner. An existing binding cannot be retargeted to another identity, DM,
or Impri instance. Use a separate data directory for a different bot.

The native send can confirm text without a message ID. The channel recovers
its exact message, including the unique action URL, from recent history before
adding reactions. If an acknowledgement is lost and that unconfirmed message
has already left recent history, a retry can produce another notification.
Notifications are not exactly-once; duplicate decisions remain adjudicated by
Impri. Keep pending approval messages until the action is resolved.

## Verification

`tests/impri-keet.test.ts` covers DM admission, choices, partial decoration,
lost acknowledgements, offline recovery, pagination, Impri conflicts,
exclusive state ownership, and worker replacement. Core tests cover strict
reaction snapshots and startup cancellation using test-owned fake workers.

Real-client rendering and interoperability require the separately requested
official-runtime verification described in the repository instructions.
Ordinary tests use no live identities, real credentials, or external actions.
