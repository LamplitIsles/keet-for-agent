# Archived DSH Keet memory watcher

This document and the adjacent files in `scripts/` contain the versioned source
for the existing optional user service `dsh-keet-memory-watch.service`. It is an archive of diagnostic
support, not an installation or deployment mechanism. Adding these files does
not start, stop, restart, or reconfigure a systemd service.

The watcher polls one exact DSH bridge sidecar's proportional set size (PSS)
from `/proc/<pid>/smaps_rollup`. At the configured threshold it writes an alert
to the user journal, asks the bridge's local Unix socket for a structural heap
summary, logs that summary, and exits. `Restart=no` deliberately preserves the
currently deployed one-capture behavior.

It uses `pgrep`, `awk`, `nc` with Unix-socket support, `jq`, `logger`, and
`wall`. The watcher sends terminal-wide `wall` notices when it alerts.

## Scope

The watcher matches one command-line pattern and one socket. It was written for
the DSH bridge worker, not for the private Impri approval channel. It therefore
does not observe the currently running `impri-keet.service` worker, and must
not be enabled for it unless that service is separately given a compatible
heap-profile socket.

The socket response contains only bounded structural totals (`nodeCount`,
`selfSizeBytes`, and node-type aggregates). The complete V8 heap snapshot is
written to a private temporary directory, summarized locally, and removed by
the bridge before the watcher receives a response.

## Configuration snapshot

The tracked unit loads an optional private environment file at
`~/.config/dsh-keet/memory-watch.env`. Its local, untracked content must define
the target rather than putting host paths or identity locations in Git:

```sh
# MiB; defaults to 700 when omitted.
KEET_MEMORY_THRESHOLD_MIB=700

# Regex consumed by `pgrep -f`; match the exact DSH bridge worker only.
KEET_MEMORY_WORKER_PATTERN='^/absolute/dsh-home/runtimes/keet/4.21.0-linux-x64/bare /absolute/dsh-home/runtimes/keet/4.21.0-linux-x64/core-worker\.bundle /absolute/workspace/\.dsh/dsh-keet/identity'

# Created by a running DSH bridge with this diagnostic branch installed.
KEET_MEMORY_PROFILE_SOCKET=/absolute/dsh-home/run/dsh-keet-heap.sock
```

If an operator chooses to install this archived definition, they must copy the
script to `~/.local/bin/dsh-keet-memory-watch` with mode `0755`, install the
unit under `~/.config/systemd/user/`, create the private environment file with
mode `0600`, then use normal `systemctl --user` lifecycle commands. Do not add
that private configuration, runtime, identity directory, or journal output to
this repository.

## Inspecting an existing installation

```sh
systemctl --user status dsh-keet-memory-watch.service --no-pager
journalctl --user -u dsh-keet-memory-watch.service --no-pager
```

These commands report the watcher itself. To see whether it currently has a
DSH Keet worker to observe, inspect the matching worker and DSH service
separately; an active watcher can legitimately have no target.
