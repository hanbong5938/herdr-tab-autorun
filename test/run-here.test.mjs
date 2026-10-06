import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const action = path.join(root, "src", "actions", "run-here.mjs");

// A process boundary represents Herdr's pane API. Commands run in distinct
// temporary pane directories; agent operations update a fixture registry.
const gateway = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const statePath = process.env.TEST_GATEWAY_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
function save() { fs.writeFileSync(statePath, JSON.stringify(state)); }
function reply(result) { process.stdout.write(JSON.stringify({ result })); }
if (args[0] === "pane" && args[1] === "get") {
  const next = (state.gets || []).shift();
  save();
  if (next === "error") {
    process.stderr.write("pane lookup failed");
    process.exitCode = 1;
  } else {
    reply(next === "malformed" ? { pane: [] } : { pane: next === undefined ? state.panes.find(p => p.pane_id === args[2]) || null : next });
  }
} else if (args[0] === "pane" && args[1] === "list") {
  reply({ panes: state.panes });
} else if (args[0] === "pane" && args[1] === "process-info") {
  if (state.focusAfterReadiness) { state.focus = state.focusAfterReadiness; save(); }
  reply({ process_info: state.busy ? {
    shell_pid: 42, foreground_process_group_id: 43,
    foreground_processes: [{ pid: 43 }]
  } : {
    shell_pid: 42, foreground_process_group_id: 42,
    foreground_processes: [{ pid: 42 }]
  } });
} else if (args[0] === "pane" && args[1] === "run") {
  const pane = state.panes.find(p => p.pane_id === args[2]);
  if (!pane) {
    process.exitCode = 1;
  } else {
    const result = spawnSync(args[3], { shell: true, cwd: state.cwd[pane.pane_id], encoding: "utf8" });
    if (result.error || result.status !== 0) {
      process.stderr.write(result.error?.message || result.stderr || "command failed");
      process.exitCode = 1;
    }
  }
} else if (args[0] === "agent" && args[1] === "start") {
  const pane = state.panes.find(p => p.pane_id === args[args.indexOf("--pane") + 1]);
  if (!pane || pane.agent) {
    process.exitCode = 1;
  } else {
    pane.agent = { id: args[2] };
    state.agents[pane.pane_id] = { status: "ready", submissions: 0 };
    save();
    reply({});
  }
} else if (args[0] === "agent" && args[1] === "prompt") {
  const agent = state.agents[args[2]];
  if (!agent || agent.status !== "ready") {
    process.exitCode = 1;
  } else {
    agent.status = "working";
    agent.submissions++;
    save();
    reply({});
  }
} else {
  process.stderr.write("unexpected gateway operation");
  process.exitCode = 2;
}
`;

const selected = { pane_id: "pane-selected", tab_id: "tab-selected", workspace_id: "workspace-selected", agent: null };
const other = { pane_id: "pane-first", tab_id: "tab-other", workspace_id: "workspace-selected", agent: null };
const raw = {
  workspace_id: "workspace-selected", tab_id: "tab-selected",
  focused_pane_id: "pane-selected", workspace_cwd: "/workspace",
  invocation_source: "action",
};
function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
const marker = "effect.txt";
function commandRules(cwd) {
  return `[[rules]]
name = "selected cwd"
[rules.when]
cwd_glob = ${JSON.stringify(cwd)}
[rules.run]
mode = "command"
command = ${JSON.stringify(`printf '%s' ${shellQuote("selected-rule")} > ${shellQuote(marker)}`)}

[[rules]]
name = "fallback"
[rules.run]
mode = "command"
command = ${JSON.stringify(`printf '%s' ${shellQuote("fallback-rule")} > ${shellQuote(marker)}`)}
`;
}
const agentRules = `[[rules]]
name = "agent"
[rules.run]
mode = "agent"
kind = "claude"
prompt = "hello"
`;

function scenario(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "run-here-scope-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = {
    "pane-first": path.join(directory, "first-pane"),
    "pane-selected": path.join(directory, "selected-pane"),
  };
  for (const location of Object.values(cwd)) fs.mkdirSync(location);
  const config = path.join(directory, "config");
  fs.mkdirSync(config);
  fs.writeFileSync(path.join(config, "rules.toml"), `[defaults]\ntotal_timeout_ms = ${options.totalTimeout ?? 8000}\nready_timeout_ms = ${options.readyTimeout ?? 1000}\npoll_interval_ms = 1\nenabled = ${options.enabled ?? true}\n\n${options.rules ?? commandRules(cwd["pane-selected"])}`);
  const binary = path.join(directory, "gateway.cjs");
  fs.writeFileSync(binary, gateway, { mode: 0o700 });
  const stateFile = path.join(directory, "gateway.json");
  const state = {
    panes: options.panes ?? [other, selected], gets: options.gets ?? [],
    busy: options.busy ?? false, agents: {}, cwd, focus: "pane-selected",
    focusAfterReadiness: options.focusAfterReadiness,
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  const context = { ...raw, focused_pane_cwd: cwd["pane-selected"], ...options.context };
  const env = {
    ...process.env, HERDR_BIN_PATH: binary, HERDR_PLUGIN_CONFIG_DIR: config,
    TEST_GATEWAY_STATE: stateFile,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context),
    HERDR_PLUGIN_EVENT_JSON: "{}",
    HERDR_PANE_ID: "pane-selected", HERDR_TAB_ID: "tab-selected",
    HERDR_WORKSPACE_ID: "workspace-selected",
    ...options.env,
  };
  function invoke() {
    const result = spawnSync(process.execPath, [action], {
      cwd: root, env, encoding: "utf8", timeout: 12000,
    });
    if (result.error) throw result.error;
    function content(paneId) {
      const file = path.join(cwd[paneId], marker);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    }
    return {
      status: result.status, output: `${result.stdout}\n${result.stderr}`,
      state: JSON.parse(fs.readFileSync(stateFile, "utf8")),
      files: { "pane-first": content("pane-first"), "pane-selected": content("pane-selected") },
    };
  }
  return invoke;
}

function noEffect(result) {
  assert.deepEqual(result.files, { "pane-first": null, "pane-selected": null });
  assert.deepEqual(result.state.agents, {});
  assert.equal(result.state.panes.find(p => p.pane_id === "pane-first")?.agent, null);
  assert.equal(result.state.panes.find(p => p.pane_id === "pane-selected")?.agent ?? null, null);
}

function rejected(result) {
  assert.equal(result.status, 1, result.output);
  noEffect(result);
}
function agentState(result, status, submissions) {
  assert.deepEqual(result.files, { "pane-first": null, "pane-selected": null });
  assert.equal(result.state.panes.find(p => p.pane_id === "pane-first")?.agent, null);
  assert.ok(result.state.panes.find(p => p.pane_id === "pane-selected")?.agent);
  assert.deepEqual(result.state.agents, {
    "pane-selected": { status, submissions },
  });
}

test("selected secondary pane uses snapshot cwd and first matching rule, not pane order or later focus", (t) => {
  const result = scenario(t, { focusAfterReadiness: "pane-first" })();
  assert.equal(result.status, 0, result.output);
  assert.equal(result.state.focus, "pane-first");
  assert.deepEqual(result.files, { "pane-first": null, "pane-selected": "selected-rule" });
  assert.deepEqual(result.state.agents, {});
});

test("missing, malformed and conflicting invocation identity cannot execute", (t) => {
  for (const env of [
    { HERDR_PANE_ID: "pane-first" },
    { HERDR_TAB_ID: "tab-other" },
    { HERDR_WORKSPACE_ID: "workspace-other" },
    { HERDR_PANE_ID: "" },
    { HERDR_PANE_ID: undefined },
  ]) {
    const context = env.HERDR_PANE_ID === undefined ? { focused_pane_id: undefined } : undefined;
    rejected(scenario(t, { env, context })());
  }
  rejected(scenario(t, { env: { HERDR_TAB_ID: undefined }, context: { tab_id: undefined } })());
  rejected(scenario(t, { env: { HERDR_WORKSPACE_ID: undefined }, context: { workspace_id: undefined } })());
  rejected(scenario(t, { context: { focused_pane_id: 7 } })());
});

test("a valid environment pane ID supplies absent raw pane ID, never a different raw pane ID", (t) => {
  const result = scenario(t, { context: { focused_pane_id: undefined } })();
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.files, { "pane-first": null, "pane-selected": "selected-rule" });
});

test("lookup error, malformed response, wrong identity, and deleted or moved preflight reject effects", (t) => {
  for (const gets of [
    ["error"], ["malformed"], [null],
    [{ ...selected, pane_id: "pane-first" }],
    [{ ...selected, tab_id: "tab-other" }],
    [{ ...selected, workspace_id: "workspace-other" }],
  ]) rejected(scenario(t, { gets })());
  rejected(scenario(t, { panes: [other] })());
});

test("scope change after readiness prevents command effect", (t) => {
  for (const moved of [null, { ...selected, tab_id: "tab-other" }, { ...selected, workspace_id: "workspace-other" }]) {
    rejected(scenario(t, { gets: [selected, moved] })());
  }
});

test("agent start and optional prompt each require a fresh scoped target", (t) => {
  rejected(scenario(t, { rules: agentRules, gets: [selected, { ...selected, tab_id: "tab-other" }] })());
  const result = scenario(t, { rules: agentRules, gets: [selected, selected, { ...selected, workspace_id: "workspace-other" }] })();
  assert.equal(result.status, 1, result.output);
  agentState(result, "ready", 0);
  const success = scenario(t, { rules: agentRules })();
  assert.equal(success.status, 0, success.output);
  agentState(success, "working", 1);
});

test("skip, disabled, no-rule, occupied shell and existing agent keep their consumer outcomes", (t) => {
  const skip = scenario(t, { rules: `[[rules]]\nname = "skip"\n[rules.run]\nmode = "skip"\n`, gets: ["error"] })();
  assert.equal(skip.status, 0, skip.output);
  noEffect(skip);
  assert.deepEqual(skip.state.gets, ["error"]);

  const disabled = scenario(t, { enabled: false })();
  assert.equal(disabled.status, 1, disabled.output);
  noEffect(disabled);

  const noRule = scenario(t, { rules: `[[rules]]\nname = "unmatched"\n[rules.when]\ncwd_glob = "/elsewhere"\n[rules.run]\nmode = "command"\ncommand = ${JSON.stringify(`printf '%s' ${shellQuote("unexpected")} > ${shellQuote(marker)}`)}\n` })();
  assert.equal(noRule.status, 1, noRule.output);
  noEffect(noRule);

  const occupied = scenario(t, { busy: true, readyTimeout: 10 })();
  rejected(occupied);

  const guarded = scenario(t, { panes: [other, { ...selected, agent: { id: "existing" } }] })();
  assert.equal(guarded.status, 0, guarded.output);
  assert.deepEqual(guarded.files, { "pane-first": null, "pane-selected": null });
  assert.deepEqual(guarded.state.agents, {});
  assert.deepEqual(guarded.state.panes.find(p => p.pane_id === "pane-selected")?.agent, { id: "existing" });
});

test("an exhausted total deadline cannot execute an effect", (t) => {
  const result = scenario(t, { totalTimeout: 1 })();
  rejected(result);
});
