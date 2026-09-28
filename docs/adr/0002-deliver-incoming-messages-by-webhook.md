# Deliver incoming messages by webhook

Status: accepted

Each KFA instance may configure one webhook receiver for incoming messages. KFA pushes every admitted incoming event in the same bounded envelope after making it durable, retains pending delivery until the receiver acknowledges durable acceptance, and uses a stable event key so the receiver can discard duplicates. CFL and a Cloudflare-hosted agent run against separate KFA instances and Keet identities; each receiver gets the full event stream and decides locally how to use ordinary Group messages, Triggering Messages, and Broadcast messages.

This replaces `/cfl` as the incoming delivery transport once CFL has a webhook handler. A webhook is sufficient for both local and remote receivers; the WebSocket hello, replay, and resync protocol need not remain. The durable delivery record and retry state still matter, because HTTP delivery can fail or time out. When image support is added, the same delivery must make bounded DM image contents available to either receiver without a shared filesystem or another KFA endpoint.

The delivery guarantee begins when KFA observes and persists an event. Recovering Keet messages received while KFA itself was stopped is a separate capability and is not part of this decision.

The first implementation slice delivers text-bearing events. Image contents and image-only events are deferred; this narrower slice applies equally to local and remote receivers.

Receivers authenticate requests, persist an event before acknowledging it, and deduplicate repeated deliveries. KFA preserves event order within an instance so an ordinary Group message reaches the receiver before a later Triggering Message that may use it as context. A failed receiver therefore leaves later events pending rather than silently skipping one.

The receiver URL is `KEET_WEBHOOK_URL`; it must be HTTPS or loopback HTTP and
cannot contain credentials or a fragment. `KEET_WEBHOOK_BEARER_TOKEN` is
optional, requires the URL, and is sent only as `Authorization: Bearer …`.
Every `POST` has `Content-Type: application/json` and a body with `type`, UUID
`eventId`, positive `sequence`, canonical `messageId`, safe-integer
`timestamp`, `{ groupName, kind }` destination, `senderLabel`, text, and
optional `replyTo` and trigger. Only a 2xx response acknowledges a delivery;
timeouts, network errors, redirects, and all other status codes retry in order.
