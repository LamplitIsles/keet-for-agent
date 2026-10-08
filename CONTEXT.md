# Keet for Agent context

## Managed Destination

A Keet conversation admitted for agent interaction: a joined Default Group, a
joined Broadcast, or a complete accepted Direct Message whose peer is no longer
pending. Native Keet permissions still govern actions in it.

## Integration Identity

The Keet participant whose conversations the integration observes and in whose
name it acts. One running integration owns that identity at a time.

## Explicit Destination File Send

An agent-requested delivery of one local file to a Managed Destination. File
delivery is separate from text delivery, even when the file is an image.

## Incoming Message Event

An ordered report of a non-self text or image message in a Managed Destination,
including a message containing only images. A receiver decides whether the
message calls for agent action and whether to retrieve its images.

## Inbound Keet Image

An image attached to an incoming message. KFA owns a retained copy of each
image it can read and validate; that copy persists until an operator manually
removes it, independently of event acknowledgement.

## Image Reference

An opaque reference in an Incoming Message Event to a retained Inbound Keet
Image. An event's available-image fact and reference remain unchanged on
redelivery and after an operator removes the retained copy; retrieval then fails.

## Unavailable Image

An Inbound Keet Image that KFA could not read or validate while processing its
message. Its absence does not suppress the event, so the receiver can handle
the missing image explicitly.

## Triggering Message

An incoming message that a receiver decides calls for agent action. Receivers
own the policy for DMs, Group mentions, labels, replies and aliases; KFA reports
all admitted incoming messages, including ordinary Group messages and Broadcasts.

## Addressing Facts

Whether a message natively mentions the Integration Identity, whether its reply
target is verified as belonging to that identity, and the identity's current
label when available. Unknown reply ownership is absent rather than false.
These facts inform receiver policy without deciding whether to respond.

## Keet Reaction

An emoji signal attached to one exact Keet message, visible as an aggregate
without attribution to individual reactors. Its bounded context accompanies
incoming Group and DM messages and may inform a later receiver turn; a reaction change alone is not a message.

## Reaction Response

An agent-requested text message paired with an optional Keet Reaction on an
explicitly identified message in the same Managed Group or DM. Text is
delivered first; the reaction is best effort and never a standalone send.
