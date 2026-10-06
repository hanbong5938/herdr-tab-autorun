# Herdr Tab Autorun

## What it does

Herdr Tab Autorun runs a configured command or starts a configured coding agent automatically when Herdr creates a new tab. Automatic runs target that tab's initial pane. The manual `run-here` action instead targets the pane selected when the action is invoked. Rules can match the repository, workspace, tab label, invocation source, worktree, or pane working directory.

## Requirements

- Herdr 0.9.0 or newer for the existing plugin features.
- Node.js 18 or newer, with npm available (Herdr does not install or guarantee Node.js for you).
- Runtime dependencies `smol-toml` and **required native** `fs-ext@2.1.1`. Building `fs-ext` requires a working node-gyp toolchain, including Python and a C/C++ compiler with the platform's development tools. Install these on the machine running the plugin build.
- macOS is the verified runtime platform; Linux is listed in the manifest but remains unverified here. Windows is unsupported because it does not provide a usable foreground-process signal for the readiness check.

## Install

Install from a plugin source with:

```sh
herdr plugin install hanbong5938/herdr-tab-autorun
```

For local development, install production dependencies with the same scoped build steps as the plugin manifest, then link the checkout:

```sh
npm ci --omit=dev --ignore-scripts
npm rebuild fs-ext --ignore-scripts=false
herdr plugin link .
```

The first step disables dependency lifecycle scripts; the second builds only the required native addon. Do not replace these with a blanket scripts-enabled install. If the native rebuild fails, install the node-gyp prerequisites above before linking or running the plugin.

### Local verification

After the dependency installation above, run the local checks:

```sh
npm run check
npm test
```

See [`test/README.md`](test/README.md) for the test and smoke-test notes.

## Configuration

Find the plugin configuration directory with:

```sh
herdr plugin config-dir han.tab-autorun
```

Create a file named `rules.toml` in that directory. A commented starting point is provided in [`rules.example.toml`](rules.example.toml).

### Key reference

Configuration uses `smol-toml`. Tables and inline tables must be plain TOML tables: TOML date/time values are not condition tables. Strings, numbers, booleans, arrays, and multiline values are supported where their keys permit them. A parse or validation error anywhere in `rules.toml` blocks the **entire invocation** rather than running an otherwise valid rule.

#### Defaults

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `defaults.enabled` | boolean | `true` | Enable or disable automatic runs by default. |
| `defaults.ready_timeout_ms` | integer | `8000` | Maximum time to wait for the new pane's interactive shell. |
| `defaults.poll_interval_ms` | integer | `60` | Delay between shell-readiness checks. |
| `defaults.total_timeout_ms` | integer | `15000` | Total time budget for the autorun hook. |
| `defaults.rate_limit_count` | integer | `5` | Maximum automatic runs allowed in one rate-limit window. |
| `defaults.rate_limit_window_ms` | integer | `10000` | Length of the rate-limit window. |

#### Rules and matching

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

#### Run modes

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

Inspect captured hook output with:

```sh
herdr plugin log list --plugin han.tab-autorun
```

You can also run the **Autorun doctor** action from a tab to inspect the autorun setup for that tab. A reported `has agent: unknown` means the pane ID or pane-list result could not establish the fact (for example, the pane is missing or the query failed); it does **not** mean `false`. Only a resolved pane's actual agent field supports a `true` or `false` diagnosis.

## Marketplace publishing

To publish this plugin, use a public GitHub repository with the plugin at its root, add the `herdr-plugin` repository topic, and use the default branch. Keep `herdr-plugin.toml` at the repository root so the marketplace indexer can discover the plugin. Marketplace indexing may take about 30 minutes. See the [Herdr marketplace documentation](https://herdr.dev/docs/marketplace/).

## Security

**This plugin executes user-configured commands automatically whenever a tab is created. `rules.toml` is effectively executable configuration. Do not copy rules files from untrusted sources.** Review every command, agent kind, argument, and prompt before enabling a configuration.

## License

MIT; Copyright Han, 2026.
