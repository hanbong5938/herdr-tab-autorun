import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, normalizeConfig, matchRule } from "./config.mjs";
import {
  log,
  claimTab,
  rateLimit,
  waitForShellPrompt,
  runCommand,
  startAgent,
  sendPrompt,
  paneHasAgent,
  paneList,
} from "./herdr.mjs";

function parseJsonObject(value) {
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function buildContext(env = {}) {
  const source = env && typeof env === "object" ? env : {};
  const context = parseJsonObject(source.HERDR_PLUGIN_CONTEXT_JSON);
  const event = parseJsonObject(source.HERDR_PLUGIN_EVENT_JSON);
  const eventTab =
    event.data && typeof event.data === "object" && !Array.isArray(event.data) &&
    event.data.tab && typeof event.data.tab === "object" && !Array.isArray(event.data.tab)
      ? event.data.tab
      : {};
  const worktree =
    context.worktree &&
    typeof context.worktree === "object" &&
    !Array.isArray(context.worktree)
      ? context.worktree
      : {};

  const workspaceCwd = context.workspace_cwd;
  const focusedPaneCwd = context.focused_pane_cwd;

  return {
    workspace_id:
      context.workspace_id ?? source.HERDR_WORKSPACE_ID ?? eventTab.workspace_id,
    workspace_label: context.workspace_label,
    workspace_cwd: workspaceCwd,
    tab_id: context.tab_id ?? source.HERDR_TAB_ID ?? eventTab.tab_id,
    tab_label: context.tab_label ?? eventTab.label,
    pane_id: source.HERDR_PANE_ID ?? context.focused_pane_id,
    focused_pane_cwd: focusedPaneCwd,
    cwd: focusedPaneCwd || workspaceCwd,
    repo_name: worktree.repo_name,
    repo_root: worktree.repo_root,
    is_linked_worktree: worktree.is_linked_worktree,
    invocation_source: context.invocation_source,
    event: source.HERDR_PLUGIN_EVENT ?? event.event,
    raw_context: context,
    raw_event: event,
  };
}

export function decide(ctx, normalized) {
  if (!normalized.defaults.enabled) {
    return { action: "skip", reason: "disabled" };
  }

  const matched = matchRule(normalized.rules, ctx);
  if (!matched) {
    return { action: "skip", reason: "no_rule_match" };
  }

  const { rule, index } = matched;
  if (rule.run.mode === "skip") {
    return { action: "skip", reason: "rule_skip", rule, index };
  }

  return { action: "run", reason: "matched", rule, index };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function safeLog(level, message, extra) {
  try {
    log(level, message, extra);
  } catch {
    // Logging must not turn a non-fatal hook failure into an exception.
  }
}

function logSkip(reason, ctx, level = "info", extra = {}) {
  safeLog(level, "skip", { ...extra, reason, tab_id: ctx.tab_id });
}

function remainingBudget(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

function remainingAgentTimeout(deadlineAt) {
  return Math.min(300000, remainingBudget(deadlineAt));
}

function supportedEvent(env, ctx) {
  const hookEvent =
    env && typeof env.HERDR_PLUGIN_EVENT === "string"
      ? env.HERDR_PLUGIN_EVENT
      : "";
  const rawEvent =
    ctx.raw_event &&
    typeof ctx.raw_event === "object" &&
    typeof ctx.raw_event.event === "string"
      ? ctx.raw_event.event
      : "";
  const event = hookEvent || rawEvent || ctx.event;
  return event === "tab.created" || event === "tab_created";
}

function configErrors(loaded, normalized) {
  return [
    ...(Array.isArray(loaded.errors) ? loaded.errors : []),
    ...(Array.isArray(normalized.errors) ? normalized.errors : []),
  ];
}

function findPane(panes, requestedPaneId, tabId) {
  if (!Array.isArray(panes)) {
    return null;
  }

  const candidate = requestedPaneId
    ? panes.find((pane) => pane && pane.pane_id === requestedPaneId)
    : panes.find((pane) => pane && pane.tab_id === tabId);
  if (!candidate || !candidate.pane_id) {
    return null;
  }

  return panes.find((pane) => pane && pane.pane_id === candidate.pane_id) || null;
}

function runHook() {
  const startedAt = Date.now();

  try {
    const ctx = buildContext(process.env);
    const loaded = loadConfig(process.env.HERDR_PLUGIN_CONFIG_DIR);
    const normalized = normalizeConfig(loaded.config);

    const errors = configErrors(loaded, normalized);
    for (const error of errors) {
      safeLog("warn", "config_error", { error });
    }

    const defaults = normalized.defaults;
    const deadlineAt = startedAt + defaults.total_timeout_ms;

    if (errors.length > 0) {
      safeLog("error", "config_invalid", {
        reason: "config_error",
        errors,
      });
      return 1;
    }

    if (!supportedEvent(process.env, ctx)) {
      logSkip("invalid_event", ctx, "warn");
      return 0;
    }


    const decision = decide(ctx, normalized);
    if (decision.action === "skip") {
      logSkip(decision.reason, ctx);
      return 0;
    }

    if (!ctx.tab_id) {
      logSkip("no_tab", ctx, "warn");
      return 0;
    }
    const requestedPaneId = process.env.HERDR_PANE_ID || ctx.pane_id;
    const pane = findPane(
      paneList(undefined, {
        deadlineAt,
        timeoutMs: remainingBudget(deadlineAt),
      }),
      requestedPaneId,
      ctx.tab_id,
    );
    if (!pane) {
      logSkip("no_pane", ctx, "warn");
      return 0;
    }
    if (pane.tab_id !== ctx.tab_id) {
      safeLog("error", "pane_mismatch", {
        reason: "pane_tab_mismatch",
        tab_id: ctx.tab_id,
        pane_id: pane.pane_id,
        pane_tab_id: pane.tab_id,
      });
      return 1;
    }

    const paneId = pane.pane_id;
    const terminalId = pane.terminal_id;
    if (typeof terminalId !== "string" || terminalId.length === 0) {
      safeLog("error", "no_terminal_id", {
        reason: "no_terminal_id",
        tab_id: ctx.tab_id,
        pane_id: paneId,
      });
      return 1;
    }
    ctx.pane_id = paneId;

    if (!claimTab(terminalId)) {
      logSkip("already_claimed", ctx, "info", { terminal_id: terminalId });
      return 0;
    }


    if (
      !rateLimit({
        count: defaults.rate_limit_count,
        windowMs: defaults.rate_limit_window_ms,
      })
    ) {
      logSkip("rate_limited", ctx, "warn");
      return 0;
    }

    if (decision.rule.run.mode === "command") {
      const readiness = waitForShellPrompt(paneId, {
        timeoutMs: defaults.ready_timeout_ms,
        pollIntervalMs: defaults.poll_interval_ms,
        deadlineAt,
      });
      if (!readiness || !readiness.ready) {
        logSkip(
          readiness && readiness.reason ? readiness.reason : "shell_not_ready",
          ctx,
          "warn",
        );
        return 0;
      }
    }

    if (Date.now() >= deadlineAt) {
      safeLog("error", "deadline_exceeded", {
        reason: "deadline_exceeded",
        tab_id: ctx.tab_id,
        pane_id: paneId,
      });
      return 1;
    }

    if (paneHasAgent(paneId, {
      deadlineAt,
      timeoutMs: remainingBudget(deadlineAt),
    })) {
      logSkip("pane_busy", ctx);
      return 0;
    }

    const rule = decision.rule;
    const run = rule.run;
    const mode = run.mode;
    let result;
    let stderr = "";

    if (mode === "command") {
      result = runCommand(paneId, run.command, {
        deadlineAt,
        timeoutMs: remainingBudget(deadlineAt),
      });
      stderr = result && result.stderr ? result.stderr : "";
    } else if (mode === "agent") {
      const timeoutMs = remainingAgentTimeout(deadlineAt);
      if (timeoutMs <= 3000) {
        safeLog("error", "deadline_exceeded", {
          reason: "agent_timeout_budget",
          tab_id: ctx.tab_id,
          pane_id: paneId,
        });
        return 1;
      }

      result = startAgent(paneId, {
        kind: run.kind,
        name: run.name || run.kind,
        agentArgs: run.agent_args,
        timeoutMs,
        deadlineAt,
      });
      stderr = result && result.stderr ? result.stderr : "";

      if (result && result.ok && run.prompt !== undefined && run.prompt !== null) {
        const promptResult = sendPrompt(paneId, run.prompt, {
          deadlineAt,
          timeoutMs: remainingBudget(deadlineAt),
        });
        if (!promptResult || !promptResult.ok) {
          result = { ok: false, stderr: promptResult && promptResult.stderr };
          stderr = result.stderr || "";
        }
      }
    } else {
      result = { ok: false, stderr: `Unsupported run mode: ${String(mode)}` };
      stderr = result.stderr;
    }

    const ok = Boolean(result && result.ok);
    if (!ok) {
      safeLog("error", "injection_failed", {
        tab_id: ctx.tab_id,
        pane_id: paneId,
        rule: rule.name,
        mode,
        stderr,
      });
    }

    safeLog("info", "autorun", {
      tab_id: ctx.tab_id,
      pane_id: paneId,
      rule: rule.name,
      mode,
      ok,
      took_ms: Date.now() - startedAt,
    });
    return ok ? 0 : 1;
  } catch (error) {
    safeLog("error", "autorun_error", { error: errorMessage(error) });
    return 0;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  process.exitCode = runHook();
}
