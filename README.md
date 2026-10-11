# Herdr Tab Autorun

## Who it's for

Use this plugin if you want a **trusted, explicitly scoped** command or coding agent to start in the initial pane of each *new* Herdr tab in a chosen repository. `run-here` is a separate manual action for the pane selected when invoked; it is useful for trying the rule before opening another tab. Automatic runs do not occur on pane splits or restored tabs.

If you only need occasional starts, invoke a command or agent manually instead. Herdr also has [native agent automation](https://herdr.dev/docs/agent-automation/); consider that first if its workflow fits. This plugin overlaps with it but provides rules for commands as well as agents, with repository/worktree/pane-context matching; it does not claim complete equivalence with native automation.

## Requirements

- Herdr 0.9.0 or newer; Node.js 18 or newer and npm available. Herdr does not install or guarantee Node.js.
- The plugin build needs `smol-toml` and **required native** `fs-ext@2.1.1`. Building `fs-ext` requires a working node-gyp toolchain (Python, a C/C++ compiler, and platform development tools). Rebuild the native addon after switching Node versions; linking does not ensure the existing build matches Node's ABI.
- macOS is verified. Linux is listed in the manifest but unverified here. Windows is unsupported: the foreground-process readiness check needs a signal unavailable there. Store plugin state on a local filesystem supporting advisory locks, not NFS.

## Install

```sh
herdr plugin install hanbong5938/herdr-tab-autorun
```

### First success: opt in one repository

1. From the workspace you intend to use, find the **real** plugin config directory:

   ```sh
   herdr plugin config-dir han.tab-autorun
   ```

   In that directory, `rules.toml` is the file to edit. Optionally invoke the workspace action `herdr plugin action invoke han.tab-autorun.init-config` to create it from [`rules.example.toml`](rules.example.toml). The starter has `enabled = true` but **all rules are commented**, so it has no effect until you opt in. The initializer does not overwrite an existing `rules.toml` (including its rule order, bytes, or permissions); if it already exists, inspect and edit it in place rather than replacing it.

2. In a tab in your intended workspace, invoke the tab action and inspect its `context` and `decision` in the completed log:

   ```sh
   herdr plugin action invoke han.tab-autorun.doctor
   herdr plugin log list --plugin han.tab-autorun
   ```

   `doctor` reports the actual `repo_name`, `repo_root`, `cwd`, and worktree status available to matching, plus config errors and the selected rule. With no rules yet, `no_rule_match` is expected. Copy the **actual** `repo_name` from its context; do not assume the folder or project display name is the match key. If `repo_name` is absent, use an available `cwd` from that context to choose a specific `cwd_glob` instead (for example, `cwd_glob = "/absolute/path/to/your/repo"` for that exact cwd); do **not** strip away every predicate. If another repository has the same `repo_name`, add a further predicate such as a verified `repo_root`, `workspace_label`, or specific `cwd_glob`, checking it in every intended context. All predicates in one `[rules.when]` must match.

3. Review the shell command and its portability **in the new pane's actual shell**. Then edit only the starter's commented **`repo proof`** block: replace `YOUR_REPO_NAME` with the observed name, and uncomment its `[[rules]]`, `name`, `[rules.when]`, `repo_name`, `[rules.run]`, `mode`, and `command` lines. Leave the other sample blocks commented. Its harmless proof command is `echo HERDR_TAB_AUTORUN_PROOF`, which needs no external executable or agent installation and has no setup side effects. If using a `cwd_glob` because there is no `repo_name`, replace that one predicate *within the proof block* with your verified cwd scope. Avoid broad `when`-less rules. A matching proof rule can cover both ordinary and linked worktrees of the same repository; test each from its actual context. To restrict either type explicitly, add `is_linked_worktree = true` or `false` only after checking status. In an **existing** configuration, keep its rules and first-match order: a prior blanket linked-worktree `skip` will still win. Reorder or remove that skip **only if you deliberately choose** to opt linked worktrees in; do not silently change it.

   For example, the uncommented proof block looks like this after substituting the exact name reported by doctor:

   ```toml
   [[rules]]
   name = "repo proof"
   [rules.when]
   repo_name = "YOUR_ACTUAL_REPO_NAME"
   [rules.run]
   mode = "command"
   command = "echo HERDR_TAB_AUTORUN_PROOF"
   ```


4. Invoke `doctor` again in a tab whose context should match. Require `decision: action: run`, `reason: matched`, and the intended rule; inspect its command before running. Repeat in a tab from another repository and expect `no_rule_match` (or your deliberate skip). Doctor is a matching diagnostic, **not** a guarantee of shell readiness, execution, agent completion, or rate/claim availability. Focus the intended pane in the matching tab, then manually try:

   ```sh
   herdr plugin action invoke han.tab-autorun.run-here
   herdr plugin log list --plugin han.tab-autorun
   ```

   Action invoke exit 0 means dispatched, **not** completed: use the returned `log.log_id` to find its completed `succeeded` or `failed` record in the log list, and inspect the **selected pane's output** for the proof marker. Echoed command text can appear as terminal input before it executes; seeing only the typed `echo HERDR_TAB_AUTORUN_PROOF` is not proof of execution. Confirm the command's resulting marker output.

5. In the same opted-in workspace/repository, create a **fresh tab** using Herdr's usual new-tab UI (or, if you already know your workspace ID, `herdr tab create --workspace YOUR_WORKSPACE_ID --cwd /absolute/path/to/your/repo`), then inspect the plugin log and its **initial pane's resulting output**. A tab in another repository should remain unaffected. New-tab dispatch targets the initial pane, whereas `run-here` targets the selected pane. A matched automatic attempt can still be blocked by readiness, an existing agent, a once-only claim, or the automatic rate limit. Do not mistake a command echoed as input for its resulting output; do not type into or move the pane until the attempt completes. To check linked worktrees too, repeat in a new tab in that linked worktree; doctor each context rather than assuming metadata.

**Stop both manual and automatic runs:** set `enabled = false` under `[defaults]` in the same `rules.toml`. A disabled config is diagnostic, not a reason to delete state or the lock file. Review and restore `enabled = true` only when ready to resume.

## Configuration reference

Configuration uses `smol-toml`. Tables and inline tables must be plain TOML tables: TOML date/time values are not condition tables. Strings, numbers, booleans, arrays, and multiline values are supported where their keys permit them. A parse or validation error anywhere in `rules.toml` blocks the **entire invocation** rather than running an otherwise valid rule.

### Defaults

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `defaults.enabled` | boolean | `true` | Enable or disable both automatic and manual runs. |
| `defaults.ready_timeout_ms` | integer | `8000` | Maximum time to wait for the targeted pane's interactive shell. |
| `defaults.poll_interval_ms` | integer | `60` | Delay between shell-readiness checks. |
| `defaults.total_timeout_ms` | integer | `15000` | Total time budget for an invocation. |
| `defaults.rate_limit_count` | integer | `5` | Maximum automatic runs allowed in one rate-limit window. |
| `defaults.rate_limit_window_ms` | integer | `10000` | Length of the rate-limit window. |

### Rules and matching

Each `[[rules]]` block may provide a `name` and may contain `[rules.when]`; `[rules.run]` is required. Rules are evaluated in file order. **The first rule whose every `when` predicate passes wins.** An empty `when` table matches every context. A `when` key may be a string or an array of strings where noted; array values match any listed value. Unknown keys or type errors invalidate the entire invocation; the hook fails closed.

| Key | Type | Meaning |
| --- | --- | --- |
| `rules.name` | string | Human-readable rule name. |
| `rules.when.repo_name` | string or array of strings | Exact repository-name match. |
| `rules.when.repo_root` | string or array of strings | Exact repository-root match. |
| `rules.when.cwd_glob` | string | Glob against `ctx.cwd` (the focused pane cwd, falling back to the workspace cwd). Supports `*`, `**`, `?`, and a leading `~/`. |
| `rules.when.tab_label` | string | Regular expression matched against the tab label. |
| `rules.when.workspace_label` | string or array of strings | Exact workspace-label match. |
| `rules.when.invocation_source` | string or array of strings | Exact invocation-source match. |
| `rules.when.is_linked_worktree` | boolean | Exact linked-worktree status match: `true` matches only true, `false` only false. Unknown status matches neither. |

### Run modes

The selected rule's `[rules.run]` table chooses one operation:

| Key | Type | Applies to | Meaning |
| --- | --- | --- | --- |
| `rules.run.mode` | `"command"`, `"agent"`, or `"skip"` | all modes | Selects a command, agent, or explicit skip. |
| `rules.run.command` | nonempty string | command | Trusted shell command text run in the targeted pane using that pane's current shell (initial pane on automatic tab creation; selected pane for manual invocation). |
| `rules.run.kind` | string | agent | Agent kind. Supported kinds are `pi`, `claude`, `codex`, `gemini`, `cursor`, `devin`, `agy`, `cline`, `omp`, `mastracode`, `opencode`, `copilot`, `kimi`, `kiro`, `droid`, `amp`, `grok`, `hermes`, `kilo`, `qodercli`, `qwen`, `maki`, and `muse`. |
| `rules.run.name` | string | agent | Agent name prefix; defaults to `kind`, then the runtime appends a 12-hex-digit pane suffix while keeping the name at most 32 characters. |
| `rules.run.agent_args` | array of strings | agent | Arguments passed to the agent after the `--` separator. |
| `rules.run.prompt` | string | agent | Optional prompt sent after the agent starts. |

For example, a command rule can run `lazygit`:

```toml
[[rules]]
name = "backend tools"
[rules.when]
repo_name = "backend"
[rules.run]
mode = "command"
command = "lazygit"
```

### Actions

The plugin provides three actions:

- **`han.tab-autorun.doctor`** (`tab` context): Autorun doctor diagnostics for the current tab.
- **`han.tab-autorun.run-here`** (`tab` context): Run the configured autorun in the pane selected at invocation time.
- **`han.tab-autorun.init-config`** (`workspace` context): Create a starter `rules.toml` configuration.

Automatic `tab.created` runs use the new tab's initial pane; splitting a pane does not trigger autorun. Manual `run-here` uses the invocation's selected pane ID, tab, workspace, and cwd snapshot, even if focus later changes. Its pane must still exist in the original tab and workspace: missing, malformed, conflicting, closed, or moved targets fail without selecting another pane. Before an effect, the plugin checks that scope again after readiness (and before each command, agent start, or optional prompt). A move after the final check cannot be atomically excluded from the subsequent Herdr mutation; do not move the pane concurrently with the action. Manual runs bypass the automatic per-pane claim and rate limit, but still obey rules, readiness, and existing-agent protection.

Example keybinding:

```toml
[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "han.tab-autorun.run-here"
description = "autorun this tab"
```

## Behavior and safety

- The plugin hooks only `tab.created`; splitting a tab does not trigger this hook.
- Before injecting a command, a readiness heuristic waits for the pane's shell process; it does not guarantee that an interactive prompt is ready.
- In command mode, the foreground check, pane-scope recheck, and input submission are not atomic in Herdr 0.9; avoid typing, moving the pane, or launching another process before autorun completes because slow shell initialization can race.
- Agent mode relies on Herdr's `agent.start` server readiness.
- Before enabling agent mode, install and authenticate the selected agent and complete its onboarding manually. Readiness does not detect a setup UI; a configured prompt is submitted to the agent API and does not wait for model completion.
- Per-terminal/socket claim markers allow an automatic attempt only once; the manual `run-here` action bypasses this claim.
- The rate limiter uses an advisory `flock` on a persistent `rate.json.lock` file in plugin state. Do **not** delete this file: locks attach to its inode. A process crash releases its lock automatically; competing attempts wait at most 100 ms, bounded by the hook's total deadline. Failed lock acquisition fails closed.
- Store plugin state on a local filesystem that supports advisory locks; NFS is unsupported. Before upgrading from the old `wx` lock-file implementation, stop all old hooks so old and new processes cannot lock different inodes concurrently.
- Native restore/handoff does not replay `tab.created`, so restored tabs do not autorun.

## Troubleshooting

Use `herdr plugin action invoke han.tab-autorun.doctor` from the affected tab, then find its completed log with `herdr plugin log list --plugin han.tab-autorun`. Read the printed config path, errors, context, selected rule, and pane readiness before changing anything. A successful action-dispatch exit status is not proof that the plugin action finished.

| Observation | Recovery |
| --- | --- |
| `config exists: no` or no rules after initialization | Run the workspace `init-config` action or create `rules.toml` in the directory reported by `herdr plugin config-dir han.tab-autorun`. The starter is inert until a reviewed scoped rule is uncommented. |
| `no_rule_match` | Compare the rule against doctor's *actual* `repo_name`, `cwd`, worktree status and other context. Check earlier rules and test each intended worktree. A missing `repo_name` needs a verified available scope such as `cwd_glob`, not an unconditional rule. |
| `disabled` | `defaults.enabled = false` stops **both** manual and automatic effects. Enable only when ready; also inspect a matching `mode = "skip"` rule, which yields `rule_skip`. |
| `blocked` / `config_invalid` | Doctor exits 1 on any parse or validation error, even in a later rule; fix every reported error in the existing file before trying again. Missing config, no match, disabled, and explicit skip are benign diagnostics (doctor exits 0), not configuration failures. |
| `pane_busy`, readiness timeout, or no resulting output | Stop typing or starting other processes in that pane, allow its interactive shell to become idle, and try `run-here` again in the intended selected pane. The shell heuristic cannot promise prompt readiness; inspect completed logs and actual pane output. Automatic once-only claims and the rate limit may prevent a retry on the same new tab; manual runs bypass those two guards, not readiness or existing-agent protection. |
| Plugin install/build fails at `fs-ext`, or the addon fails to load after a Node switch | Install Python, a C/C++ compiler, platform development tools, and a matching Node/npm toolchain; rebuild only `fs-ext` for the Node version running the plugin. Do not replace the scoped build with blanket lifecycle scripts. |

Doctor's `has agent: unknown` means the pane ID or pane-list result could not establish the fact (for example, the pane is missing or the query failed); it does **not** mean `false`. Only a resolved pane's actual agent field supports a `true` or `false` diagnosis. Do **not** delete `rate.json.lock` to troubleshoot: locks attach to its inode, and a crashed process releases its lock automatically.

## Development and local checks

For a local checkout, install production dependencies with the same scoped build steps as the plugin manifest, then link it:

```sh
npm ci --omit=dev --ignore-scripts
npm rebuild fs-ext --ignore-scripts=false
herdr plugin link .
```

The first command disables dependency lifecycle scripts; the second builds only the required native addon. If it fails, install the node-gyp prerequisites above before linking or running the plugin. Rebuild after changing Node versions. With dependencies installed, local checks are:

```sh
npm run check
npm test
```

See [`test/README.md`](test/README.md) for test and live smoke-test guidance; these developer checks are not required for the first scoped proof.

## Marketplace publishing

To publish this plugin, use a public GitHub repository with the plugin at its root, add the `herdr-plugin` repository topic, and use the default branch. Keep `herdr-plugin.toml` at the repository root so the marketplace indexer can discover the plugin. Marketplace indexing may take about 30 minutes. See the [Herdr marketplace documentation](https://herdr.dev/docs/marketplace/).

## Security

**This plugin executes user-configured commands automatically whenever a tab is created. `rules.toml` is effectively executable configuration. Do not copy rules files from untrusted sources.** Review every command, agent kind, argument, and prompt before enabling a configuration.

## License

MIT; Copyright Han, 2026.
