# itzg auto-stop and player-count observability

Research for [#2](https://github.com/amaennel/nether/issues/2). Feeds the "Auto-stop design" decision (#13).

Sources are pinned to the commits read on 2026-11-02:

- itzg/docker-minecraft-server @ [`926a34b`](https://github.com/itzg/docker-minecraft-server/tree/926a34b885578c13e04babb5f64cac6fbabe920f) (abbreviated `DMS` below)
- itzg/mc-server-runner @ [`475ca42`](https://github.com/itzg/mc-server-runner/tree/475ca42f7d20eb9ed6e88ad65581bd81ddd63c00) (`runner`)
- itzg/mc-monitor @ [`0917dd2`](https://github.com/itzg/mc-monitor/tree/0917dd208028a47d1fff8a2c01ff9783ff771bf5) (`monitor`)
- minecraft.wiki protocol and server.properties pages (the community-maintained successor to wiki.vg)

## TL;DR

- **itzg auto-stop is a 10-second bash polling loop over Server List Ping (SLP).** "Idle" means `players.online == 0` as reported by `mc-monitor status --show-player-count`. When the idle timer runs out it sends SIGTERM to `mc-server-runner` (PID 1), which sends `stop` over RCON. Java then exits and the **container exits with code 0**.
- **It fails safe toward staying up.** If the ping fails after retries, the loop counts the server as having 1 player. A hung server, or one with `enable-status=false`, never auto-stops. Nether needs its own backstop, such as a max lifetime or the Orchestrator killing the Node.
- **Exit code 0 does not tell you why the server stopped.** An auto-stop, `docker stop`, an in-game or RCON `stop`, and a normal exit all give 0. The only marker unique to auto-stop is the log line `[Autostop] Stopping Java process`. The container is killed (137) only if shutdown takes longer than `STOP_DURATION` or the Docker stop timeout.
- **Auto-pause does not fit Nether.** It freezes the JVM but the VM keeps billing, so it saves nothing on an ephemeral VM. It also can't be combined with auto-stop: the image refuses to start if both are enabled. Since 1.21.2 vanilla pauses itself (`pause-when-empty-seconds`, default 60).
- **SLP is the most reliable player-count signal across server types.** Every Java server type has to answer it, or the multiplayer menu breaks. RCON `list` works but its output text is meant for people to read. Query (UDP) is disabled by default, and its responses are cached and token-gated. Parsing logs is the most fragile option.

## 1. How itzg auto-stop works

### Enabling and timeouts

[DMS `docs/misc/autopause-autostop/autostop.md`](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/docs/misc/autopause-autostop/autostop.md), defaults in [`scripts/start-autostop`](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/start-autostop):

| Variable | Default | Meaning |
|---|---|---|
| `ENABLE_AUTOSTOP` | `false` | Turns the feature on |
| `AUTOSTOP_TIMEOUT_INIT` | `1800` s | How long the server stays up after it starts listening if nobody ever joins |
| `AUTOSTOP_TIMEOUT_EST` | `3600` s | How long the server stays up after the last player leaves |
| `AUTOSTOP_PERIOD` | `10` s | How often the loop checks |
| `AUTOPAUSE_STATUS_RETRY_LIMIT` / `_INTERVAL` | `10` / `2s` | Ping retries per check. Auto-stop reuses the auto-pause names. |
| `DEBUG_AUTOSTOP` | `false` | Turns on `set -x` tracing |
| `USES_PROXY_PROTOCOL` | (unset) | Must be `true` if a PROXY-protocol frontend is in front of the server, otherwise the ping fails |

The docs say the container's restart policy must be `"no"` ([example compose](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/examples/autostop/compose.yml)).

[`scripts/start-configuration` L105-108](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/start-configuration#L105-L108) exits with an error if both `ENABLE_AUTOPAUSE` and `ENABLE_AUTOSTOP` are set.

### State machine

[`scripts/auto/autostop-daemon.sh`](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/auto/autostop-daemon.sh) runs in the background, started from `start-autostop`:

1. Wait until a `java` process exists.
2. **INIT**: wait until `mc_server_listening`, meaning `mc-monitor status` succeeds. Then set the deadline to now + `TIMEOUT_INIT` and move to **II**.
3. **II** (idle since startup): if any player is connected, move to **E**. If `/data/.skip-stop` exists, also move to **E**. If the deadline has passed, run `stop.sh` and exit.
4. **E** (established): once the player count reaches 0, set the deadline to now + `TIMEOUT_EST` and move to **I**.
5. **I** (idle): if a player connects, or `.skip-stop` exists, move back to **E**. If the deadline has passed, run `stop.sh`.

Time comes from `/proc/uptime`, and the loop sleeps `AUTOSTOP_PERIOD` between checks. A player who joins and leaves between two checks is never seen.

### What counts as idle

[`scripts/auto/autopause-fcns.sh`](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/auto/autopause-fcns.sh) defines `java_clients_connections`:

```bash
if java_running; then
  if ! connections=$(mc-monitor status --host ... --port "$SERVER_PORT" \
      --retry-limit 10 --retry-interval 2s $(use_proxy) $(use_server_list_ping) \
      --show-player-count); then
    # consider it a non-zero player count if the ping fails
    connections=1
  fi
else
  connections=0
fi
```

- **Idle** means the SLP `players.online` value is 0. The server's own player count is the only input. Connections that are still logging in, or proxies holding a connection open, are not counted.
- **A failed ping counts as 1 player.** This is deliberate, so that a lagging server is not paused. The side effect is that a hung server or one with `enable-status=false` never stops. `enable-status` defaults to `true` ([server.properties](https://minecraft.wiki/w/Server.properties#enable-status)).
- If the Java process is not in the `S` (sleeping) state, the count is 0. This is aimed at the auto-pause `T` state.
- Servers older than 1.7 use the legacy ping. `VERSION=LATEST` or `SNAPSHOT` always uses the modern ping.

### How the stop happens

1. [`scripts/auto/stop.sh`](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/auto/stop.sh) logs `[<iso-date>] [Autostop] Stopping Java process` and then runs `pkill -f --signal SIGTERM mc-server-runner`.
2. `mc-server-runner` is the container's PID 1 (`exec ${SERVER_RUNNER} ...` in [`start-finalExec`](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/start-finalExec)). It handles SIGTERM the same way as `docker stop` ([runner `main.go` L219-238](https://github.com/itzg/mc-server-runner/blob/475ca42f7d20eb9ed6e88ad65581bd81ddd63c00/main.go#L219-L238)). It waits through `STOP_SERVER_ANNOUNCE_DELAY` if set, then sends `stop` over rcon-cli, or writes it to stdin if RCON fails.
3. It allows `--stop-duration`, which is `STOP_DURATION` with a default of 60 s ([`start-finalExec` L214](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/start-finalExec#L214)), before calling `Process.Kill()` ([L344-351](https://github.com/itzg/mc-server-runner/blob/475ca42f7d20eb9ed6e88ad65581bd81ddd63c00/main.go#L344-L351)).
4. When Java exits, the runner exits with **Java's exit code** (`os.Exit(exitCode)`, [L260-265](https://github.com/itzg/mc-server-runner/blob/475ca42f7d20eb9ed6e88ad65581bd81ddd63c00/main.go#L260-L265)). A clean `stop` gives **0**. A JVM that was killed gives non-zero, and the runner logs a hint when the code is 137.

Auto-stop does **not** go through Docker. Docker's own stop timeout (10 s by default for `docker stop`) only applies when the Runtime itself calls `docker stop`. In that case the timeout must be longer than `STOP_DURATION` plus any announce delay, or Docker kills the server mid-save with SIGKILL and exit code 137. The image's docs warn about this in [misc-options.md, Server Shutdown Options](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/docs/configuration/misc-options.md).

### Escape hatch

While `/data/.skip-stop` exists, auto-stop is suppressed and the timer resets. The Runtime could create this file to hold a Node open, for example during a backup or upload, without changing environment variables.

## 2. Auto-pause (for completeness)

[DMS `autopause.md`](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/docs/misc/autopause-autostop/autopause.md):

- Auto-pause freezes the JVM with SIGSTOP. It has its own timeouts: `AUTOPAUSE_TIMEOUT_EST` 3600, `_INIT` 600, and `_KN` 120. `knockd` watches the network interface and resumes the JVM when someone connects.
- It needs `max-tick-time=-1`, plus disabling Paper's watchdog. It also needs `CAP_NET_RAW` when running rootless. While paused it writes `/data/.paused`.
- The docs no longer recommend it from 1.21.2 onward, because vanilla now pauses ticking itself when empty ([`pause-when-empty-seconds`](https://minecraft.wiki/w/Server.properties#pause-when-empty-seconds), default 60, added in 24w33a).
- **For Nether, auto-pause saves nothing.** The UpCloud VM keeps billing while the JVM is frozen. What matters is stopping and tearing down the VM.

## 3. How the Runtime can observe player count and idleness

| Signal | How | Robust across Vanilla/Paper/Fabric/Forge? | Caveats |
|---|---|---|---|
| **Server List Ping** (TCP, game port) | Status handshake that returns JSON with `players.online` and `players.max`. Run `docker exec <c> mc-monitor status --json` or `--show-player-count` ([monitor `java_status.go`](https://github.com/itzg/mc-monitor/blob/0917dd208028a47d1fff8a2c01ff9783ff771bf5/java_status.go)), or ping from the Runtime directly. | **Yes.** Every Java server type has to answer it for the client's multiplayer menu to work. The itzg healthcheck and auto-stop rely on it. | `players` is optional in the spec ([SLP](https://minecraft.wiki/w/Java_Edition_protocol/Server_List_Ping)). Servers or plugins can change the count, for example vanish plugins. `hide-online-players` (1.18+) hides only the `sample` names, not the count. Fails when `enable-status=false`. mc-monitor treats `players.max == 0` as not ready unless `--skip-readiness-check` is passed. |
| **RCON** (TCP 25575) | Run `list`. Vanilla answers with `There are %s of a max of %s players online: %s` (`commands.list.players` in [en_us.json](https://github.com/InventivetalentDev/minecraft-assets/blob/1.21.4/assets/minecraft/lang/en_us.json)). | Mostly. itzg turns RCON on by default with a random password written to `~/.rcon-cli.*` inside the container ([`start-configuration` L84-95](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/start-configuration#L84-L95), [server-properties.md, RCON](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/docs/configuration/server-properties.md)). | The output is meant for people and the [list command page](https://minecraft.wiki/w/Commands/list) doesn't define its format. Platforms or plugins may override `/list`, so parse defensively or set `RCON_PASSWORD` explicitly. RCON is also needed for `save-all` and `stop`. |
| **Query** (UDP, GS4) | `enable-query=true` (itzg: `ENABLE_QUERY`). Basic stat returns `numplayers`. Full stat returns the player list. | Vanilla-derived servers, yes. | Off by default. Responses are cached for about 5 s, challenge tokens expire every 30 s, and an invalid token gets no reply, so you can't tell an offline server from a rejected token ([Query](https://minecraft.wiki/w/Query)). Gives nothing SLP doesn't. |
| **Log parsing** (`docker logs -f`) | Vanilla `%s joined the game` and `%s left the game` (`multiplayer.player.joined/left`, same en_us.json). Also the `[Autostop]` lines. | **No.** Join and leave messages are commonly changed by Paper plugins and mods, and log formats differ between platforms. | Good enough for event hints and for spotting the `[Autostop] Stopping Java process` line. Too fragile to count players from. |
| **Container exit / Docker events** | `docker events --filter container=<c> --filter event=die` or `docker wait`, then read `State.ExitCode`. | Yes. It doesn't depend on the server type. | Exit code 0 doesn't say why the server stopped (see TL;DR). 137 means it was killed: OOM, or a stop timeout that was too short. |
| **Docker healthcheck** | `docker inspect -f '{{.State.Health.Status}}'`. The image runs `HEALTHCHECK --start-period=2m --retries=2 --interval=30s CMD mc-health` ([Dockerfile L95](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/Dockerfile#L95), [healthcheck.md](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/docs/misc/healthcheck.md)). | Yes. It's SLP underneath. | Tells you whether the server is reachable, not how many players are on. Useful for a "Ready" signal. |
| **mc-monitor exporters** | `export-for-prometheus` or `collect-otel` ([monitor README](https://github.com/itzg/mc-monitor/blob/0917dd208028a47d1fff8a2c01ff9783ff771bf5/README.md)) | Yes. It's SLP underneath. | Probably more than Nether needs. The Runtime can poll SLP itself. |

## 4. What this means for the Auto-stop design

These are inferences, not decisions.

- **Option A: let itzg auto-stop the container.** Set `ENABLE_AUTOSTOP=true` and `restart: "no"`. The Runtime watches for the container to exit and reports it to the Orchestrator. This gets the right graceful stop and save with little code. The downsides: idle policy lives in container environment variables, the timeout can't be changed without recreating the container, the exit code doesn't say why it stopped (tag it from the `[Autostop]` log line), and a hung server never stops.
- **Option B: the Runtime decides idleness itself.** It polls SLP, or `docker exec ... mc-monitor status --json`, every N seconds and keeps its own idle timer. When the timer runs out it runs `docker stop -t <STOP_DURATION+margin>`. The Runtime then knows the stop reason, can report live player counts to the Orchestrator, and can change the policy at runtime. It can also treat a ping that keeps failing as unhealthy instead of keeping the server up forever. The cost is reimplementing a small state machine.
- **Either way:**
  - Keep a hard backstop for the VM, such as a max lifetime or the Orchestrator reaping a Node that stops sending heartbeats. This covers itzg's "ping failure = 1 player" rule and hung JVMs.
  - Make sure every Docker stop timeout is longer than `STOP_DURATION` (60 s) plus `STOP_SERVER_ANNOUNCE_DELAY`.
  - Use SLP as the source for player counts. Use RCON for commands (`save-all`, `stop`), not for counting players.
  - `/data/.skip-stop` can hold a Node open during long tasks if Option A is chosen.
