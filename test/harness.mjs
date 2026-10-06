import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const PLUGIN_ID = "han.tab-autorun";
const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const CASE_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 60;
const MARKER = "AUTORUN_OK";
const ACTION_ID = `${PLUGIN_ID}.run-here`;
const CALLER_IDS = ["HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "HERDR_PLUGIN_CONTEXT_JSON", "HERDR_PLUGIN_EVENT_JSON"];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = path.join(repoRoot, "src", "autorun.mjs");

function sleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function poll(check, timeoutMs = CASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = check();
    if (value) return value;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

function run(command, args, { env = process.env, timeoutMs = 10_000 } = {}) {
  try {
    const child = spawnSync(command, args, {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stdout = typeof child.stdout === "string" ? child.stdout : "";
    const stderr = typeof child.stderr === "string" ? child.stderr : "";
    let json = null;
    try {
      json = JSON.parse(stdout.trim());
    } catch {
      // Keep raw output for a useful failure message.
    }
    return {
      ok: !child.error && child.status === 0,
      status: typeof child.status === "number" ? child.status : null,
      stdout,
      stderr,
      json,
      error: child.error || null,
    };
  } catch (error) {
    return { ok: false, status: null, stdout: "", stderr: "", json: null, error };
  }
}

function herdr(args, options = {}) {
  return run(HERDR_BIN, args, options);
}

function detail(result) {
  return [result.error?.message, result.stderr.trim(), result.stdout.trim()]
    .filter(Boolean)
    .join(" | ") || `exit status ${result.status}`;
}

function commandError(label, result) {
  return new Error(`${label} failed: ${detail(result)}`);
}

export function canonical(value) {
  const missing = [];
  let current = path.resolve(value);
  while (true) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function inside(root, candidate) {
  const relative = path.relative(canonical(root), canonical(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isolationError() {
  try {
    const rootValue = process.env.HERDR_AUTORUN_TEST_ROOT;
    if (!rootValue) return "HERDR_AUTORUN_TEST_ROOT is required";
    if (!path.isAbsolute(rootValue)) return "HERDR_AUTORUN_TEST_ROOT must be absolute";
    const root = canonical(rootValue);
    const allowedTempRoots = [os.tmpdir(), "/tmp"];
    if (!allowedTempRoots.some((tempRoot) => {
      const base = canonical(tempRoot);
      return root !== base && inside(base, root);
    })) {
      return "HERDR_AUTORUN_TEST_ROOT must be a disposable directory strictly under os.tmpdir() or /tmp";
    }
    if (!fs.statSync(root).isDirectory()) return "HERDR_AUTORUN_TEST_ROOT must be an existing directory";

    const socket = process.env.HERDR_SOCKET_PATH;
    if (!socket) return "HERDR_SOCKET_PATH is required; refusing Herdr's default socket";
    if (!path.isAbsolute(socket) || !inside(root, socket)) {
      return "HERDR_SOCKET_PATH must be an absolute path inside HERDR_AUTORUN_TEST_ROOT";
    }
    for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
      const value = process.env[name];
      if (!value) return `${name} is required for isolated Herdr state`;
      if (!path.isAbsolute(value) || !inside(root, value)) {
        return `${name} must be an absolute path inside HERDR_AUTORUN_TEST_ROOT`;
      }
    }
    const config = process.env.HERDR_CONFIG_PATH;
    if (config && (!path.isAbsolute(config) || !inside(root, config))) {
      return "HERDR_CONFIG_PATH must be an absolute path inside HERDR_AUTORUN_TEST_ROOT";
    }
    return null;
  } catch (error) {
    return `cannot verify isolated paths: ${error.message}`;
  }
}

function statusRunning(result) {
  const status = result.json?.result?.status;
  const running = result.json?.result?.running;
  const text = result.stdout.trim();
  return result.ok && (
    running === true ||
    /^(running|ready|online)$/i.test(String(status || "")) ||
    (/\brunning\b/i.test(text) && !/\b(not running|stopped|offline)\b/i.test(text))
  );
}

function workspaces() {
  const result = herdr(["workspace", "list"]);
  if (!result.ok) throw commandError("herdr workspace list", result);
  if (!Array.isArray(result.json?.result?.workspaces)) throw new Error("herdr workspace list did not return workspaces");
  return result.json.result.workspaces;
}


function panes() {
  const result = herdr(["pane", "list"]);
  if (!result.ok) throw commandError("herdr pane list", result);
  if (!Array.isArray(result.json?.result?.panes)) throw new Error("herdr pane list did not return panes");
  return result.json.result.panes;
}

export function paneOutput(paneId, { readPane = (id) => herdr(["pane", "read", id]) } = {}) {
  const result = readPane(paneId);
  if (!result.ok) throw commandError(`herdr pane read ${paneId}`, result);
  return `${result.stdout}\n${result.json ? JSON.stringify(result.json) : ""}`;
}

export function observedBusyForeground(result) {
  const process = result.json?.result?.process_info;
  return result.ok && Number.isSafeInteger(process?.shell_pid) && process.shell_pid > 0 &&
    Number.isSafeInteger(process.foreground_process_group_id) && process.foreground_process_group_id > 0 &&
    process.foreground_process_group_id !== process.shell_pid ? process : null;
}

function pluginLogs() {
  const result = herdr(["plugin", "log", "list", "--plugin", PLUGIN_ID]);
  if (!result.ok) throw commandError("herdr plugin log list", result);
  return result.json?.result?.logs || [];
}

function actionEnvironment() {
  const env = { ...process.env };
  for (const key of CALLER_IDS) delete env[key];
  return env;
}

function currentPane() {
  const result = herdr(["pane", "current"], { env: actionEnvironment() });
  const pane = result.json?.result?.pane ?? result.json?.result;
  if (result.ok && pane?.pane_id) return pane;
  if (workspaces().length === 0 && panes().length === 0) return null;
  throw commandError("herdr pane current", result);
}

function checkedPane(paneId, tabId, workspaceId) {
  const result = herdr(["pane", "get", paneId]);
  const pane = result.json?.result?.pane;
  if (!result.ok || pane?.pane_id !== paneId || pane.tab_id !== tabId || pane.workspace_id !== workspaceId) {
    throw new Error(`pane ${paneId} does not belong to intended tab/workspace: ${detail(result)}`);
  }
  return pane;
}

function focusPane(paneId, tabId, workspaceId) {
  checkedPane(paneId, tabId, workspaceId);
  const tab = herdr(["tab", "focus", tabId], { env: actionEnvironment() });
  if (!tab.ok) throw commandError(`herdr tab focus ${tabId}`, tab);
  if (currentPane()?.pane_id !== paneId) {
    // Zooming an explicit pane selects it without depending on pane layout order.
    const layout = herdr(["pane", "layout", "--pane", paneId]);
    const wasZoomed = layout.json?.result?.layout?.zoomed ?? layout.json?.result?.zoomed;
    if (!layout.ok || typeof wasZoomed !== "boolean") {
      throw commandError(`herdr pane layout ${paneId}`, layout);
    }
    const zoom = herdr(["pane", "zoom", paneId, "--on"], { env: actionEnvironment() });
    if (!zoom.ok) throw commandError(`herdr pane zoom ${paneId} --on`, zoom);
    if (!wasZoomed) {
      const unzoom = herdr(["pane", "zoom", paneId, "--off"], { env: actionEnvironment() });
      if (!unzoom.ok) throw commandError(`herdr pane zoom ${paneId} --off`, unzoom);
    }
  }
  if (currentPane()?.pane_id !== paneId) throw new Error(`could not select pane ${paneId}`);
}

export function restoreOriginalFocus(originalFocus, failures, {
  listPanes = panes,
  focus = focusPane,
} = {}) {
  if (!originalFocus) return;
  try {
    const terminalId = originalFocus.terminal_id;
    if (terminalId != null && (typeof terminalId !== "string" || !terminalId)) {
      throw new Error("original focus has an invalid terminal identity");
    }
    if (!terminalId && (typeof originalFocus.pane_id !== "string" || !originalFocus.pane_id)) {
      throw new Error("original focus has no pane identity");
    }
    const currentPanes = listPanes();
    if (!Array.isArray(currentPanes)) throw new Error("pane list did not return panes");
    let original = null;
    for (const pane of currentPanes) {
      if (!pane || typeof pane !== "object" ||
        [pane.pane_id, pane.tab_id, pane.workspace_id].some((id) => typeof id !== "string" || !id)) {
        throw new Error("pane list contains a malformed pane");
      }
      if ((terminalId ? pane.terminal_id === terminalId : pane.pane_id === originalFocus.pane_id)) {
        if (original) throw new Error("pane list contains ambiguous original focus");
        original = pane;
      }
    }
    if (!original) return;
    focus(original.pane_id, original.tab_id, original.workspace_id);
  } catch (error) {
    failures.push("cleanup");
    console.error(`Cleanup could not restore original focus: ${error.message}`);
  }
}

function invokeSelected({ paneId, tabId }, workspaceId, { succeeds = true } = {}) {
  focusPane(paneId, tabId, workspaceId);
  const result = herdr(["plugin", "action", "invoke", ACTION_ID], {
    env: actionEnvironment(),
    timeoutMs: 20_000,
  });
  if (!result.ok) throw commandError(`herdr plugin action invoke ${ACTION_ID}`, result);
  const context = result.json?.result?.context;
  if (context?.workspace_id !== workspaceId || context?.tab_id !== tabId || context?.focused_pane_id !== paneId) {
    throw new Error(`action invocation returned wrong scope: ${JSON.stringify(context)}`);
  }
  const logId = result.json?.result?.log?.log_id;
  if (typeof logId !== "string" || !logId) throw new Error("action invocation did not return log.log_id");
  const log = poll(() => {
    const entry = pluginLogs().find((candidate) => candidate.log_id === logId);
    return entry && entry.status !== "running" ? entry : null;
  }, 25_000);
  if (!log) throw new Error(`action log ${logId} did not reach a terminal status`);
  const expected = succeeds ? "succeeded" : "failed";
  if (log.status !== expected || (succeeds && log.exit_code !== 0)) {
    throw new Error(`action log ${logId} expected ${expected}: ${JSON.stringify(log)}`);
  }
  return log;
}

function validId(id) {
  return typeof id === "string" && id.length > 0;
}

function paneInventory(listPanes = panes) {
  const listed = listPanes();
  if (!Array.isArray(listed)) throw new Error("pane inventory unavailable");
  const terminals = new Set();
  const paneIds = new Set();
  for (const pane of listed) {
    if (!pane || ![pane.pane_id, pane.tab_id, pane.workspace_id, pane.terminal_id].every(validId) ||
      terminals.has(pane.terminal_id) || paneIds.has(pane.pane_id)) {
      throw new Error("pane inventory contains missing or ambiguous identity");
    }
    terminals.add(pane.terminal_id);
    paneIds.add(pane.pane_id);
  }
  return listed;
}

export function registerOwnedTerminal(pane, workspaceId, ownedTerminalIds, existingTerminalIds) {
  if (!pane || ![pane.pane_id, pane.tab_id, pane.workspace_id, pane.terminal_id, workspaceId].every(validId) ||
    pane.workspace_id !== workspaceId || !(ownedTerminalIds instanceof Set) ||
    !(existingTerminalIds instanceof Set) || existingTerminalIds.has(pane.terminal_id) ||
    ownedTerminalIds.has(pane.terminal_id)) {
    throw new Error("creation response has uncertain or duplicate terminal ownership");
  }
  ownedTerminalIds.add(pane.terminal_id);
  return pane.terminal_id;
}

export function createdPane(responsePane, tabId, workspaceId, before, ownedTerminalIds, {
  listPanes = panes,
  waitFor = (check) => poll(check, 3_000),
} = {}) {
  const paneId = responsePane?.pane_id;
  if (![paneId, responsePane?.tab_id, responsePane?.workspace_id, responsePane?.terminal_id, tabId].every(validId) ||
    responsePane.tab_id !== tabId || responsePane.workspace_id !== workspaceId) {
    throw new Error("creation response has no trustworthy pane and terminal scope");
  }
  registerOwnedTerminal(responsePane, workspaceId, ownedTerminalIds, before);
  const matching = waitFor(() => paneInventory(listPanes).find((pane) => pane.pane_id === paneId &&
    pane.tab_id === tabId && pane.workspace_id === workspaceId &&
    pane.terminal_id === responsePane.terminal_id));
  if (!matching) throw new Error(`created pane ${paneId} has no matching terminal identity`);
  return matching;
}

function splitPane(tab, cwd, workspaceId, ownership, timeoutMs) {
  const before = new Set(paneInventory().map((pane) => pane.terminal_id));
  const wasUncertain = ownership.uncertain;
  ownership.uncertain = true;
  const args = ["pane", "split", "--pane", tab.paneId, "--direction", "right"];
  if (cwd) args.push("--cwd", cwd);
  args.push("--no-focus");
  const split = herdr(args, timeoutMs ? { timeoutMs } : {});
  const pane = split.json?.result?.pane;
  if (pane) {
    const created = createdPane(pane, tab.tabId, workspaceId, before, ownership.terminals);
    if (split.ok) ownership.uncertain = wasUncertain;
    if (!split.ok) throw commandError(`herdr pane split ${tab.paneId}`, split);
    return { paneId: created.pane_id, tabId: tab.tabId };
  }
  if (!split.ok) throw commandError(`herdr pane split ${tab.paneId}`, split);
  throw new Error("pane split response did not include result.pane.pane_id");
}

function requireEffect(outputFile, marker, paneId, otherPaneId) {
  if (!poll(() => fileContains(outputFile, marker))) throw new Error(`missing file effect ${marker}`);
  if (!poll(() => paneOutput(paneId).includes(marker))) throw new Error(`pane ${paneId} did not show ${marker}`);
  if (otherPaneId && paneOutput(otherPaneId).includes(marker)) {
    throw new Error(`wrong pane ${otherPaneId} showed ${marker}`);
  }
}

function noEffect(outputFile, marker, ...paneIds) {
  if (fileContains(outputFile, marker) || paneIds.some((id) => paneOutput(id).includes(marker))) {
    throw new Error(`unexpected effect ${marker}`);
  }
}

function appendEffect(directory, marker) {
  const outputFile = path.join(directory, ".manual-append");
  return { outputFile, marker, command: `printf '%s\\n' ${quoteShell(marker)} >> ${quoteShell(outputFile)}; printf '%s\\n' ${quoteShell(marker)}` };
}

function appendLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trimEnd().split("\n").filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function manualRules(entries, { rateCount = 100, rateWindowMs = 60000, readyTimeoutMs = 8000 } = {}) {
  return `[defaults]\nenabled = true\nready_timeout_ms = ${readyTimeoutMs}\npoll_interval_ms = 60\ntotal_timeout_ms = 15000\nrate_limit_count = ${rateCount}\nrate_limit_window_ms = ${rateWindowMs}\n\n${entries.map(({ name, cwd, command }) =>
    `[[rules]]\nname = ${quoteToml(name)}\n[rules.when]\ncwd_glob = ${quoteToml(cwd)}\n[rules.run]\nmode = "command"\ncommand = ${quoteToml(command)}\n`).join("\n")}`;
}


function quoteToml(value) {
  return JSON.stringify(String(value));
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function effect(fixture, marker = MARKER) {
  const outputFile = path.join(fixture, ".autorun-result");
  const quotedFile = quoteShell(outputFile);
  const command = `printf '%s' ${quoteShell(marker)} > ${quotedFile}; cat ${quotedFile}`;
  return { outputFile, command };
}

function fileContains(filePath, value) {
  try {
    return fs.readFileSync(filePath, "utf8").includes(value);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function removeFile(filePath) {
  fs.rmSync(filePath, { force: true });
}

function rules({ name, fixture, mode = "command", command = "" }) {
  const run = [`mode = ${quoteToml(mode)}`];
  if (mode === "command") run.push(`command = ${quoteToml(command)}`);
  return `[defaults]\nenabled = true\nready_timeout_ms = 8000\npoll_interval_ms = 60\ntotal_timeout_ms = 15000\nrate_limit_count = 100\nrate_limit_window_ms = 60000\n\n[[rules]]\nname = ${quoteToml(name)}\n[rules.when]\ncwd_glob = ${quoteToml(fixture)}\n[rules.run]\n${run.join("\n")}\n`;
}

function writeRules(configDir, text) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "rules.toml"), text, "utf8");
}

function backupRules(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile()) throw new Error(`${filePath} is not a regular file`);
    return { data: fs.readFileSync(filePath), mode: stat.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function restoreRules(filePath, backup) {
  if (backup === null) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, backup.data);
  fs.chmodSync(filePath, backup.mode);
}

function configDir() {
  const result = herdr(["plugin", "config-dir", PLUGIN_ID]);
  if (!result.ok) throw commandError(`herdr plugin config-dir ${PLUGIN_ID}`, result);
  const value = result.stdout.trim();
  if (!path.isAbsolute(value)) throw new Error(`herdr plugin config-dir returned no absolute path: ${value}`);
  return value;
}

function createTab(fixture, workspaceId, ownership) {
  const before = new Set(paneInventory().map((pane) => pane.terminal_id));
  const wasUncertain = ownership.uncertain;
  ownership.uncertain = true;
  const result = herdr(["tab", "create", "--workspace", workspaceId, "--no-focus", "--cwd", fixture], { timeoutMs: 20_000 });
  const tab = result.json?.result?.tab;
  const rootPane = result.json?.result?.root_pane;
  if (!validId(tab?.tab_id) || tab.workspace_id !== workspaceId) {
    if (!result.ok) throw commandError(`herdr tab create --workspace ${workspaceId} --cwd ${fixture}`, result);
    throw new Error("tab create response did not identify an owned tab");
  }
  const created = createdPane(rootPane, tab.tab_id, workspaceId, before, ownership.terminals);
  if (result.ok) ownership.uncertain = wasUncertain;
  if (!result.ok) throw commandError(`herdr tab create --workspace ${workspaceId} --cwd ${fixture}`, result);
  return { tabId: tab.tab_id, paneId: created.pane_id, terminalId: created.terminal_id, tab, rootPane };
}

function tabLogText(tab) {
  return JSON.stringify(pluginLogs().filter((entry) => {
    const text = JSON.stringify(entry);
    return text.includes(tab.tabId) || text.includes(tab.paneId);
  }));
}

function waitForSkip(tab, reason, outputFile) {
  const deadline = Date.now() + CASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fileContains(outputFile, MARKER) || paneOutput(tab.paneId).includes(MARKER)) {
      throw new Error(`skip case unexpectedly ran ${MARKER}`);
    }
    if (tabLogText(tab).includes(reason)) return;
    sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`plugin log did not record ${reason} for tab ${tab.tabId}`);
}

function stableLogCount() {
  const started = Date.now();
  let last = pluginLogs().length;
  let changed = started;
  while (Date.now() - started < 3_000) {
    const current = pluginLogs().length;
    if (current !== last) {
      last = current;
      changed = Date.now();
    }
    if (Date.now() - changed >= 300) return last;
    sleep(POLL_INTERVAL_MS);
  }
  return last;
}

function noAdditionalLogs(previousCount) {
  const deadline = Date.now() + CASE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (pluginLogs().length > previousCount) return false;
    sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function jsonEnv(name) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : {};
  } catch {
    return {};
  }
}

function directEnvironment(tab, fixture, config, state) {
  const inheritedContext = jsonEnv("HERDR_PLUGIN_CONTEXT_JSON");
  const inheritedEvent = jsonEnv("HERDR_PLUGIN_EVENT_JSON");
  const context = {
    ...inheritedContext,
    workspace_id: tab.tab.workspace_id,
    workspace_cwd: fixture,
    tab_id: tab.tabId,
    tab_label: tab.tab.label || "autorun-dedup",
    focused_pane_id: tab.paneId,
    focused_pane_cwd: fixture,
    invocation_source: inheritedContext.invocation_source || "api",
    correlation_id: "tab.created",
  };
  const event = {
    ...inheritedEvent,
    event: "tab_created",
    data: {
      ...(inheritedEvent.data || {}),
      type: "tab_created",
      tab: {
        ...(inheritedEvent.data?.tab || {}),
        tab_id: tab.tabId,
        workspace_id: context.workspace_id,
        label: tab.tab.label || "autorun-dedup",
      },
    },
  };
  const environment = { ...process.env };
  Object.assign(environment, {
    HERDR_ENV: "1",
    HERDR_PLUGIN_ID: PLUGIN_ID,
    HERDR_PLUGIN_ROOT: repoRoot,
    HERDR_PLUGIN_CONFIG_DIR: config,
    HERDR_PLUGIN_STATE_DIR: state,
    HERDR_PLUGIN_EVENT: "tab.created",
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(event),
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
    HERDR_WORKSPACE_ID: context.workspace_id,
    HERDR_TAB_ID: tab.tabId,
    HERDR_PANE_ID: tab.paneId,
  });
  return environment;
}

function directHook(environment) {
  return run(process.execPath, [hookPath], { env: environment, timeoutMs: CASE_TIMEOUT_MS });
}

export function cleanupOwnedPanes(workspaceId, ownedTerminalIds, failures, {
  listPanes = panes,
  listWorkspaces = workspaces,
  closePane = (id) => herdr(["pane", "close", id], { timeoutMs: 10_000 }),
  waitFor = (check) => poll(check, 3_000),
} = {}) {
  let retainedResources = false;
  const fail = (message) => {
    retainedResources = true;
    failures.push("cleanup");
    console.error(`Cleanup retained resources: ${message}`);
  };
  if (!workspaceId && ownedTerminalIds instanceof Set && ownedTerminalIds.size === 0) {
    return { retainedResources: false };
  }
  if (!validId(workspaceId) || !(ownedTerminalIds instanceof Set) ||
    [...ownedTerminalIds].some((id) => !validId(id))) {
    fail(`workspace ${String(workspaceId)} has uncertain ownership`);
    return { retainedResources };
  }
  const inventory = () => paneInventory(listPanes);
  const workspaceInventory = () => {
    const listed = listWorkspaces();
    if (!Array.isArray(listed) || listed.some((item) => !validId(item?.workspace_id)) ||
      new Set(listed.map((item) => item.workspace_id)).size !== listed.length) {
      throw new Error("workspace inventory unavailable or ambiguous");
    }
    return listed;
  };
  for (const terminalId of ownedTerminalIds) {
    try {
      const matches = inventory().filter((pane) => pane.terminal_id === terminalId);
      if (matches.length === 0) continue;
      const target = matches[0];
      if (target.workspace_id !== workspaceId) {
        fail(`owned terminal ${terminalId} moved to workspace ${target.workspace_id}, pane ${target.pane_id}`);
        continue;
      }
      // Pane IDs can change during moves; do not close without refreshing terminal identity and scope.
      const fresh = inventory().filter((pane) => pane.terminal_id === terminalId);
      if (fresh.length !== 1 || fresh[0].pane_id !== target.pane_id ||
        fresh[0].tab_id !== target.tab_id || fresh[0].workspace_id !== workspaceId) {
        fail(`owned terminal ${terminalId} changed before pane close`);
        continue;
      }
      const close = closePane(fresh[0].pane_id);
      let notFound = close.json?.error?.code === "pane_not_found";
      if (!notFound && typeof close.stderr === "string") {
        try { notFound = JSON.parse(close.stderr.trim())?.error?.code === "pane_not_found"; } catch {}
      }
      if (!close.ok && !notFound) {
        fail(`could not close terminal ${terminalId}, pane ${fresh[0].pane_id}: ${detail(close)}`);
      }
      if (!waitFor(() => !inventory().some((pane) => pane.terminal_id === terminalId))) {
        fail(`could not confirm terminal ${terminalId}, pane ${fresh[0].pane_id} disappeared`);
      }
    } catch (error) {
      fail(`terminal ${terminalId}: ${error.message}`);
    }
  }
  try {
    const remaining = inventory();
    const liveOwned = remaining.filter((pane) => ownedTerminalIds.has(pane.terminal_id));
    if (liveOwned.length) fail(`owned terminals remain: ${liveOwned.map((pane) => `${pane.terminal_id}@${pane.workspace_id}/${pane.pane_id}`).join(", ")}`);
    const workspacePanes = remaining.filter((pane) => pane.workspace_id === workspaceId);
    if (workspacePanes.length) fail(`workspace ${workspaceId} contains retained panes: ${workspacePanes.map((pane) => `${pane.terminal_id}@${pane.pane_id}`).join(", ")}`);
    if (workspaceInventory().some((item) => item.workspace_id === workspaceId) &&
      !waitFor(() => !workspaceInventory().some((item) => item.workspace_id === workspaceId))) {
      fail(`workspace ${workspaceId} still exists (never closing a workspace containing foreign terminals)`);
    }
  } catch (error) {
    fail(`workspace ${workspaceId} inventory: ${error.message}`);
  }
  return { retainedResources };
}

function runCase(name, action, failures) {
  try {
    action();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

function main() {
  const safetyError = isolationError();
  if (safetyError) {
    console.error(`Cannot run Herdr autorun harness safely: ${safetyError}.`);
    process.exitCode = 1;
    return;
  }
  const isolatedRoot = canonical(process.env.HERDR_AUTORUN_TEST_ROOT);
  const status = herdr(["status"]);
  if (!statusRunning(status)) {
    console.error(`Cannot run Herdr autorun harness: a running Herdr server is required (${detail(status)}).`);
    process.exitCode = 1;
    return;
  }

  let tempRoot = null;
  let realRulesPath = null;
  let previousRules = null;
  let linkAttempted = false;
  let workspaceId = null;
  const ownership = { terminals: new Set(), uncertain: false };
  let originalFocus = null;
  const ownedReports = new Map();
  const failures = [];

  try {
    // Capture before creating the first workspace: a new workspace can become focused on an empty server.
    originalFocus = currentPane();
    const existingWorkspaces = new Set(workspaces().map((workspace) => workspace.workspace_id));
    const requestedRoot = path.join(isolatedRoot, `herdr-tab-autorun-test-${process.pid}`);
    tempRoot = fs.existsSync(requestedRoot) ? fs.mkdtempSync(`${requestedRoot}-`) : requestedRoot;
    const config = path.join(tempRoot, "config");
    const state = path.join(tempRoot, "state");
    const fixtures = path.join(tempRoot, "fixtures");
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(fixtures, { recursive: true });
    const fixture = {
      command: path.join(fixtures, "command-match"),
      noMatch: path.join(fixtures, "no-match"),
      skip: path.join(fixtures, "skip-rule"),
      split: path.join(fixtures, "split-no-fire"),
      dedup: path.join(fixtures, "dedup"),
      rate: path.join(fixtures, "rate-claim"),
      rateOther: path.join(fixtures, "rate-other"),
      manualRoot: path.join(fixtures, "manual-root"),
      manualSecondary: path.join(fixtures, "manual-secondary"),
      busy: path.join(fixtures, "manual-busy"),
      agent: path.join(fixtures, "manual-agent"),
    };
    for (const directory of Object.values(fixture)) fs.mkdirSync(directory, { recursive: true });
    for (const key of Object.keys(fixture)) fixture[key] = fs.realpathSync(fixture[key]);
    const dedupEffect = effect(fixture.dedup, "DEDUP_OK");
    removeFile(dedupEffect.outputFile);
    writeRules(config, rules({ name: "temporary dedup command", fixture: fixture.dedup, command: dedupEffect.command }));
    const beforeWorkspace = new Set(paneInventory().map((pane) => pane.terminal_id));
    ownership.uncertain = true;
    const workspace = herdr(["workspace", "create", "--cwd", fixture.command, "--label", `autorun-harness-${randomUUID()}`, "--no-focus"], { timeoutMs: 20_000 });
    const returnedId = workspace.json?.result?.workspace?.workspace_id;
    if (validId(returnedId) && !existingWorkspaces.has(returnedId)) workspaceId = returnedId;
    if (!workspaceId) {
      if (!workspace.ok) throw commandError("herdr workspace create", workspace);
      throw new Error("workspace create did not return a new result.workspace.workspace_id");
    }
    const initialTab = workspace.json?.result?.tab;
    if (!validId(initialTab?.tab_id) || initialTab.workspace_id !== workspaceId) {
      throw new Error(`workspace ${workspaceId} creation did not identify its initial tab`);
    }
    createdPane(workspace.json?.result?.root_pane, initialTab.tab_id, workspaceId, beforeWorkspace, ownership.terminals);
    if (workspace.ok) ownership.uncertain = false;
    if (!workspace.ok) throw commandError("herdr workspace create", workspace);

    linkAttempted = true;
    const link = herdr(["plugin", "link", repoRoot], { timeoutMs: 20_000 });
    if (!link.ok) throw commandError(`herdr plugin link ${repoRoot}`, link);
    const warnings = link.json?.warnings || link.json?.result?.warnings || [];
    if (Array.isArray(warnings) && warnings.length > 0) console.warn(`WARN herdr plugin link: ${JSON.stringify(warnings)}`);

    const realConfigDir = configDir();
    if (!inside(isolatedRoot, realConfigDir)) throw new Error(`refusing plugin config outside isolated root: ${realConfigDir}`);
    realRulesPath = path.join(realConfigDir, "rules.toml");
    previousRules = backupRules(realRulesPath);

    runCase("manual_claim_and_rate_bypass", () => {
      const auto = effect(fixture.rate, "RATE_AUTO_OK");
      const manual = appendEffect(fixture.rate, `RATE_MANUAL_${randomUUID()}`);
      removeFile(auto.outputFile);
      removeFile(manual.outputFile);
      const competing = effect(fixture.rateOther, "RATE_COMPETING_OK");
      removeFile(competing.outputFile);
      writeRules(realConfigDir, manualRules([
        { name: "automatic rate claim", cwd: fixture.rate, command: auto.command },
        { name: "competing automatic claim", cwd: fixture.rateOther, command: competing.command },
      ], { rateCount: 1, rateWindowMs: 3600000 }));
      const tab = createTab(fixture.rate, workspaceId, ownership);
      requireEffect(auto.outputFile, "RATE_AUTO_OK", tab.paneId);
      const other = createTab(fixture.rateOther, workspaceId, ownership);
      waitForSkip(other, "rate_limited", competing.outputFile);
      noEffect(competing.outputFile, "RATE_COMPETING_OK", other.paneId);
      writeRules(realConfigDir, manualRules([
        { name: "manual after automatic claim", cwd: fixture.rate, command: manual.command },
      ], { rateCount: 1, rateWindowMs: 3600000 }));
      invokeSelected(tab, workspaceId);
      invokeSelected(tab, workspaceId);
      if (!poll(() => appendLines(manual.outputFile).length === 2)) throw new Error("manual effect did not occur twice");
      const lines = appendLines(manual.outputFile);
      if (lines.length !== 2 || lines.some((line) => line !== manual.marker)) {
        throw new Error(`expected exactly two manual command executions: ${JSON.stringify(lines)}`);
      }
      if (!poll(() => paneOutput(tab.paneId).includes(lines[0]))) throw new Error("manual effect not visible in selected pane");
      if (paneOutput(other.paneId).includes(lines[0])) throw new Error("manual effect visible in other pane");
      if (fs.existsSync(path.join(fixture.rateOther, ".manual-append"))) throw new Error("manual effect in other fixture");
    }, failures);
    // Every remaining automatic case uses the original generous rate fixture.
    writeRules(realConfigDir, rules({ name: "restore normal rate fixture", fixture: fixture.command, mode: "skip" }));

    runCase("manual_selected_root_secondary_and_swap", () => {
      writeRules(realConfigDir, rules({ name: "initial manual tab skip", fixture: fixture.manualRoot, mode: "skip" }));
      const tab = createTab(fixture.manualRoot, workspaceId, ownership);
      const secondary = splitPane(tab, fixture.manualSecondary, workspaceId, ownership);
      if (checkedPane(secondary.paneId, tab.tabId, workspaceId).cwd !== fixture.manualSecondary) {
        throw new Error("split pane did not acquire its distinct fixture cwd");
      }
      const rootMarker = `ROOT_${randomUUID()}`;
      const secondaryMarker = `SECONDARY_${randomUUID()}`;
      const root = effect(fixture.manualRoot, rootMarker);
      const second = effect(fixture.manualSecondary, secondaryMarker);
      removeFile(root.outputFile);
      removeFile(second.outputFile);
      writeRules(realConfigDir, manualRules([
        { name: "root cwd", cwd: fixture.manualRoot, command: root.command },
        { name: "secondary cwd", cwd: fixture.manualSecondary, command: second.command },
      ]));
      invokeSelected(tab, workspaceId);
      requireEffect(root.outputFile, rootMarker, tab.paneId, secondary.paneId);
      noEffect(second.outputFile, secondaryMarker, tab.paneId, secondary.paneId);
      invokeSelected(secondary, workspaceId);
      requireEffect(second.outputFile, secondaryMarker, secondary.paneId, tab.paneId);
      const swappedMarker = `SWAPPED_${randomUUID()}`;
      const swapped = effect(fixture.manualSecondary, swappedMarker);
      removeFile(swapped.outputFile);
      writeRules(realConfigDir, manualRules([
        { name: "root cwd", cwd: fixture.manualRoot, command: root.command },
        { name: "secondary cwd", cwd: fixture.manualSecondary, command: swapped.command },
      ]));
      const swap = herdr(["pane", "swap", "--source-pane", tab.paneId, "--target-pane", secondary.paneId]);
      if (!swap.ok || swap.json?.result?.swap?.changed !== true) throw commandError("herdr pane swap", swap);
      invokeSelected(secondary, workspaceId);
      requireEffect(swapped.outputFile, swappedMarker, secondary.paneId, tab.paneId);
    }, failures);

    runCase("manual_busy_foreground", () => {
      writeRules(realConfigDir, rules({ name: "initial busy tab skip", fixture: fixture.busy, mode: "skip" }));
      const tab = createTab(fixture.busy, workspaceId, ownership);
      const busyMarker = `BUSY_${randomUUID()}`;
      const candidate = effect(fixture.busy, busyMarker);
      removeFile(candidate.outputFile);
      writeRules(realConfigDir, manualRules([
        { name: "busy shell guard", cwd: fixture.busy, command: candidate.command },
      ], { readyTimeoutMs: 600 }));
      const occupied = herdr(["pane", "run", tab.paneId, "sleep 12"]);
      if (!occupied.ok) throw commandError("occupy busy foreground", occupied);
      const observed = poll(() => observedBusyForeground(herdr(["pane", "process-info", "--pane", tab.paneId])), 3_000);
      if (!observed) throw new Error("did not positively observe non-shell foreground");
      const log = invokeSelected(tab, workspaceId, { succeeds: false });
      if (!String(log.stdout || "").includes("pane was not ready")) throw new Error("busy guard did not reject on readiness");
      if (!observedBusyForeground(herdr(["pane", "process-info", "--pane", tab.paneId]))) {
        throw new Error("busy foreground ended before readiness timeout");
      }
      noEffect(candidate.outputFile, busyMarker, tab.paneId);
    }, failures);

    runCase("manual_existing_agent_report", () => {
      writeRules(realConfigDir, rules({ name: "initial agent tab skip", fixture: fixture.agent, mode: "skip" }));
      const tab = createTab(fixture.agent, workspaceId, ownership);
      const marker = `AGENT_GUARD_${randomUUID()}`;
      const candidate = effect(fixture.agent, marker);
      removeFile(candidate.outputFile);
      writeRules(realConfigDir, manualRules([
        { name: "reported agent guard", cwd: fixture.agent, command: candidate.command },
      ]));
      const source = `custom:autorun-harness-${randomUUID()}`;
      const agent = `autorun-probe-${randomUUID().slice(0, 8)}`;
      const report = herdr(["pane", "report-agent", tab.paneId, "--source", source, "--agent", agent, "--state", "working"]);
      if (!report.ok) throw commandError("report owned agent", report);
      ownedReports.set(tab.terminalId, { source, agent });
      const visible = poll(() => panes().find((pane) => pane.pane_id === tab.paneId && pane.agent));
      if (!visible) throw new Error("reported agent was not observed in pane.agent");
      const log = invokeSelected(tab, workspaceId);
      if (!String(log.stdout || "").includes("pane already has an agent")) throw new Error("existing-agent guard did not skip");
      noEffect(candidate.outputFile, marker, tab.paneId);
    }, failures);

    runCase("command_match", () => {
      const command = effect(fixture.command);
      removeFile(command.outputFile);
      writeRules(realConfigDir, rules({ name: "command match", fixture: fixture.command, command: command.command }));
      const tab = createTab(fixture.command, workspaceId, ownership);
      if (!poll(() => fileContains(command.outputFile, MARKER))) throw new Error(`command did not write ${command.outputFile}`);
      if (!poll(() => paneOutput(tab.paneId).includes(MARKER))) throw new Error(`pane ${tab.paneId} did not contain ${MARKER}`);
    }, failures);

    runCase("no_match", () => {
      const command = effect(fixture.command);
      removeFile(path.join(fixture.noMatch, ".autorun-result"));
      writeRules(realConfigDir, rules({ name: "command only elsewhere", fixture: fixture.command, command: command.command }));
      const tab = createTab(fixture.noMatch, workspaceId, ownership);
      waitForSkip(tab, "no_rule_match", path.join(fixture.noMatch, ".autorun-result"));
    }, failures);

    runCase("skip_rule", () => {
      const outputFile = path.join(fixture.skip, ".autorun-result");
      removeFile(outputFile);
      writeRules(realConfigDir, rules({ name: "explicit skip", fixture: fixture.skip, mode: "skip" }));
      const tab = createTab(fixture.skip, workspaceId, ownership);
      waitForSkip(tab, "rule_skip", outputFile);
    }, failures);

    runCase("split_no_fire", () => {
      const command = effect(fixture.split);
      removeFile(command.outputFile);
      writeRules(realConfigDir, rules({ name: "split command", fixture: fixture.split, command: command.command }));
      const tab = createTab(fixture.split, workspaceId, ownership);
      if (!poll(() => fileContains(command.outputFile, MARKER))) throw new Error(`command did not write ${command.outputFile}`);
      if (!poll(() => paneOutput(tab.paneId).includes(MARKER))) throw new Error(`pane ${tab.paneId} did not contain ${MARKER}`);
      const baseline = stableLogCount();
      splitPane(tab, null, workspaceId, ownership, 10_000);
      if (!noAdditionalLogs(baseline)) throw new Error("plugin recorded an additional autorun entry after pane split");
    }, failures);

    runCase("dedup", () => {
      writeRules(realConfigDir, rules({ name: "dedup command", fixture: fixture.dedup, command: dedupEffect.command }));
      const tab = createTab(fixture.dedup, workspaceId, ownership);
      if (!poll(() => fileContains(dedupEffect.outputFile, "DEDUP_OK"))) throw new Error(`command did not write ${dedupEffect.outputFile}`);
      fs.rmSync(state, { recursive: true, force: true });
      fs.mkdirSync(state, { recursive: true });
      const environment = directEnvironment(tab, fixture.dedup, config, state);
      const first = directHook(environment);
      if (!first.ok) throw new Error(`first direct hook failed: ${detail(first)}`);
      const second = directHook(environment);
      if (!second.ok) throw new Error(`second direct hook failed: ${detail(second)}`);
      if (!`${second.stdout}\n${second.stderr}`.includes("already_claimed")) {
        throw new Error(`second direct hook did not log already_claimed: ${second.stdout.trim()}`);
      }
    }, failures);
  } catch (error) {
    failures.push("setup");
    console.error(`FAIL setup: ${error.message}`);
  } finally {
    for (const [terminalId, { source, agent }] of ownedReports) {
      try {
        const matches = paneInventory().filter((pane) => pane.terminal_id === terminalId);
        if (matches.length === 0) continue;
        const paneId = matches[0].pane_id;
        const released = herdr(["pane", "release-agent", paneId, "--source", source, "--agent", agent]);
        if (!released.ok) {
          failures.push("cleanup");
          console.error(`Cleanup could not release owned report ${source} on ${terminalId}: ${detail(released)}`);
        } else if (!poll(() => !paneInventory().find((pane) => pane.terminal_id === terminalId)?.agent, 3_000)) {
          failures.push("cleanup");
          console.error(`Cleanup could not confirm report ${source} on ${terminalId} was released`);
        }
      } catch (error) {
        failures.push("cleanup");
        console.error(`Cleanup could not release owned report ${source} on ${terminalId}: ${error.message}`);
      }
    }
    restoreOriginalFocus(originalFocus, failures);
    let retainedResources = ownership.uncertain;
    if (ownership.uncertain) {
      failures.push("cleanup");
      console.error(`Cleanup has unproven creation provenance for workspace ${workspaceId || "unknown"}; retaining fixtures`);
    }
    try {
      retainedResources = cleanupOwnedPanes(workspaceId, ownership.terminals, failures).retainedResources || retainedResources;
    } catch (error) {
      retainedResources = true;
      failures.push("cleanup");
      console.error(`Cleanup could not inspect workspace ${workspaceId || "unknown"}: ${error.message}`);
    }
    restoreOriginalFocus(originalFocus, failures);
    if (linkAttempted) {
      try {
        const unlink = herdr(["plugin", "unlink", PLUGIN_ID], { timeoutMs: 20_000 });
        if (!unlink.ok) {
          failures.push("cleanup");
          console.error(`Cleanup could not unlink ${PLUGIN_ID}: ${detail(unlink)}`);
        }
      } catch (error) {
        failures.push("cleanup");
        console.error(`Cleanup failed to unlink ${PLUGIN_ID}: ${error.message}`);
      }
    }
    if (realRulesPath) {
      try {
        restoreRules(realRulesPath, previousRules);
      } catch (error) {
        failures.push("cleanup");
        console.error(`Cleanup could not restore ${realRulesPath}: ${error.message}`);
      }
    }
    if (tempRoot) {
      if (retainedResources) {
        console.error(`Cleanup retained fixture directory ${tempRoot} for workspace ${workspaceId || "unknown"}; owned terminals: ${[...ownership.terminals].join(", ") || "none known"}`);
      } else {
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        } catch (error) {
          failures.push("cleanup");
          console.error(`Cleanup could not remove ${tempRoot}: ${error.message}`);
        }
      }
    }
  }
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`FAIL harness: ${error.stack || error.message}`);
    process.exitCode = 1;
  }
}
