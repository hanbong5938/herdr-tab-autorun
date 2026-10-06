import path from "node:path";

import { loadConfig, normalizeConfig } from "../config.mjs";
import { buildContext, decide } from "../autorun.mjs";
import {
  herdr,
  paneHasAgent,
  runCommand,
  sendPrompt,
  startAgent,
  waitForShellPrompt,
} from "../herdr.mjs";

function configDirectory() {
  return process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(process.cwd(), "config");
}

function validId(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function snapshotId(raw, mirror) {
  if (raw !== undefined && raw !== null && !validId(raw)) return null;
  if (mirror !== undefined && mirror !== null && !validId(mirror)) return null;
  if (raw != null && mirror != null && raw !== mirror) return null;
  return raw ?? mirror ?? null;
}

function resolveTarget(context) {
  const raw = context.raw_context;
  const paneId = snapshotId(raw.focused_pane_id, process.env.HERDR_PANE_ID);
  const tabId = snapshotId(raw.tab_id, process.env.HERDR_TAB_ID);
  const workspaceId = snapshotId(raw.workspace_id, process.env.HERDR_WORKSPACE_ID);
  if (!paneId || !tabId || !workspaceId) return null;
  return { paneId, tabId, workspaceId };
}

function scopedPane(target, deadlineAt) {
  if (remainingMs(deadlineAt) <= 0) {
    console.log("failed: total timeout expired");
    return false;
  }
  const response = herdr(["pane", "get", target.paneId], { deadlineAt });
  const pane = response.json?.result?.pane;
  if (
    !response.ok ||
    !pane ||
    typeof pane !== "object" ||
    Array.isArray(pane) ||
    pane.pane_id !== target.paneId ||
    pane.tab_id !== target.tabId ||
    pane.workspace_id !== target.workspaceId
  ) {
    console.log("failed: selected pane is unavailable or outside the invocation scope");
    return false;
  }
  return true;
}

function configErrors(loaded, normalized) {
  return [
    ...(Array.isArray(loaded.errors) ? loaded.errors : []),
    ...(Array.isArray(normalized.errors) ? normalized.errors : []),
  ];
}

function printConfigErrors(errors) {
  for (const error of errors) {
    console.log(`error: ${error}`);
  }
}
function remainingMs(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

function runRule(target, rule, ruleIndex, defaults, deadlineAt) {
  const run = rule.run || {};
  const paneId = target?.paneId;
  const mode = run.mode;
  console.log(`rule: ${rule.name} (index ${ruleIndex})`);
  console.log(`mode: ${mode}`);

  if (mode === "skip") {
    console.log("did: nothing (skip rule)");
    return 0;
  }

  if (remainingMs(deadlineAt) <= 0) {
    console.log("failed: total timeout expired");
    return 1;
  }
  if (!target) {
    console.log("failed: could not resolve pane id, tab id, and workspace id for this invocation");
    return 1;
  }

  if (!scopedPane(target, deadlineAt)) return 1;
  if (paneHasAgent(paneId, { deadlineAt })) {
    console.log("did: nothing (pane already has an agent)");
    return 0;
  }

  if (mode === "command") {
    const command = run.command;
    if (typeof command !== "string" || command.length === 0) {
      console.log("failed: command rule has no command");
      return 1;
    }
    const readyTimeoutMs = Number.isFinite(defaults.ready_timeout_ms)
      ? Math.max(0, defaults.ready_timeout_ms)
      : 8000;
    const pollIntervalMs = Number.isFinite(defaults.poll_interval_ms)
      ? Math.max(0, defaults.poll_interval_ms)
      : 60;
    const readiness = waitForShellPrompt(paneId, {
      timeoutMs: Math.min(readyTimeoutMs, remainingMs(deadlineAt)),
      pollIntervalMs,
      deadlineAt,
    });
    if (!readiness || !readiness.ready) {
      console.log(`failed: pane was not ready (${readiness?.reason || "unknown reason"})`);
      return 1;
    }

    if (!scopedPane(target, deadlineAt)) return 1;
    console.log(`command: ${JSON.stringify(command)}`);
    const result = runCommand(paneId, command, {
      timeoutMs: remainingMs(deadlineAt),
      deadlineAt,
    });
    if (!result?.ok) {
      console.log(`failed: command${result?.stderr ? `: ${result.stderr}` : ""}`);
      return 1;
    }
    console.log("did: command");
    return 0;
  }

  if (mode === "agent") {
    const kind = run.kind;
    if (typeof kind !== "string" || kind.length === 0) {
      console.log("failed: agent rule has no kind");
      return 1;
    }
    const name = run.name || kind;
    const agentArgs = Array.isArray(run.agent_args) ? run.agent_args : [];
    if (remainingMs(deadlineAt) <= 3000) {
      console.log("failed: not enough time remains to start agent");
      return 1;
    }
    if (!scopedPane(target, deadlineAt)) return 1;
    const agentTimeoutMs = remainingMs(deadlineAt);
    if (agentTimeoutMs <= 3000) {
      console.log("failed: not enough time remains to start agent");
      return 1;
    }
    console.log(`agent: ${JSON.stringify({ kind, name, agent_args: agentArgs })}`);
    const started = startAgent(paneId, {
      kind,
      name,
      agentArgs,
      timeoutMs: Math.min(300000, agentTimeoutMs),
      deadlineAt,
    });
    if (!started?.ok) {
      console.log(`failed: agent${started?.stderr ? `: ${started.stderr}` : ""}`);
      return 1;
    }

    if (typeof run.prompt === "string" && run.prompt.length > 0) {
      if (!scopedPane(target, deadlineAt)) return 1;
      console.log(`prompt: ${JSON.stringify(run.prompt)}`);
      const prompted = sendPrompt(paneId, run.prompt, {
        timeoutMs: remainingMs(deadlineAt),
        deadlineAt,
      });
      if (!prompted?.ok) {
        console.log(`failed: prompt${prompted?.stderr ? `: ${prompted.stderr}` : ""}`);
        return 1;
      }
    }

    console.log("did: agent");
    return 0;
  }

  console.log(`failed: unsupported mode ${JSON.stringify(mode)}`);
  return 1;
}

function main() {
  const loaded = loadConfig(configDirectory());
  const normalized = normalizeConfig(loaded.config || {});
  const errors = configErrors(loaded, normalized);
  printConfigErrors(errors);
  if (errors.length > 0) {
    console.log("failed: invalid configuration");
    return 1;
  }

  const defaults = normalized.defaults || {};
  const totalTimeoutMs = Number.isFinite(defaults.total_timeout_ms)
    ? Math.max(0, defaults.total_timeout_ms)
    : 15000;
  const deadlineAt = Date.now() + totalTimeoutMs;

  const context = buildContext(process.env);
  const decision = decide(context, normalized);
  if (!decision?.rule) {
    console.log("no rule matched for this tab");
    return 1;
  }

  return runRule(resolveTarget(context), decision.rule, decision.index, defaults, deadlineAt);
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
