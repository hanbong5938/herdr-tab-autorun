import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const PLUGIN_ID = "han.tab-autorun";
const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const CASE_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 60;
const MARKER = "AUTORUN_OK";
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

function canonical(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function inside(root, candidate) {
  const relative = path.relative(canonical(root), canonical(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isolationError() {
  const rootValue = process.env.HERDR_AUTORUN_TEST_ROOT;
  if (!rootValue) return "HERDR_AUTORUN_TEST_ROOT is required";
  if (!path.isAbsolute(rootValue)) return "HERDR_AUTORUN_TEST_ROOT must be absolute";
  const root = path.resolve(rootValue);
  const allowedTempRoots = [path.resolve(os.tmpdir()), "/tmp"];
  if (!allowedTempRoots.some((tempRoot) => inside(tempRoot, root)) || root === "/tmp") {
    return "HERDR_AUTORUN_TEST_ROOT must be a disposable directory under os.tmpdir() or /tmp";
  }

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

function tabs() {
  const result = herdr(["tab", "list"]);
  if (!result.ok) throw commandError("herdr tab list", result);
  return result.json?.result?.tabs || [];
}

function panes() {
  const result = herdr(["pane", "list"]);
  if (!result.ok) throw commandError("herdr pane list", result);
  return result.json?.result?.panes || [];
}

function paneOutput(paneId) {
  const result = herdr(["pane", "read", paneId]);
  return `${result.stdout}\n${result.json ? JSON.stringify(result.json) : ""}`;
}

function pluginLogs() {
  const result = herdr(["plugin", "log", "list", "--plugin", PLUGIN_ID]);
  if (!result.ok) throw commandError("herdr plugin log list", result);
  return result.json?.result?.logs || [];
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

function createTab(fixture, createdTabs) {
  const result = herdr(["tab", "create", "--no-focus", "--cwd", fixture], { timeoutMs: 20_000 });
  if (!result.ok) throw commandError(`herdr tab create --cwd ${fixture}`, result);
  const created = result.json?.result;
  const tab = created?.tab;
  const rootPane = created?.root_pane;
  const tabId = tab?.tab_id;
  const paneId = rootPane?.pane_id;
  if (!tabId || !paneId) throw new Error("tab create response did not include result.tab and result.root_pane");
  createdTabs.add(tabId);
  const visible = poll(() => panes().some((pane) => pane.pane_id === paneId), 3_000);
  if (!visible) throw new Error(`created root pane ${paneId} did not appear in pane list`);
  return { tabId, paneId, tab, rootPane };
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
    workspace_id: tab.tab.workspace_id || tab.rootPane.workspace_id || process.env.HERDR_WORKSPACE_ID || "",
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
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("HERDR_")) environment[key] = value;
  }
  Object.assign(environment, {
    HERDR_BIN_PATH: HERDR_BIN,
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

function cleanupTabs(createdTabs) {
  for (const tabId of createdTabs) {
    try {
      const close = herdr(["tab", "close", tabId], { timeoutMs: 10_000 });
      const gone = poll(() => !tabs().some((tab) => tab.tab_id === tabId), 3_000);
      if (!gone) console.error(`Cleanup could not close created tab ${tabId}: ${detail(close)}`);
    } catch (error) {
      console.error(`Cleanup failed for created tab ${tabId}: ${error.message}`);
    }
  }
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
  const isolatedRoot = path.resolve(process.env.HERDR_AUTORUN_TEST_ROOT);
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
  const createdTabs = new Set();
  const failures = [];

  try {
    const initialTabIds = new Set(tabs().map((tab) => tab.tab_id));
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
    };
    for (const directory of Object.values(fixture)) fs.mkdirSync(directory, { recursive: true });
    for (const key of Object.keys(fixture)) fixture[key] = fs.realpathSync(fixture[key]);
    const dedupEffect = effect(fixture.dedup, "DEDUP_OK");
    removeFile(dedupEffect.outputFile);
    writeRules(config, rules({ name: "temporary dedup command", fixture: fixture.dedup, command: dedupEffect.command }));

    linkAttempted = true;
    const link = herdr(["plugin", "link", repoRoot], { timeoutMs: 20_000 });
    if (!link.ok) throw commandError(`herdr plugin link ${repoRoot}`, link);
    const warnings = link.json?.warnings || link.json?.result?.warnings || [];
    if (Array.isArray(warnings) && warnings.length > 0) console.warn(`WARN herdr plugin link: ${JSON.stringify(warnings)}`);

    const realConfigDir = configDir();
    if (!inside(isolatedRoot, realConfigDir)) throw new Error(`refusing plugin config outside isolated root: ${realConfigDir}`);
    realRulesPath = path.join(realConfigDir, "rules.toml");
    previousRules = backupRules(realRulesPath);

    runCase("command_match", () => {
      const command = effect(fixture.command);
      removeFile(command.outputFile);
      writeRules(realConfigDir, rules({ name: "command match", fixture: fixture.command, command: command.command }));
      const tab = createTab(fixture.command, createdTabs);
      if (!poll(() => fileContains(command.outputFile, MARKER))) throw new Error(`command did not write ${command.outputFile}`);
      if (!poll(() => paneOutput(tab.paneId).includes(MARKER))) throw new Error(`pane ${tab.paneId} did not contain ${MARKER}`);
    }, failures);

    runCase("no_match", () => {
      const command = effect(fixture.command);
      removeFile(path.join(fixture.noMatch, ".autorun-result"));
      writeRules(realConfigDir, rules({ name: "command only elsewhere", fixture: fixture.command, command: command.command }));
      const tab = createTab(fixture.noMatch, createdTabs);
      waitForSkip(tab, "no_rule_match", path.join(fixture.noMatch, ".autorun-result"));
    }, failures);

    runCase("skip_rule", () => {
      const outputFile = path.join(fixture.skip, ".autorun-result");
      removeFile(outputFile);
      writeRules(realConfigDir, rules({ name: "explicit skip", fixture: fixture.skip, mode: "skip" }));
      const tab = createTab(fixture.skip, createdTabs);
      waitForSkip(tab, "rule_skip", outputFile);
    }, failures);

    runCase("split_no_fire", () => {
      const command = effect(fixture.split);
      removeFile(command.outputFile);
      writeRules(realConfigDir, rules({ name: "split command", fixture: fixture.split, command: command.command }));
      const tab = createTab(fixture.split, createdTabs);
      if (!poll(() => fileContains(command.outputFile, MARKER))) throw new Error(`command did not write ${command.outputFile}`);
      if (!poll(() => paneOutput(tab.paneId).includes(MARKER))) throw new Error(`pane ${tab.paneId} did not contain ${MARKER}`);
      const beforePaneIds = new Set(panes().filter((pane) => pane.tab_id === tab.tabId).map((pane) => pane.pane_id));
      const baseline = stableLogCount();
      const split = herdr(["pane", "split", "--pane", tab.paneId, "--direction", "right", "--no-focus"], { timeoutMs: 10_000 });
      if (!split.ok) throw commandError(`herdr pane split ${tab.paneId}`, split);
      const newPane = poll(() => panes().find((pane) => pane.tab_id === tab.tabId && !beforePaneIds.has(pane.pane_id)));
      if (!newPane) throw new Error("pane split did not expose a new pane");
      if (!noAdditionalLogs(baseline)) throw new Error("plugin recorded an additional autorun entry after pane split");
    }, failures);

    runCase("dedup", () => {
      writeRules(realConfigDir, rules({ name: "dedup command", fixture: fixture.dedup, command: dedupEffect.command }));
      const tab = createTab(fixture.dedup, createdTabs);
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
    if (tempRoot) cleanupTabs(createdTabs);
    if (linkAttempted) {
      const unlink = herdr(["plugin", "unlink", PLUGIN_ID], { timeoutMs: 20_000 });
      if (!unlink.ok) {
        failures.push("cleanup");
        console.error(`Cleanup could not unlink ${PLUGIN_ID}: ${detail(unlink)}`);
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
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch (error) {
        failures.push("cleanup");
        console.error(`Cleanup could not remove ${tempRoot}: ${error.message}`);
      }
    }
  }
  if (failures.length > 0) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`FAIL harness: ${error.stack || error.message}`);
  process.exitCode = 1;
}
