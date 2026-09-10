import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_HERDR_TIMEOUT_MS = 20000;
const DEFAULT_READY_TIMEOUT_MS = 8000;
const DEFAULT_POLL_INTERVAL_MS = 60;
const DEFAULT_STATE_DIR = "herdr-tab-autorun-state";
const DEFAULT_RATE_COUNT = 5;
const DEFAULT_RATE_WINDOW_MS = 10000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RATE_LOCK_TIMEOUT_MS = 100;
const RATE_LOCK_POLL_MS = 5;
const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));
let rateTempSequence = 0;

function asText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return String(value);
  } catch {
    return "";
  }
}

function commandArgs(args) {
  if (!Array.isArray(args)) {
    return [];
  }
  return args.map((arg) => asText(arg));
}

function timeoutValue(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function childBudget(options, fallback) {
  let timeoutMs = fallback;
  let deadlineAt = Infinity;
  try {
    if (options && typeof options === "object") {
      timeoutMs = timeoutValue(options.timeoutMs, fallback);
      if (Number.isFinite(options.deadlineAt)) {
        deadlineAt = options.deadlineAt;
      }
    }
  } catch {
    timeoutMs = fallback;
    deadlineAt = Infinity;
  }

  if (!Number.isFinite(deadlineAt)) {
    return { timeoutMs, deadlineAt, expired: false };
  }
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    return { timeoutMs: 0, deadlineAt, expired: true };
  }
  return { timeoutMs: Math.min(timeoutMs, remaining), deadlineAt, expired: false };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(error) {
  if (error && typeof error.message === "string") {
    return error.message;
  }
  return asText(error);
}

function sleepSync(milliseconds) {
  const ms = Math.max(0, Math.floor(timeoutValue(milliseconds, 0)));
  try {
    Atomics.wait(SLEEP_VIEW, 0, 0, ms);
  } catch {
    // Polling remains best effort on hosts without Atomics.wait.
  }
}

function hasCliError(json) {
  return Boolean(json && typeof json === "object" && json.error);
}

function hashText(value) {
  try {
    return createHash("sha256").update(asText(value), "utf8").digest("hex");
  } catch {
    return "";
  }
}

function uniqueAgentName(prefix, paneId) {
  const suffix = `-${hashText(paneId).slice(0, 12)}`;
  const maxPrefixLength = Math.max(1, 32 - suffix.length);
  const configured = asText(prefix) || "agent";
  return `${configured.slice(0, maxPrefixLength)}${suffix}`.slice(0, 32);
}

/** Return the configured Herdr executable path. */
export function herdrBin() {
  try {
    return process.env.HERDR_BIN_PATH || "herdr";
  } catch {
    return "herdr";
  }
}

/** Invoke Herdr synchronously and decode a JSON response when available. */
export function herdr(args = [], options = {}) {
  const budget = childBudget(options, DEFAULT_HERDR_TIMEOUT_MS);
  if (budget.expired) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "deadline exceeded",
      json: null,
    };
  }

  let status = null;
  let stdout = "";
  let stderr = "";
  try {
    const result = spawnSync(herdrBin(), commandArgs(args), {
      encoding: "utf8",
      timeout: budget.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    status = result && typeof result.status === "number" ? result.status : null;
    stdout = asText(result && result.stdout);
    stderr = asText(result && result.stderr);
    if (!stderr && result && result.error) {
      stderr = errorMessage(result.error);
    }
  } catch (error) {
    stderr = errorMessage(error);
  }

  const json = parseJson(stdout);
  return {
    ok: status === 0 && !hasCliError(json),
    status,
    stdout,
    stderr,
    json,
  };
}

/** Return process information for a pane, or null when unavailable. */
export function paneProcessInfo(paneId, options = {}) {
  try {
    const result = herdr(["pane", "process-info", "--pane", asText(paneId)], options);
    return result.json?.result?.process_info ?? null;
  } catch {
    return null;
  }
}

/** List panes, optionally restricted to a workspace. */
export function paneList(workspaceId, options = {}) {
  try {
    const args = ["pane", "list"];
    if (workspaceId !== undefined && workspaceId !== null) {
      args.push("--workspace", asText(workspaceId));
    }
    const panes = herdr(args, options).json?.result?.panes;
    return Array.isArray(panes) ? panes : [];
  } catch {
    return [];
  }
}

/** Poll until a pane has only its shell in the foreground. */
export function waitForShellPrompt(paneId, options = {}) {
  const settings = options && typeof options === "object" ? options : {};
  const timeoutMs = timeoutValue(settings.timeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const pollIntervalMs = timeoutValue(settings.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const deadlineAt = Number.isFinite(settings.deadlineAt) ? settings.deadlineAt : Infinity;
  const startedAt = Date.now();
  const deadline = Math.min(startedAt + timeoutMs, deadlineAt);
  let sawProcessInfo = false;
  let shellPid = null;
  let consecutiveReadyPid = null;

  if (deadline < startedAt) {
    return { ready: false, reason: "timeout", shellPid };
  }

  while (Date.now() <= deadline) {
    const remaining = deadline - Date.now();
    const processInfo = paneProcessInfo(paneId, {
      timeoutMs: Math.max(0, remaining),
      deadlineAt: deadline,
    });
    if (processInfo !== null && processInfo !== undefined) {
      sawProcessInfo = true;
      const candidatePid = processInfo && processInfo.shell_pid;
      if (typeof candidatePid === "number") {
        shellPid = candidatePid;
        const foreground = processInfo.foreground_processes;
        const shellReady =
          processInfo.foreground_process_group_id === candidatePid &&
          Array.isArray(foreground) &&
          foreground.length > 0 &&
          foreground.every((process) => process && process.pid === candidatePid);
        if (shellReady) {
          if (consecutiveReadyPid === candidatePid) {
            return { ready: true, reason: "ready", shellPid };
          }
          consecutiveReadyPid = candidatePid;
        } else {
          consecutiveReadyPid = null;
        }
      } else {
        consecutiveReadyPid = null;
      }
    } else {
      consecutiveReadyPid = null;
    }

    const afterPoll = deadline - Date.now();
    if (afterPoll <= 0) {
      break;
    }
    sleepSync(Math.min(pollIntervalMs, afterPoll));
  }

  return {
    ready: false,
    reason: sawProcessInfo ? "timeout" : "no_process_info",
    shellPid,
  };
}

/** Run a trusted shell command in a pane. */
export function runCommand(paneId, command, options = {}) {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { ok: false, stderr: "command must be a non-empty string" };
  }
  try {
    const result = herdr(["pane", "run", asText(paneId), command], options);
    return { ok: result.ok, stderr: result.stderr };
  } catch (error) {
    return { ok: false, stderr: errorMessage(error) };
  }
}

/** Start a configured coding agent in a pane. */
export function startAgent(paneId, options = {}) {
  const settings = options && typeof options === "object" ? options : {};
  const timeoutMs = timeoutValue(settings.timeoutMs, 30000);
  let deadlineAt = Infinity;
  try {
    if (Number.isFinite(settings.deadlineAt)) {
      deadlineAt = settings.deadlineAt;
    }
  } catch {
    deadlineAt = Infinity;
  }
  const remaining = Number.isFinite(deadlineAt) ? deadlineAt - Date.now() : Infinity;
  if (timeoutMs <= 3000 || timeoutMs > 300000) {
    return { ok: false, stderr: "agent timeout must be greater than 3000ms and at most 300000ms" };
  }
  if (remaining <= 3000) {
    return { ok: false, stderr: "agent start deadline is too close" };
  }

  const args = [
    "agent",
    "start",
    uniqueAgentName(settings.name, paneId),
    "--kind",
    asText(settings.kind),
    "--pane",
    asText(paneId),
    "--timeout",
    asText(timeoutMs),
  ];
  const agentArgs = commandArgs(settings.agentArgs);
  if (agentArgs.length > 0) {
    args.push("--", ...agentArgs);
  }

  try {
    const spawnTimeout = Math.min(timeoutMs + 5000, remaining);
    const result = herdr(args, { timeoutMs: spawnTimeout, deadlineAt });
    return { ok: result.ok, stderr: result.stderr };
  } catch (error) {
    return { ok: false, stderr: errorMessage(error) };
  }
}

/** Send a prompt to a Herdr agent target without waiting. */
export function sendPrompt(target, text, options = {}) {
  try {
    const result = herdr(["agent", "prompt", asText(target), asText(text)], options);
    return { ok: result.ok, stderr: result.stderr };
  } catch (error) {
    return { ok: false, stderr: errorMessage(error) };
  }
}

/** Return whether a pane currently has an attached agent. */
export function paneHasAgent(paneId, options = {}) {
  try {
    const result = herdr(["pane", "list"], options);
    if (!result.ok) {
      return true;
    }
    const panes = result.json?.result?.panes;
    if (!Array.isArray(panes)) {
      return true;
    }
    return panes.some(
      (pane) => pane && pane.pane_id === paneId && pane.agent !== null && pane.agent !== undefined && pane.agent !== "",
    );
  } catch {
    return true;
  }
}

function statePath() {
  try {
    const base = process.env.HERDR_PLUGIN_STATE_DIR || path.join(os.tmpdir(), DEFAULT_STATE_DIR);
    const socketPath = process.env.HERDR_SOCKET_PATH;
    return socketPath ? path.join(base, `socket-${hashText(socketPath)}`) : base;
  } catch {
    return DEFAULT_STATE_DIR;
  }
}

function ensureDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function claimsPath(create = true) {
  try {
    const directory = path.join(statePath(), "claims");
    if (create && !ensureDirectory(directory)) {
      return null;
    }
    return directory;
  } catch {
    return null;
  }
}

function claimMarker(key) {
  return `claim-${hashText(key)}`;
}

function acquireRateLock(lockPath) {
  const deadline = Date.now() + RATE_LOCK_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    try {
      return fs.openSync(lockPath, "wx");
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        return null;
      }
      sleepSync(Math.min(RATE_LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }
  return null;
}

function releaseRateLock(lockPath, descriptor) {
  try {
    fs.closeSync(descriptor);
  } catch {
    // Continue removing the lock marker.
  }
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // A concurrent cleanup or filesystem failure is harmless here.
  }
}

/** Return the plugin state directory path. */
export function stateDir() {
  return statePath();
}

/** Atomically claim a terminal for one autorun attempt. */
export function claimTab(tabId) {
  const key = asText(tabId);
  if (!key) {
    log("error", "cannot claim terminal without an identity");
    return false;
  }
  const directory = claimsPath(true);
  if (!directory) {
    log("error", "cannot create claim directory");
    return false;
  }

  let descriptor = null;
  try {
    descriptor = fs.openSync(path.join(directory, claimMarker(key)), "wx");
    return true;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      return false;
    }
    log("error", "cannot claim terminal", { error: errorMessage(error) });
    return false;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The marker was created even if closing its descriptor fails.
      }
    }
  }
}


/** Allow a rate-limited operation and record it when below the limit. */
export function rateLimit(options = {}) {
  const settings = options && typeof options === "object" ? options : {};
  const count = typeof settings.count === "number" && !Number.isNaN(settings.count)
    ? settings.count
    : DEFAULT_RATE_COUNT;
  const windowMs = typeof settings.windowMs === "number" && !Number.isNaN(settings.windowMs)
    ? settings.windowMs
    : DEFAULT_RATE_WINDOW_MS;
  const directory = stateDir();
  if (!ensureDirectory(directory)) {
    log("error", "cannot create rate-limit directory");
    return false;
  }

  let ratePath;
  let lockPath;
  try {
    ratePath = path.join(directory, "rate.json");
    lockPath = path.join(directory, "rate.json.lock");
  } catch (error) {
    log("error", "cannot construct rate-limit paths", { error: errorMessage(error) });
    return false;
  }

  const descriptor = acquireRateLock(lockPath);
  if (descriptor === null) {
    log("error", "cannot acquire rate-limit lock");
    return false;
  }

  try {
    let recorded = [];
    try {
      const raw = fs.readFileSync(ratePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        recorded = parsed.filter((timestamp) => typeof timestamp === "number" && Number.isFinite(timestamp));
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        log("error", "cannot read rate-limit state", { error: errorMessage(error) });
        return false;
      }
    }

    const now = Date.now();
    const recent = recorded.filter((timestamp) => now - timestamp <= windowMs);
    if (recent.length >= count) {
      return false;
    }

    recent.push(now);
    const temporaryPath = `${ratePath}.${process.pid}.${rateTempSequence++}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(recent), { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporaryPath, ratePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup.
      }
      log("error", "cannot write rate-limit state", { error: errorMessage(error) });
      return false;
    }
    return true;
  } finally {
    releaseRateLock(lockPath, descriptor);
  }
}


/** Write one structured log line to the captured plugin stream. */
export function log(level, msg, extra) {
  let line;
  try {
    const record = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(extra || {}),
    };
    line = JSON.stringify(record);
  } catch {
    try {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        level: asText(level),
        msg: asText(msg),
      });
    } catch {
      line = "{\"level\":\"error\",\"msg\":\"logging failed\"}";
    }
  }

  try {
    const stream = level === "error" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  } catch {
    // Logging must never make the hook fail.
  }
}
