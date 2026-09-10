# Live integration harness

`harness.mjs` is a manual integration harness, not a unit-test framework. Run it with Node 18 or newer against an already-running **isolated** Herdr server:

```sh
ROOT=/tmp/herdr-autorun-check-XXXX
mkdir -p "$ROOT/home" "$ROOT/config" "$ROOT/data"

# Start the disposable Herdr server with these same environment variables.
export HERDR_AUTORUN_TEST_ROOT="$ROOT"
export HERDR_SOCKET_PATH="$ROOT/herdr.sock"
export HERDR_CONFIG_PATH="$ROOT/config.toml"
export HOME="$ROOT/home"
export XDG_CONFIG_HOME="$ROOT/config"
export XDG_DATA_HOME="$ROOT/data"

node test/harness.mjs
```

Replace `ROOT` with a real, unique temporary directory (for example, a directory made by `mktemp -d /tmp/herdr-autorun-check-XXXXXX`). If Herdr is not on `PATH`, set `HERDR_BIN_PATH` to its executable. The harness refuses to run without `HERDR_SOCKET_PATH` and `HERDR_AUTORUN_TEST_ROOT`, and rejects paths outside the disposable root; this prevents accidental use of a normal user session or plugin registry.

The harness first checks `herdr status`, links the checkout as `han.tab-autorun`, and temporarily replaces that isolated plugin's `rules.toml`. It creates five fixture directories and only unfocused tabs (`--no-focus`) in the isolated server. The cases cover command matching, no-match and explicit skip decisions, the absence of a `pane.created` autorun after a split, and duplicate hook claims. Command cases write a marker file in the fixture and also expose its contents in the pane, so a typed-but-not-executed command cannot pass by itself.

On every exit path, including a failed case, it closes tabs created by the harness, unlinks `han.tab-autorun`, restores the prior `rules.toml` (or removes it if none existed), and removes only its child temporary directory. The isolated server's HOME/XDG directories and any server process are owned by the caller and can be removed after the run.

## Manual restore/restart check

A restart/session-restore check is intentionally not automated: restarting a server can affect unrelated tabs and session state. Use a disposable scratch named session, not your normal session:

1. Start or select the scratch session with the `herdr --session autorun-probe` command prefix, link the checkout, and install a rule whose command writes a distinctive marker file in a scratch fixture.
2. Create one scratch tab with that prefix and record its tab ID, root pane ID, marker file, and the plugin-log count. Confirm the command ran once.
3. Restart the scratch server using the normal server restart procedure with the same `herdr --session autorun-probe` session. Allow session restore to finish.
4. Check the restored tab and plugin log. The old tab must not receive a new `tab.created` autorun and the marker/log count must not increase because restore emits no lifecycle hook.
5. Create a fresh scratch tab with the same prefix. It must autorun once, proving that native restore suppression did not disable genuine new-tab events.
6. Unlink the plugin and stop/remove the `autorun-probe` scratch session when finished.
