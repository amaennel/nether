# Console output goes through a separate, output-only Console Relay; input goes through the Orchestrator

Console output is high-volume and bursty. Carried over the Runtime's control connection, it would load the Orchestrator's event loop, which owns all lifecycle state. So each Runtime opens a second, Session-long connection to a small, separate **Console Relay**. Only that connection carries Console output to viewers.

The Console Relay is deliberately **read-only**. Console input (which can `op` players or `stop` the game) goes viewer → REST API → Orchestrator → Runtime as a `console.input` command on the control connection. The Console Relay never holds a capability that can change a Game Server, so compromising it exposes logs, not control.

## Considered Options

- **Everything through the Orchestrator.** Simplest boundary, but the Orchestrator's event loop would carry every line of log output.
- **A full relay that also carries input.** Keeps the Orchestrator out of the Console path entirely, but makes the relay as security-sensitive as the control plane.

## Consequences

- Runtimes open two outbound connections. The Console Relay authorizes them with short-lived tokens that the Orchestrator signs and the relay checks offline, so the relay never calls the Orchestrator.
- Console input works only while the Node's control connection is live, and is never queued or re-sent.
