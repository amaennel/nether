# Consistent live copies of a running Minecraft server

Research for [#3](https://github.com/amaennel/nether/issues/3). It feeds the "Periodic Archive during a Session" decision ([#14](https://github.com/amaennel/nether/issues/14)).

Sources were read on 2026-11-02. Source code is pinned to these commits:

- `itzg/docker-mc-backup` at [`009404b`](https://github.com/itzg/docker-mc-backup/tree/009404b2cf8b64c83e4c4be19ed7e5cbfa9d49fa)
- `itzg/docker-minecraft-server` at [`926a34b`](https://github.com/itzg/docker-minecraft-server/tree/926a34b885578c13e04babb5f64cac6fbabe920f)

## TL;DR

- **The standard approach** is `save-off`, then `save-all flush`, then copy the directory, then `save-on`. `itzg/mc-backup` does exactly this over RCON, and it is the best consistency you can get without stopping the server.
- **It is best-effort, not a guaranteed snapshot.** `save-off` stops level/chunk writes. It does *not* stop player, advancement or stat files from being written. Two confirmed, unfixed vanilla bugs (MC-3208, MC-217729) report more writes still happening while saving is off. Plugin and mod data is not covered by `save-off` at all.
- **Gameplay is not paused while saves are off.** Only `save-all flush` freezes the server, and only briefly. While saves are off, world changes queue in memory. A crash or SIGKILL during that window loses them, and the on-disk state is left as of the flush.
- **Keep the save-off window short.** Make it cover only a fast local copy, then turn `save-on` back on before compressing and uploading. itzg's `rclone` method keeps saves off for the whole tar, compression *and* upload, which is the behaviour to avoid.
- **The Archive at Session end needs none of this.** Stopping the server (SIGTERM, which mc-server-runner turns into `stop`) does a full save. Tarring the directory after the process exits gives a fully consistent copy.

## 1. The `save-off` / `save-all` / `save-on` commands (vanilla Java)

From the [Minecraft Wiki, Commands/save](https://minecraft.wiki/w/Commands/save). All three commands are Java Edition only, dedicated-server only, and need permission level 4.

| Command | Behaviour (wiki wording) |
|---|---|
| `save-all` | "Saves player data immediately. Marks all chunks as needing to be saved." Chunks are then written over time. This works "when auto-saving has been disabled using the save-off command." |
| `save-all flush` | "All the players and chunks are saved to the data storage device immediately, freezing the server for a short time." |
| `save-off` | "Disables the server writing to the level files (except player, advancement, stat files), in order to copy them for backup. All level changes are temporarily queued. This option is reset each time the server restarts." It fails if saving is already off. |
| `save-on` | "Enables the server writing to the level files." It fails if saving is not off. |

Implications:

- **Use `save-all flush`, not plain `save-all`.** Plain `save-all` only *marks* chunks as dirty, so a copy taken right after it can miss them. The `flush` form writes them synchronously.
- **`save-off` is reset on restart.** If the server restarts mid-backup, saving comes back on by itself.
- **Both commands fail when the state is already set.** A controller should therefore treat "already off/on" as success, or force a known state first. itzg does the latter: it sends `save-on` as its readiness probe before `save-off` (see §3).

### Known gaps in `save-off` (Mojira)

- **[MC-3208](https://mojira.dev/MC-3208)** (Confirmed, Reopened, no fix version, affects up to at least 23w05a): with `save-off`, the server still saves player inventories and positions, ender chests, world edits and chest contents, notably on `/stop`. Commenters point out the practical effect: player files and region files fall out of sync in a backup, which can cause item loss or duplication on restore.
- **[MC-217729](https://mojira.dev/MC-217729)** (Confirmed, Open, affects 1.16.5 to 23w05a): "save-off does not disable periodical autosaving". The reporter saw `level.dat`'s mtime keep updating every 5 minutes after `save-off`.
- **[MC-78635](https://mojira.dev/MC-78635)** (fixed in 15w46a): stopping after `save-off` used to discard the outstanding changes. Today `stop` saves despite `save-off`.

(The links point to mojira.dev, a public mirror of bugs.mojang.com, because the official tracker renders client-side and could not be fetched.)

**Bottom line:** `save-off` shrinks the set of files that change during a copy, but it does not reduce it to zero.

## 2. Files involved, and how a torn copy could look

From the [Java Edition level format](https://minecraft.wiki/w/Java_Edition_level_format) and [Region file format](https://minecraft.wiki/w/Region_file_format) wiki pages:

- **Region files (`.mca`)** are made of 4 KiB sectors.
  - A two-sector header holds a location table (offset and size per chunk) and a timestamp table.
  - Each chunk is length-prefixed and compressed.
  - Chunks larger than 1020 KiB spill into a separate `c.x.z.mcc` file.
  - A rewritten chunk can move to new sectors, or be appended at the end of the file.
  - So a copy taken while a region file is being written can contain a header that points at sectors that don't hold that data yet (or vice versa). The result is corrupt or regenerated chunks.
  - Entities (`entities/`) and POI (`poi/`) use the same region container.
- **`level.dat`** is global world state (time, seed, generator, and so on). `level.dat_old` is a copy of the previous `level.dat`, made when the world loads.
- **Player data** (`playerdata/`, `advancements/`, `stats/`, which moved under `players/` in 26.1 snapshots) is explicitly *not* covered by `save-off`.
- **The directory layout changes between versions.** For example, dimensions moved under `dimensions/` in current versions. Since the Archive is the *whole* server directory, Nether should not hard-code world-internal paths.
- **`session.lock`** ([level format](https://minecraft.wiki/w/Java_Edition_level_format)): since 1.16 it holds a single `☃` (U+2603). The server takes a lock on it and aborts if it can't. On Linux this is an advisory lock (Java `FileChannel` lock), so it does **not** stop other processes from reading files. tar can read the whole world while the server runs. The only thing it blocks is a *second server* opening the same world. Copying `session.lock` into the Archive is harmless.
- **No mandatory file locks:** nothing in the sources suggests the server holds mandatory locks that would block reading on Linux.

## 3. How `itzg/mc-backup` does it

The source is [`scripts/opt/backup-loop.sh`](https://github.com/itzg/docker-mc-backup/blob/009404b2cf8b64c83e4c4be19ed7e5cbfa9d49fa/scripts/opt/backup-loop.sh), and the order is also described in the [README "Backup scripts" section](https://github.com/itzg/docker-mc-backup/blob/009404b2cf8b64c83e4c4be19ed7e5cbfa9d49fa/README.md#backup-scripts).

**Steps of `do_backup`** ([L676-L715](https://github.com/itzg/docker-mc-backup/blob/009404b2cf8b64c83e4c4be19ed7e5cbfa9d49fa/scripts/opt/backup-loop.sh#L676-L715)):

1. **Readiness probe:** `rcon-cli save-on`, with retries (default 5 x 10s). This also puts the server into a known "saving on" state.
2. `PRE_SAVE_ALL_SCRIPT` runs.
3. `rcon-cli save-off`. If this fails, the backup aborts with "Is the server running?"
4. **Safety trap:** `trap 'retry 5 5s rcon-cli save-on' EXIT`, so saving comes back on even if the script crashes.
5. `rcon-cli save-all flush` (`ENABLE_SAVE_ALL`, default true), then OS `sync` (`ENABLE_SYNC`, default true).
6. `PRE_BACKUP_SCRIPT` runs, then the backup method runs (tar, rsync, restic or rclone).
7. `PRE_SAVE_ON_SCRIPT` runs, then `rcon-cli save-on`, and the trap is removed.
8. `POST_BACKUP_SCRIPT` runs.

**Other details:**

- **Concurrency:** `flock` on `$DEST_DIR/.mc-backup-lock` stops scheduled and "backup now" runs from overlapping ([L812-L822](https://github.com/itzg/docker-mc-backup/blob/009404b2cf8b64c83e4c4be19ed7e5cbfa9d49fa/scripts/opt/backup-loop.sh#L812-L822)).
- **Changed-file tolerance:** a tar exit code of 1 ("file changed as we read it") is logged as a warning ("Dat files changed as we read it"), not treated as a failure ([L357-L360](https://github.com/itzg/docker-mc-backup/blob/009404b2cf8b64c83e4c4be19ed7e5cbfa9d49fa/scripts/opt/backup-loop.sh#L357-L360)). This acknowledges that player and other files keep changing under `save-off`.
- **Default excludes:** `EXCLUDES=*.jar,cache,logs,*.tmp` ([L41](https://github.com/itzg/docker-mc-backup/blob/009404b2cf8b64c83e4c4be19ed7e5cbfa9d49fa/scripts/opt/backup-loop.sh#L41)).
- **Autopaused server:** if `/data/.paused` exists, the backup skips RCON entirely and just copies ([L825-L841](https://github.com/itzg/docker-mc-backup/blob/009404b2cf8b64c83e4c4be19ed7e5cbfa9d49fa/scripts/opt/backup-loop.sh#L825-L841)).
  - The server image's [`scripts/auto/pause.sh`](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/auto/pause.sh) runs `rcon-cli save-all` (no `flush`), waits for connections to drain, then `pkill -STOP java` and touches `/data/.paused`.
  - A SIGSTOPed JVM writes nothing, so a copy taken then is consistent with whatever had reached disk.
- **Skipping idle backups:** `PAUSE_IF_NO_PLAYERS` uses `mc-monitor` to skip backups while nobody is online.
- **The `rclone` method keeps saves off during the upload** ([L641-L664](https://github.com/itzg/docker-mc-backup/blob/009404b2cf8b64c83e4c4be19ed7e5cbfa9d49fa/scripts/opt/backup-loop.sh#L641-L664)). It tars and compresses to a local file, then runs `rclone copy` to the remote, all inside the `backup` step. That step sits between `save-off` and `save-on`, so the save-off window covers compression *and* network upload. The `tar` method only covers local compression.

## 4. Plugin and mod data outside the world

- `save-off` / `save-all` act on the level and on player data only (§1). Nothing in vanilla, or in Paper's documented configuration, makes plugins or mods pause their own writes.
  - The [Paper world config](https://docs.papermc.io/paper/reference/world-configuration/) offers `chunks.auto-save-interval`, `chunks.max-auto-save-chunks-per-tick` and `chunks.flush-regions-on-save`.
  - The [Paper global config](https://docs.papermc.io/paper/reference/global-configuration/) offers `player-auto-save.rate` / `max-per-tick`.
  - None of these mention `save-off` or plugin data.
- **Plugin data under `plugins/` is written on each plugin's own schedule.**
  - Flat-file YAML/JSON can be torn mid-write, though usually it is small and rewritten whole.
  - Embedded databases (SQLite/H2, used for example by many logging and permissions plugins) can be inconsistent if their files are copied while open with uncheckpointed journals or WAL. (This is general SQLite/H2 behaviour, not covered by a Minecraft source.)
- **Mods (Forge/Fabric) keep their own saved data.** Usually it lives inside the world (`data/`), and then it follows the level's `save-off` behaviour. Mods that write elsewhere are not covered.
- **Practical mitigation:** accept best-effort for these files in periodic Archives, and rely on the Session-end Archive (taken after a clean stop) as the authoritative copy.

## 5. Cost of pausing saves for a tarball and upload

- **Gameplay keeps running** while saves are off. Players notice nothing, except a short freeze during `save-all flush` (wiki: "freezing the server for a short time"). The freeze scales with the number of dirty chunks.
- **Risk window:** while saves are off, level changes exist only in memory ("temporarily queued").
  - A clean `stop` still saves them (MC-78635 fix, MC-3208).
  - A crash, OOM kill, SIGKILL or VM loss loses everything since the flush.
  - On ephemeral VMs, losing the VM is exactly the failure that periodic Archives guard against, and in that case the on-disk state is gone anyway. The real cost of a long window is that a *crashed-but-recoverable* server would restart from the flush point.
- **Memory:** queued changes are held in memory for the length of the window. A long window with many players exploring new chunks grows memory use, and the next `save-on` autosave has more to write.
- **Recommended shape:** keep the save-off window to a fast *local* copy only.
  1. `save-off`
  2. `save-all flush`
  3. `sync`
  4. Copy the server dir to local staging (`cp -a` / `rsync`, or a filesystem snapshot if available), uncompressed
  5. `save-on`
  6. Compress and upload from staging, with saves back on

  This needs extra free disk roughly equal to the server directory size. If disk is tight, streaming `tar | zstd` to a local file inside the window is the next best option (this is itzg's `tar` method). Streaming straight to S3 inside the window ties the window to network speed, which is the itzg `rclone` behaviour to avoid.
- **Bookkeeping for the Runtime:**
  - Always pair `save-off` with a guaranteed `save-on`, as itzg does with its EXIT trap.
  - Probe with `save-on` first so the state is known.
  - Treat tar's "file changed as we read it" as a warning.
  - Serialise Archive runs (itzg uses `flock`).

## 6. Session-end Archive

- On container stop, mc-server-runner sends `stop` via RCON or the console and waits for the process to exit, up to `STOP_DURATION`, default 60s ([misc-options docs](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/docs/configuration/misc-options.md); [`start-finalExec`](https://github.com/itzg/docker-minecraft-server/blob/926a34b885578c13e04babb5f64cac6fbabe920f/scripts/start-finalExec#L214) passes `--stop-duration`).
- `stop` saves everything (MC-3208 / MC-78635), so a tar taken after the container exits is fully consistent, including plugin files written at plugin disable.
- That makes it the only Archive with a strong consistency guarantee.

## Open questions / not verified

- **Whether vanilla or Paper currently writes chunks on *unload* while `save-off` is set** was not verified against source. MC-3208 and MC-217729 suggest some writes do happen. Treat a periodic Archive as possibly containing a small number of inconsistent region files or player files.
- **Whether the RCON reply to `save-all flush` arrives only after the flush has finished** is assumed, not verified: RCON commands run on the server thread, and itzg relies on this ordering. Nether's Runtime should still `sync` afterwards, as itzg does.
