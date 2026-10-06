import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadConfig, matchRule, normalizeConfig, parseToml } from "../src/config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = path.join(repoRoot, "src", "autorun.mjs");

function matchingRule(normalized, context) {
  return matchRule(normalized.rules, context);
}

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("the first matching skip rule overrides a later broad command", () => {
  const normalized = normalizeConfig({
    rules: [
      {
        name: "skip protected repository",
        when: { repo_name: "protected" },
        run: { mode: "skip" },
      },
      {
        name: "run the general command",
        run: { mode: "command", command: "echo autorun" },
      },
    ],
  });

  assert.equal(normalized.errors.length, 0);

  const protectedMatch = matchingRule(normalized, { repo_name: "protected" });
  assert.ok(protectedMatch);
  assert.equal(protectedMatch.rule.run.mode, "skip");

  const ordinaryMatch = matchingRule(normalized, { repo_name: "ordinary" });
  assert.ok(ordinaryMatch);
  assert.equal(ordinaryMatch.rule.run.mode, "command");
  assert.equal(ordinaryMatch.rule.run.command, "echo autorun");
});

test("all predicates must pass and a mismatched pane cwd does not use workspace cwd", () => {
  const normalized = normalizeConfig({
    rules: [
      {
        name: "fully constrained rule",
        when: {
          repo_name: "backend",
          repo_root: "/repo/backend",
          cwd_glob: "/workspace/**/backend",
          tab_label: "^scratch-[0-9]+$",
          workspace_label: ["development", "shared"],
          invocation_source: ["api", "action"],
          is_linked_worktree: false,
        },
        run: { mode: "skip" },
      },
    ],
  });

  assert.equal(normalized.errors.length, 0);

  const baseContext = {
    repo_name: "backend",
    repo_root: "/repo/backend",
    cwd: "/workspace/team/backend",
    workspace_cwd: "/workspace/backend",
    tab_label: "scratch-42",
    workspace_label: "development",
    invocation_source: "api",
    is_linked_worktree: false,
  };
  assert.ok(matchingRule(normalized, baseContext));

  const mismatches = [
    ["repo_name", "frontend"],
    ["repo_root", "/repo/frontend"],
    ["tab_label", "manual"],
    ["workspace_label", "production"],
    ["invocation_source", "startup"],
    ["is_linked_worktree", true],
  ];
  for (const [key, value] of mismatches) {
    assert.equal(
      matchingRule(normalized, { ...baseContext, [key]: value }),
      null,
      `${key} should be required in addition to every other predicate`,
    );
  }

  assert.equal(
    matchingRule(normalized, {
      ...baseContext,
      cwd: "/tmp/other-project",
      workspace_cwd: "/workspace/backend",
    }),
    null,
  );

  const withoutPaneCwd = { ...baseContext };
  delete withoutPaneCwd.cwd;
  assert.ok(matchingRule(normalized, withoutPaneCwd));
});

test("worktree predicates require actual boolean status and preserve first-match fallback", () => {
  const normalized = normalizeConfig({
    rules: [
      { name: "linked", when: { is_linked_worktree: true }, run: { mode: "skip" } },
      { name: "unlinked", when: { is_linked_worktree: false }, run: { mode: "skip" } },
      { name: "fallback", run: { mode: "command", command: "echo fallback" } },
    ],
  });
  assert.equal(normalized.errors.length, 0);

  for (const [status, expected] of [
    [true, "linked"],
    [false, "unlinked"],
    [undefined, "fallback"],
    [null, "fallback"],
    [0, "fallback"],
    [1, "fallback"],
    ["false", "fallback"],
  ]) {
    const context = status === undefined ? {} : { is_linked_worktree: status };
    assert.equal(matchingRule(normalized, context)?.rule.name, expected);
  }
});

test("only plain and null-prototype objects are configuration tables", () => {
  const table = (entries) => Object.assign(Object.create(null), entries);
  const normalized = normalizeConfig(table({
    defaults: table({ enabled: false }),
    rules: [table({
      when: table({ repo_name: "protected" }),
      run: table({ mode: "skip" }),
    })],
  }));
  assert.equal(normalized.errors.length, 0);
  assert.equal(normalized.defaults.enabled, false);
  assert.equal(matchingRule(normalized, table({ repo_name: "protected" }))?.rule.run.mode, "skip");

  const customTable = Object.assign(Object.create({ inherited: true }), { mode: "skip", repo_name: "protected" });
  for (const rejected of [new Date("2024-01-01"), [], customTable]) {
    assert.ok(normalizeConfig(rejected).errors.length > 0);
    assert.ok(normalizeConfig({ defaults: rejected }).errors.length > 0);
    assert.equal(normalizeConfig({ rules: [rejected] }).rules.length, 0);
    assert.equal(normalizeConfig({ rules: [{ when: rejected, run: { mode: "skip" } }] }).rules.length, 0);
    assert.equal(normalizeConfig({ rules: [{ when: {}, run: rejected }] }).rules.length, 0);
  }
  assert.equal(matchingRule(normalized, customTable), null);
});

test("parsed TOML dates cannot stand in for defaults, when, or run tables", () => {
  const defaults = normalizeConfig(parseToml(`
defaults = 2024-01-01
[[rules]]
[rules.run]
mode = "skip"
`));
  assert.ok(defaults.errors.length > 0);
  assert.equal(defaults.defaults.enabled, true);
  assert.equal(defaults.rules.length, 1);

  const when = normalizeConfig(parseToml(`
[[rules]]
name = "date predicate"
when = 2024-01-01
[rules.run]
mode = "skip"
[[rules]]
name = "fallback"
[rules.run]
mode = "command"
command = "echo fallback"
`));
  assert.ok(when.errors.length > 0);
  assert.equal(when.rules.length, 1);
  assert.equal(matchingRule(when, {})?.rule.name, "fallback");

  const run = normalizeConfig(parseToml(`
[[rules]]
name = "date action"
run = 2024-01-01
[[rules]]
name = "fallback"
[rules.run]
mode = "skip"
`));
  assert.ok(run.errors.length > 0);
  assert.equal(run.rules.length, 1);
  assert.equal(matchingRule(run, {})?.rule.name, "fallback");
});

test("cwd globs with **/ match zero directories and nested directories", () => {
  const normalized = normalizeConfig({
    rules: [
      {
        name: "source tree",
        when: { cwd_glob: "/workspace/**/src" },
        run: { mode: "skip" },
      },
    ],
  });

  assert.equal(normalized.errors.length, 0);
  assert.ok(matchingRule(normalized, { cwd: "/workspace/src" }));
  assert.ok(matchingRule(normalized, { cwd: "/workspace/team/project/src" }));
  assert.equal(matchingRule(normalized, { cwd: "/workspace/team/project/lib" }), null);
  assert.equal(matchingRule(normalized, { cwd: "/workspace/team/project/src/nested" }), null);
});

test("malformed skip rules and unknown configuration keys are rejected", () => {
  const normalized = normalizeConfig({
    defaults: {
      enabled: true,
      typo_default: false,
    },
    rules: [
      {
        name: "skip with command payload",
        when: { repo_name: "protected" },
        run: { mode: "skip", command: "echo must not be accepted" },
      },
      {
        name: "skip with a when typo",
        when: { whne: { repo_name: "protected" } },
        run: { mode: "skip" },
      },
      {
        name: "skip with a rule typo",
        whne: { repo_name: "protected" },
        run: { mode: "skip" },
      },
      {
        name: "valid broad command",
        run: { mode: "command", command: "echo broad" },
      },
    ],
  });

  assert.ok(normalized.errors.some((error) => error.includes("defaults.typo_default")));
  assert.ok(normalized.errors.some((error) => error.includes("rules[0].run.command")));
  assert.ok(normalized.errors.some((error) => error.includes("rules[1].when.whne")));
  assert.ok(normalized.errors.some((error) => error.includes("rules[2].whne")));
});

test("multiline TOML arrays and a literal regex string parse and match", () => {
  const parsed = parseToml(`
[defaults]
enabled = true

[[rules]]
name = "TOML matcher"
[rules.when]
repo_name = [
  "frontend",
  "backend",
]
workspace_label = [
  "development",
  "shared",
]
tab_label = '^scratch[.]dev$'
[rules.run]
mode = "skip"
`);
  const normalized = normalizeConfig(parsed);

  assert.equal(normalized.errors.length, 0);
  assert.ok(
    matchingRule(normalized, {
      repo_name: "backend",
      workspace_label: "shared",
      tab_label: "scratch.dev",
    }),
  );
  assert.equal(
    matchingRule(normalized, {
      repo_name: "backend",
      workspace_label: "shared",
      tab_label: "scratchXdev",
    }),
    null,
  );
  assert.equal(
    matchingRule(normalized, {
      repo_name: "unrelated",
      workspace_label: "shared",
      tab_label: "scratch.dev",
    }),
    null,
  );
});

test("autorun hook rejects invalid rules before attempting Herdr", (t) => {
  const invalidRules = [
    `[[rules]]
name = "invalid restrictive skip"
whne = { repo_name = "protected" }
[rules.run]
mode = "skip"`,
    `[[rules]]
name = "date condition"
when = 2024-01-01
[rules.run]
mode = "skip"`,
  ];
  for (const invalidRule of invalidRules) {
    const root = temporaryDirectory("herdr-config-hook-");
    const configDir = path.join(root, "config");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    fs.writeFileSync(
      path.join(configDir, "rules.toml"),
      `${invalidRule}

[[rules]]
name = "broad command"
[rules.run]
mode = "command"
command = "echo SHOULD_NOT_RUN"
`,
      "utf8",
    );

    const result = spawnSync(process.execPath, [hookPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HERDR_BIN_PATH: path.join(root, "missing", "herdr"),
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_PLUGIN_EVENT: "tab.created",
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
          workspace_id: "workspace",
          workspace_cwd: "/workspace",
          tab_id: "tab-invalid-config",
          focused_pane_id: "pane-invalid-config",
          focused_pane_cwd: "/workspace/protected",
        }),
        HERDR_PLUGIN_EVENT_JSON: JSON.stringify({
          event: "tab.created",
          data: {
            tab: {
              tab_id: "tab-invalid-config",
              workspace_id: "workspace",
            },
          },
        }),
        HERDR_WORKSPACE_ID: "workspace",
        HERDR_TAB_ID: "tab-invalid-config",
        HERDR_PANE_ID: "pane-invalid-config",
      },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    assert.equal(result.status, 1);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.match(output, /\"msg\":\"config_error\"/);
    assert.doesNotMatch(output, /\"msg\":\"injection_failed\"/);
    assert.doesNotMatch(output, /\"msg\":\"autorun\"/);
    assert.doesNotMatch(output, /\"msg\":\"no_pane\"/);
    assert.doesNotMatch(output, /SHOULD_NOT_RUN/);
  }
});

test("loadConfig reports malformed TOML without throwing", (t) => {
  const root = temporaryDirectory("herdr-config-load-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "rules.toml"), "[rules\n", "utf8");

  const loaded = loadConfig(root);
  assert.equal(loaded.exists, true);
  assert.ok(loaded.errors.length > 0);
  assert.equal(typeof loaded.errors[0], "string");
});
