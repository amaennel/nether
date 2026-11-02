# Nether

Nether orchestrates game servers that run on ephemeral cloud machines, keeping them stored when not running and live only while in use.

## Language

**Orchestrator**:
The long-lived control plane that owns all state and exposes the REST API.
_Avoid_: controller, master, backend

**Node**:
One ephemeral cloud VM that hosts at most one Game Server at a time. It can outlive a Session by being Parked.
_Avoid_: server, machine, instance, host

**Parked**:
The state of a Node whose Session has ended cleanly but which is kept, already paid for, so that a later Session can reuse it instead of a fresh Node.
_Avoid_: warm, idle, standby, pooled

**Runtime**:
The agent process on a Node that reports to the Orchestrator and drives the game container.
_Avoid_: agent, daemon, worker

**Game Server**:
The persistent thing a customer owns: its configuration and its full server directory. It exists whether or not it is running.
_Avoid_: server, world, instance

**Session**:
One continuous period during which a Game Server is live on a Node, from start to stop.
_Avoid_: run, instance, deployment

**Archive**:
The stored copy of a Game Server's entire server directory (world, configs, plugins, user-set files) while it is not running.
_Avoid_: backup, snapshot, world save

**Console**:
Live access to a running Game Server's log output and command input.
_Avoid_: terminal, shell, RCON

**Auto-stop**:
Ending a Session automatically once the Game Server has been idle for a configured time.
_Avoid_: autopause, idle shutdown

**Owner reference**:
An opaque identifier the API caller attaches to a Game Server to map it to its own customers; Nether never interprets it.
_Avoid_: user, account, tenant

## Flagged ambiguities

- "server" alone is banned: say **Node** (the VM) or **Game Server** (the persistent game).
