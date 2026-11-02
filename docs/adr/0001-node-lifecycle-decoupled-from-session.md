# Node lifecycle is decoupled from the Session

UpCloud bills Standard plans by the started hour, so a Node destroyed minutes into its hour wastes money already paid. Instead of destroying the Node at Session end, a Node has its own lifecycle (`provisioning → active → parked → releasing → gone`) and a Session borrows it. After a clean Session end the Node is Parked until just before its next billing boundary, and a new Session for the same Game Server reuses it, skipping provisioning, boot and Archive restore and keeping the same IP.

## Considered Options

- **Destroy the Node at Session end.** Simplest, but pays for unused time and makes every restart a cold start.
- **Shared pool across Game Servers.** Bigger savings, but needs a secure wipe, credential rotation and Runtime re-identification between tenants. This is the intended future direction; the MVP only reuses a Parked Node for the Game Server that last ran on it, and the decoupled lifecycle is the seam that makes the pool possible later.

## Consequences

- Setting the parking window to 0 collapses this back to destroy-at-Session-end with no model change.
- Parking is invisible to the API caller: the Game Server shows `stopped`, no billable time accrues, and deleting a Game Server releases its Parked Node first.
