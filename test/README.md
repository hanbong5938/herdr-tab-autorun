# Live integration harness

`harness.mjs` is a manual integration harness, not a unit-test framework. Run it with Node 18 or newer against an already-running **isolated** Herdr server. Start that server with the same exported environment used by the harness:

```sh
ROOT=$(mktemp -d /tmp/herdr-autorun-check-XXXXXX)
mkdir -p "$ROOT/home" "$ROOT/config" "$ROOT/data"
export HERDR_AUTORUN_TEST_ROOT="$ROOT"
export HERDR_SOCKET_PATH="$ROOT/herdr.sock"
export HERDR_CONFIG_PATH="$ROOT/config.toml"
export HOME="$ROOT/home"
export XDG_CONFIG_HOME="$ROOT/config"
export XDG_DATA_HOME="$ROOT/data"

node test/harness.mjs
```

The harness requires an existing disposable directory strictly below the real `os.tmpdir()` or `/tmp` (including macOS `/tmp` → `/private/tmp` aliases). If Herdr is not on `PATH`, set `HERDR_BIN_PATH` to its executable. It refuses to run without `HERDR_SOCKET_PATH` and `HERDR_AUTORUN_TEST_ROOT`, or if isolated state paths escape the disposable root; missing socket/config files are permitted. A regular file where a path needs a directory is refused.

Use the same Node version in the server's `PATH` and for the harness. Install the checkout's dependencies as described in the root README, and rebuild only `fs-ext` with `npm rebuild fs-ext --ignore-scripts=false` under that Node version before starting the server. Rebuild when switching Node versions: linking the plugin does not guarantee that an existing native addon matches the runtime ABI.

After checking `herdr status`, the harness snapshots any previously selected pane (an empty server is supported), creates its own uniquely labeled workspace, links the checkout as `han.tab-autorun`, and temporarily replaces that isolated plugin's `rules.toml`. It creates disposable fixture directories and tabs only in its owned workspace; no preexisting workspace is used as a test target or closed. Five automatic cases retain command matching, no-match and explicit skip decisions, no `pane.created` autorun after a split, and duplicate hook claims. The first additional case starts with fresh isolated state and a one-slot, long-window automatic rate limit: a successful automatic attempt consumes its pane claim and the rate slot; a competing new tab records `rate_limited` and no effect. A different append-only manual command invoked twice in the **original same** pane must produce exactly two file lines and no output in the competing pane. The default generous-rate fixture is restored afterward.

Ownership is recorded from each creation response's `terminal_id`, checked against the pre-operation inventory: the workspace's initial root, every new tab root, the manual secondary split, and the automatic split fixture. A new pane ID or membership in a created tab/workspace is not ownership. A trustworthy returned terminal identity is retained before visibility confirmation, so a later failed query does not erase it.

Manual cases invoke the real `herdr plugin action invoke han.tab-autorun.run-here` command without pane/tab flags. They temporarily focus only owned workspace/tab/panes, scrub inherited caller IDs, verify returned context workspace/tab/focused-pane IDs, and poll the returned `log.log_id` through `herdr plugin log list` until `succeeded` or `failed`. CLI exit status 0 only proves dispatch, not completion. Unique marker files **and** selected-pane output prove execution, while the other pane must show no effect. Root and secondary panes with different cwd rules, a same-ID layout swap, an observed non-shell foreground held through readiness timeout, and a uniquely sourced `report-agent` guard are covered. The latter checks the reported `pane.agent` field and releases only that fixture's source; it does not claim a real authenticated agent was launched. Missing/conflicting/moved target boundaries are covered by action behavior tests, not CLI flags. Direct hook invocation for the automatic duplicate test inherits the isolated server's full environment, including PATH, HOME, XDG directories, and socket.

Every pane-output assertion, including marker absence in another pane, requires a successful `pane read`; a failed read fails the case rather than proving absence. The busy case requires valid positive integer shell PID and foreground PGID values that differ, both before invocation and after the readiness timeout. Missing or malformed process information is unknown, not evidence of a busy foreground.

Cleanup releases only its uniquely sourced report-agent fixture, resolving the terminal's current pane, and restores the original terminal's current focus before teardown. It closes only registered terminal panes still in the harness workspace, refreshing identity and scope immediately before each `pane close` and confirming terminal disappearance. It never explicitly closes a tab or workspace. Herdr's automatic removal after the final pane closes is confirmed through a successful workspace list; a `pane_not_found` close is accepted only when a successful inventory confirms that terminal is gone. Other close errors remain failures.

Foreign terminals in tracked or untracked tabs, owned terminals moved to another workspace, ambiguous/unavailable inventory, unproven creation provenance, or a workspace that remains present cause incomplete cleanup and exit status 1. These resources and the fixture directory are retained, with identifying details and the directory path printed. Do not remove a retained directory while surviving terminals might use its cwd or files. The original terminal is restored again after pane cleanup; a closed original is never replaced with an unrelated pane. Plugin unlink and prior rules restoration run independently even after cleanup errors. The caller still owns the isolated server and its HOME/XDG directories.

The CLI closes by pane ID, without an expected-terminal compare-and-close operation. Rechecking limits but cannot atomically exclude a move or replacement between the final lookup and close. Avoid concurrent pane mutations during teardown; the harness does not claim race-free protection against arbitrary concurrent changes.

Verified on macOS: Herdr 0.9.0 with Node 18.20.8 passed all nine live cases on a fresh empty server; Herdr 0.9.3 with Node 26.10.0 passed all nine both on an empty server and with existing caller focus. Normal runs exited 0 with no harness-owned panes, workspace, fixture directory, or linked plugin remaining; the existing caller terminal and workspace were preserved. Project checks and all 50 registered tests passed on both Node versions. The agent-protection case uses reported metadata, not an authenticated coding-agent process; Linux remains unverified.

Additional Herdr 0.9.3 runs moved the original caller terminal into a new untracked tab and, separately, into a tracked split tab inside the harness workspace. Both passed all nine functional cases but correctly exited 1 for retained resources: the caller terminal survived at its new pane ID, was finally focused, and its other workspace survived. Moving a harness-owned terminal into a caller workspace likewise passed all nine cases, retained that terminal and its fixture directory, preserved original focus, and exited 1.

A controlled creation-response probe removed `terminal_id` from one real tab-create response. The affected case failed, the remaining eight passed, and the harness exited 1 while preserving the unclassified native terminal and its fixture directory. Plugin unlink still completed, and prior rules bytes and permissions were restored. Unit regressions additionally cover failed visibility confirmation, ambiguous inventory, read errors, missing PGID, and closed-original focus without fallback.

## Manual restore/restart check

A restart/session-restore check is intentionally not automated: restarting a server can affect unrelated tabs and session state. Use a disposable scratch named session, not your normal session:

1. Start or select the scratch session with the `herdr --session autorun-probe` command prefix, link the checkout, and install a rule whose command writes a distinctive marker file in a scratch fixture.
2. Create one scratch tab with that prefix and record its tab ID, root pane ID, marker file, and the plugin-log count. Confirm the command ran once.
3. Restart the scratch server using the normal server restart procedure with the same `herdr --session autorun-probe` session. Allow session restore to finish.
4. Check the restored tab and plugin log. The old tab must not receive a new `tab.created` autorun and the marker/log count must not increase because restore emits no lifecycle hook.
5. Create a fresh scratch tab with the same prefix. It must autorun once, proving that native restore suppression did not disable genuine new-tab events.
6. Unlink the plugin and stop/remove the `autorun-probe` scratch session when finished.
