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

This receipt boundary does not claim exactly-once delivery to Keet or to an
external model provider. It provides the narrower, observable guarantee that a
single accepted Keet-triggered inbox item is consumed once by DSH, while a
discarded item remains eligible for later work.
