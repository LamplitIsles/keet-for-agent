# DSH inbox delivery receipts

Keet intake is at-most-once at the Agent boundary. The Bridge treats a DSH
inbox claim—not `followup()` returning—as the delivery receipt: the inbox has
durably removed that exact user message before it publishes
`agent/inbox/claimed`.

For a Keet-triggered turn, the Bridge creates one identified DSH user message
and holds its bridge-local pending work by that message ID. A claim consumes
the pending work; a discard does not. The subsequent session `user/message`
event associates the claim with its exact turn, and `turn/end` or an Agent
error clears the active work. This ordering means retries, rejected claims,
and canceled inbox work cannot be mistaken for a delivered turn.

The authoritative durable record is DSH's `agent/inbox/spliced` event. A
splice inserts a pending message; a non-canceled removal is the claim receipt;
a removal with `outcome: "canceled"` is not. The Bridge never writes a second
state file or treats an outbound Keet send as an Agent-turn receipt. Native
mentions are normal explicit sends and remain subject to Keet's own send
confirmation.

Member Join observations carry a bounded adapter-private receipt on their DSH
user message. The bridge replays every inspectable workspace session's inbox
splices at startup: insertion is pending, a non-canceled removal is consumed,
and a canceled removal remains eligible. That receipt is keyed to the
group/member pair without placing Keet IDs in the model-visible prompt. If any
session inspection or receipt replay is incomplete, roster observations are
suppressed for that bridge run; ordinary message intake still follows the
normal claim/discard/settle path.

This receipt boundary does not claim exactly-once delivery to Keet or to an
external model provider. It provides the narrower, observable guarantee that a
single accepted Keet-triggered inbox item is consumed once by DSH, while a
discarded item remains eligible for later work.
