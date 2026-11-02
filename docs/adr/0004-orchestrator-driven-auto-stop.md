# Auto-stop is decided by the Orchestrator, not itzg

itzg ships its own Auto-stop (`ENABLE_AUTOSTOP`), but Nether never enables it. Instead the Runtime polls the Server List Ping and reports the player count, when the Game Server became Idle and when a ping last succeeded; the Orchestrator runs the idle timer and ends the Session with an ordinary `session.stop`. This keeps the Orchestrator the only authority over Session state, records a precise end reason, and lets the caller change the timeout while a Session is running.

## Considered Options

- **itzg's built-in Auto-stop, with the Runtime watching for the container to exit.** Least code, but the policy is frozen in the container env at Session start, the exit code is 0 for any clean stop so the reason has to be scraped from a log line, and a failing ping counts as "someone online", so a hung server never stops.
- **The Runtime runs the timer and calls `docker stop` itself.** It knows the reason, but it moves Session state on its own, against the rule that the Runtime only observes and executes.

## Consequences

- While the Runtime is disconnected, nothing auto-stops; the `runtime_lost` timeout covers that window.
- Because the ping is polled by Nether, a Game Server whose ping keeps failing can be stopped as `unresponsive`, a backstop that itzg's Auto-stop can't provide.
