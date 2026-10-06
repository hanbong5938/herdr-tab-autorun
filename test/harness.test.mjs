import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonical, cleanupOwnedPanes, createdPane, inside, observedBusyForeground, paneOutput,
  registerOwnedTerminal, restoreOriginalFocus,
} from "./harness.mjs";

test("canonical resolves aliases and missing descendants under the real ancestor", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "autorun-harness-path-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "root");
  fs.mkdirSync(root);
  const alias = path.join(temp, "alias");
  fs.symlinkSync(root, alias, "dir");
  assert.equal(canonical(path.join(alias, "config", "rules.toml")), path.join(fs.realpathSync(root), "config", "rules.toml"));
  assert.equal(inside(root, path.join(alias, "config", "rules.toml")), true);
  assert.equal(inside(alias, path.join(root, "socket.sock")), true);
});

test("inside rejects sibling-prefix paths and internal symlink escapes", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "autorun-harness-path-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "root");
  const sibling = path.join(temp, "root-elsewhere");
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);
  fs.symlinkSync(sibling, path.join(root, "escape"), "dir");
  assert.equal(inside(root, path.join(root, "config", "missing.toml")), true);
  assert.equal(inside(root, path.join(sibling, "socket.sock")), false);
  assert.equal(inside(root, path.join(root, "escape", "missing", "socket.sock")), false);
});

test("canonical propagates errors other than missing leaf", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "autorun-harness-path-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, "file");
  fs.writeFileSync(file, "not a directory");
  assert.throws(() => canonical(path.join(file, "socket.sock")), { code: "ENOTDIR" });
  assert.throws(() => inside(temp, path.join(file, "socket.sock")), { code: "ENOTDIR" });
});

function inventory(initialPanes, { workspaceId = "owned", keepEmptyWorkspace = false } = {}) {
  let currentPanes = initialPanes.map((pane) => ({ ...pane }));
  const currentWorkspaces = new Set(currentPanes.map((pane) => pane.workspace_id));
  currentWorkspaces.add(workspaceId);
  const api = {
    listPanes: () => currentPanes.map((pane) => ({ ...pane })),
    listWorkspaces: () => [...currentWorkspaces].map((id) => ({ workspace_id: id })),
    closePane: (paneId) => {
      const index = currentPanes.findIndex((pane) => pane.pane_id === paneId);
      if (index < 0) throw new Error("attempted to close an absent pane");
      const [removed] = currentPanes.splice(index, 1);
      if (!keepEmptyWorkspace && !currentPanes.some((pane) => pane.workspace_id === removed.workspace_id)) {
        currentWorkspaces.delete(removed.workspace_id);
      }
      return { ok: true };
    },
    waitFor: (check) => check(),
  };
  return {
    api,
    panes: () => currentPanes.map((pane) => ({ ...pane })),
    workspaces: () => [...currentWorkspaces],
    replacePanes: (panes) => { currentPanes = panes.map((pane) => ({ ...pane })); },
  };
}

function owned(paneId, terminalId, tabId = "tracked") {
  return { pane_id: paneId, terminal_id: terminalId, tab_id: tabId, workspace_id: "owned" };
}

test("registers only newly created terminals with complete identity in the intended workspace", () => {
  const identities = new Set();
  const existing = new Set(["caller-terminal"]);
  const root = owned("root", "root-terminal");
  assert.equal(registerOwnedTerminal(root, "owned", identities, existing), root.terminal_id);
  assert.deepEqual([...identities], ["root-terminal"]);
  for (const pane of [
    owned("caller-pane", "caller-terminal"),
    root,
    { ...root, terminal_id: "" },
    { ...root, terminal_id: null },
    { ...root, pane_id: "" },
    { ...root, tab_id: null },
    { ...root, workspace_id: "caller-workspace" },
  ]) {
    assert.throws(() => registerOwnedTerminal(pane, "owned", identities, existing));
  }
  assert.throws(() => registerOwnedTerminal(root, "owned", identities, new Set()));
  assert.deepEqual([...identities], ["root-terminal"]);
});

test("creation inventory failure retains response-proven ownership for cleanup", () => {
  const created = owned("created-pane", "created-terminal");
  const identities = new Set();
  const state = inventory([created]);
  assert.throws(() => createdPane(created, created.tab_id, "owned", new Set(), identities, {
    listPanes: () => { throw new Error("inventory unavailable"); },
    waitFor: (check) => check(),
  }));
  assert.deepEqual([...identities], [created.terminal_id]);
  const failures = [];
  assert.equal(cleanupOwnedPanes("owned", identities, failures, state.api).retainedResources, false);
  assert.deepEqual(failures, []);
  assert.deepEqual(state.panes(), []);
});

test("creation visibility timeout retains response-proven ownership for cleanup", () => {
  const created = owned("created-pane", "created-terminal");
  const identities = new Set();
  const state = inventory([created]);
  assert.throws(() => createdPane(created, created.tab_id, "owned", new Set(), identities, {
    listPanes: () => [],
    waitFor: (check) => check(),
  }));
  assert.deepEqual([...identities], [created.terminal_id]);
  const failures = [];
  assert.equal(cleanupOwnedPanes("owned", identities, failures, state.api).retainedResources, false);
  assert.deepEqual(failures, []);
  assert.deepEqual(state.panes(), []);
});

test("invalid creation responses never grant ownership despite visible panes", () => {
  const created = owned("created-pane", "created-terminal");
  for (const [response, before, initialOwned] of [
    [{ ...created, pane_id: "" }, new Set(), new Set()],
    [{ ...created, terminal_id: null }, new Set(), new Set()],
    [{ ...created, tab_id: "other-tab" }, new Set(), new Set()],
    [{ ...created, workspace_id: "other-workspace" }, new Set(), new Set()],
    [created, new Set([created.terminal_id]), new Set()],
    [created, new Set(), new Set([created.terminal_id])],
  ]) {
    const identities = new Set(initialOwned);
    assert.throws(() => createdPane(response, created.tab_id, "owned", before, identities, {
      listPanes: () => [response],
      waitFor: (check) => check(),
    }));
    assert.deepEqual(identities, initialOwned);
  }
});

test("creation requires exact visible identity and returns the confirmed pane", () => {
  const created = owned("created-pane", "created-terminal");
  for (const visible of [
    { ...created, pane_id: "other-pane" },
    { ...created, tab_id: "other-tab" },
    { ...created, workspace_id: "other-workspace" },
    { ...created, terminal_id: "other-terminal" },
  ]) {
    const identities = new Set();
    assert.throws(() => createdPane(created, created.tab_id, "owned", new Set(), identities, {
      listPanes: () => [visible],
      waitFor: (check) => check(),
    }));
    assert.deepEqual([...identities], [created.terminal_id]);
  }
  const confirmed = { ...created };
  const identities = new Set();
  assert.equal(createdPane(created, created.tab_id, "owned", new Set(), identities, {
    listPanes: () => [confirmed],
    waitFor: (check) => check(),
  }), confirmed);
  assert.deepEqual([...identities], [created.terminal_id]);
});

test("cleanup closes registered initial, root, and split terminals and confirms automatic workspace deletion", () => {
  const panes = [
    owned("initial", "initial-terminal", "initial-tab"),
    owned("root", "root-terminal"),
    owned("split", "split-terminal"),
  ];
  const state = inventory(panes);
  const identities = new Set();
  registerOwnedTerminal(panes[0], "owned", identities, new Set());
  registerOwnedTerminal(panes[1], "owned", identities, new Set(["initial-terminal"]));
  registerOwnedTerminal(panes[2], "owned", identities, new Set(["initial-terminal", "root-terminal"]));
  const failures = [];
  const result = cleanupOwnedPanes("owned", identities, failures, state.api);
  assert.equal(result.retainedResources, false);
  assert.deepEqual(failures, []);
  assert.deepEqual(state.panes(), []);
  assert.deepEqual(state.workspaces(), []);
});

test("cleanup accepts already absent owned terminals and automatically deleted workspace", () => {
  const state = inventory([]);
  state.api.listWorkspaces = () => [];
  const failures = [];
  assert.equal(cleanupOwnedPanes("owned", new Set(["gone"]), failures, state.api).retainedResources, false);
  assert.deepEqual(failures, []);
  assert.equal(cleanupOwnedPanes(null, new Set(), failures, state.api).retainedResources, false);
  assert.deepEqual(failures, []);
});

test("cleanup preserves foreign terminals in tracked and newly created untracked tabs", () => {
  for (const foreignTab of ["tracked", "new-untracked-tab"]) {
    const foreign = owned("caller-pane", "caller-terminal", foreignTab);
    const state = inventory([owned("root", "root-terminal"), foreign]);
    const failures = [];
    const result = cleanupOwnedPanes("owned", new Set(["root-terminal"]), failures, state.api);
    assert.equal(result.retainedResources, true);
    assert.ok(failures.includes("cleanup"));
    assert.deepEqual(state.panes(), [foreign]);
    assert.deepEqual(state.workspaces(), ["owned"]);
  }
});

test("cleanup preserves an owned terminal moved outside its original workspace", () => {
  const moved = { ...owned("new-pane", "root-terminal", "new-tab"), workspace_id: "caller-workspace" };
  const state = inventory([moved]);
  const failures = [];
  assert.equal(cleanupOwnedPanes("owned", new Set(["root-terminal"]), failures, state.api).retainedResources, true);
  assert.ok(failures.includes("cleanup"));
  assert.deepEqual(state.panes(), [moved]);
});

test("cleanup refuses ambiguous or malformed owned identity and unavailable inventory", () => {
  for (const panes of [
    [owned("p1", "root-terminal"), owned("p2", "root-terminal")],
    [{ ...owned("p1", "root-terminal"), pane_id: null }],
  ]) {
    const state = inventory(panes);
    const failures = [];
    assert.equal(cleanupOwnedPanes("owned", new Set(["root-terminal"]), failures, state.api).retainedResources, true);
    assert.ok(failures.includes("cleanup"));
    assert.deepEqual(state.panes(), panes);
  }
  const state = inventory([owned("root", "root-terminal")]);
  const failures = [];
  assert.equal(cleanupOwnedPanes("owned", new Set(["root-terminal"]), failures, {
    ...state.api,
    listPanes: () => { throw new Error("inventory unavailable"); },
  }).retainedResources, true);
  assert.ok(failures.includes("cleanup"));
  assert.deepEqual(state.panes(), [owned("root", "root-terminal")]);
});

test("cleanup retains unknown workspace contents and unavailable workspace inventory", () => {
  const unknown = { ...owned("unknown", "unknown-terminal", "new-tab"), terminal_id: null };
  const state = inventory([owned("root", "root-terminal"), unknown]);
  const failures = [];
  assert.equal(cleanupOwnedPanes("owned", new Set(["root-terminal"]), failures, state.api).retainedResources, true);
  assert.ok(failures.includes("cleanup"));
  assert.ok(state.panes().some((pane) => pane.pane_id === unknown.pane_id && pane.terminal_id === null));
  const unavailable = inventory([owned("root", "root-terminal")]);
  const unavailableFailures = [];
  assert.equal(cleanupOwnedPanes("owned", new Set(["root-terminal"]), unavailableFailures, {
    ...unavailable.api,
    listWorkspaces: () => { throw new Error("workspace inventory unavailable"); },
  }).retainedResources, true);
  assert.ok(unavailableFailures.includes("cleanup"));
});

test("cleanup rechecks terminal identity and workspace before closing a pane ID", () => {
  for (const replacement of [
    owned("same-pane", "foreign-terminal"),
    { ...owned("same-pane", "root-terminal"), workspace_id: "caller-workspace" },
  ]) {
    const state = inventory([owned("same-pane", "root-terminal")]);
    const failures = [];
    let reads = 0;
    const result = cleanupOwnedPanes("owned", new Set(["root-terminal"]), failures, {
      ...state.api,
      listPanes: () => {
        if (++reads === 2) state.replacePanes([replacement]);
        return state.api.listPanes();
      },
    });
    assert.equal(result.retainedResources, true);
    assert.ok(failures.includes("cleanup"));
    assert.deepEqual(state.panes(), [replacement]);
  }
});

test("cleanup retains a workspace that remains present even after its last pane closes", () => {
  const state = inventory([owned("root", "root-terminal")], { keepEmptyWorkspace: true });
  const failures = [];
  assert.equal(cleanupOwnedPanes("owned", new Set(["root-terminal"]), failures, state.api).retainedResources, true);
  assert.ok(failures.includes("cleanup"));
  assert.deepEqual(state.panes(), []);
  assert.deepEqual(state.workspaces(), ["owned"]);
});

test("cleanup accepts confirmed pane-not-found only, not other failed closes", () => {
  for (const [code, accepted] of [["pane_not_found", true], ["permission_denied", false]]) {
    const state = inventory([owned("root", "root-terminal")]);
    const failures = [];
    const result = cleanupOwnedPanes("owned", new Set(["root-terminal"]), failures, {
      ...state.api,
      closePane: (id) => {
        state.api.closePane(id);
        return { ok: false, status: 1, stdout: "", stderr: JSON.stringify({ error: { code } }) };
      },
    });
    assert.equal(result.retainedResources, !accepted);
    assert.deepEqual(failures, accepted ? [] : ["cleanup"]);
    assert.deepEqual(state.panes(), []);
  }
});

test("failed pane reads never count as absent markers; successful marker remains observable", () => {
  for (const stdout of ["", "AUTORUN_OK"]) {
    assert.throws(() => paneOutput("pane", {
      readPane: () => ({ ok: false, stdout, stderr: "read failed", status: 1 }),
    }));
  }
  assert.match(paneOutput("pane", {
    readPane: () => ({ ok: true, stdout: "AUTORUN_OK", json: null }),
  }), /AUTORUN_OK/);
});

test("busy foreground requires a successful observation and distinct valid process IDs", () => {
  const observed = (shell_pid, foreground_process_group_id, ok = true) =>
    observedBusyForeground({ ok, json: { result: { process_info: { shell_pid, foreground_process_group_id } } } });
  assert.equal(observed(123, undefined), null);
  assert.equal(observed(123, null), null);
  for (const id of [0, -1, 1.5, "456", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(observed(123, id), null);
    assert.equal(observed(id, 456), null);
  }
  assert.equal(observed(123, 456, false), null);
  assert.equal(observed(123, 123), null);
  assert.deepEqual(observed(123, 456), { shell_pid: 123, foreground_process_group_id: 456 });
});

test("restores the original terminal after a move to another tab in the same workspace", () => {
  const original = { pane_id: "p1", terminal_id: "terminal-original", tab_id: "old-tab", workspace_id: "w1" };
  const unrelated = { pane_id: "other", terminal_id: "terminal-other", tab_id: "old-tab", workspace_id: "w1" };
  const moved = { ...original, tab_id: "new-tab" };
  let selected = unrelated;
  const failures = [];
  restoreOriginalFocus(original, failures, {
    listPanes: () => [unrelated, moved],
    focus: (paneId, tabId, workspaceId) => {
      selected = [unrelated, moved].find((pane) =>
        pane.pane_id === paneId && pane.tab_id === tabId && pane.workspace_id === workspaceId);
      assert.ok(selected, "focus must use the current pane scope");
    },
  });
  assert.deepEqual(failures, []);
  assert.equal(selected, moved);
});

test("restores the original terminal after its pane ID and workspace change", () => {
  const original = { pane_id: "old-pane", terminal_id: "terminal-original", tab_id: "old-tab", workspace_id: "old-workspace" };
  const unrelated = { pane_id: "old-pane", terminal_id: "terminal-other", tab_id: "old-tab", workspace_id: "old-workspace" };
  const moved = { pane_id: "new-pane", terminal_id: original.terminal_id, tab_id: "new-tab", workspace_id: "new-workspace" };
  let selected = unrelated;
  const failures = [];
  restoreOriginalFocus(original, failures, {
    listPanes: () => [unrelated, moved],
    focus: (paneId, tabId, workspaceId) => {
      selected = [unrelated, moved].find((pane) =>
        pane.pane_id === paneId && pane.tab_id === tabId && pane.workspace_id === workspaceId);
      assert.ok(selected, "focus must use the current pane scope");
    },
  });
  assert.deepEqual(failures, []);
  assert.equal(selected, moved);
});

test("closed original with reused pane ID leaves a different selected pane selected", () => {
  const original = { pane_id: "old", terminal_id: "closed-terminal", tab_id: "old-tab", workspace_id: "old-workspace" };
  const unrelated = { pane_id: "first", terminal_id: "other-terminal", tab_id: "tab", workspace_id: "workspace" };
  const reused = { pane_id: "old", terminal_id: "new-terminal", tab_id: "new-tab", workspace_id: "workspace" };
  const current = { pane_id: "current", terminal_id: "current-terminal", tab_id: "tab", workspace_id: "workspace" };
  const panes = [unrelated, reused, current];
  let selected = current;
  const failures = [];
  restoreOriginalFocus(original, failures, {
    listPanes: () => panes,
    focus: (paneId, tabId, workspaceId) => {
      selected = panes.find((pane) => pane.pane_id === paneId && pane.tab_id === tabId &&
        pane.workspace_id === workspaceId);
    },
  });
  assert.equal(selected, current);
  assert.deepEqual(failures, []);
});

test("identityless original falls back to its exact pane ID and current scope", () => {
  const unrelated = { pane_id: "other", terminal_id: "other-terminal", tab_id: "tab", workspace_id: "workspace" };
  const fallback = { pane_id: "old", terminal_id: "new-terminal", tab_id: "new-tab", workspace_id: "new-workspace" };
  const panes = [unrelated, fallback];
  let selected = unrelated;
  const failures = [];
  restoreOriginalFocus({ pane_id: "old", tab_id: "old-tab", workspace_id: "old-workspace" }, failures, {
    listPanes: () => panes,
    focus: (paneId, tabId, workspaceId) => {
      selected = panes.find((pane) => pane.pane_id === paneId && pane.tab_id === tabId &&
        pane.workspace_id === workspaceId);
    },
  });
  assert.equal(selected, fallback);
  assert.deepEqual(failures, []);
});

test("null original focus leaves the current pane unchanged", () => {
  const current = owned("current", "caller-terminal");
  let selected = current;
  const failures = [];
  restoreOriginalFocus(null, failures, {
    listPanes: () => { throw new Error("null original must not need inventory"); },
    focus: () => { selected = null; },
  });
  assert.equal(selected, current);
  assert.deepEqual(failures, []);
});

test("ambiguous or malformed original lookup records cleanup failure without changing focus", () => {
  const original = { pane_id: "old", terminal_id: "terminal", tab_id: "old-tab", workspace_id: "old-workspace" };
  const moved = { pane_id: "new", terminal_id: "terminal", tab_id: "new-tab", workspace_id: "new-workspace" };
  const failures = [];
  let selected = "unrelated";
  const focus = () => { selected = "changed"; };
  restoreOriginalFocus(original, failures, { listPanes: () => [original, moved], focus });
  restoreOriginalFocus(original, failures, { listPanes: () => [{ ...moved, workspace_id: null }], focus });
  restoreOriginalFocus(original, failures, { listPanes: () => { throw new Error("pane list unavailable"); }, focus });
  assert.deepEqual(failures, ["cleanup", "cleanup", "cleanup"]);
  assert.equal(selected, "unrelated");
});

test("failed original focus does not prevent independent owned-pane cleanup", () => {
  const original = { pane_id: "old", terminal_id: "caller-terminal", tab_id: "tab", workspace_id: "caller-workspace" };
  const ownedPane = owned("root", "root-terminal");
  const state = inventory([original, ownedPane]);
  const failures = [];
  let selected = original;
  restoreOriginalFocus(original, failures, {
    listPanes: state.api.listPanes,
    focus: () => { throw new Error("cannot select surviving terminal"); },
  });
  const result = cleanupOwnedPanes("owned", new Set([ownedPane.terminal_id]), failures, state.api);
  assert.equal(result.retainedResources, false);
  assert.deepEqual(failures, ["cleanup"]);
  assert.equal(selected, original);
  assert.deepEqual(state.panes(), [original]);
  assert.deepEqual(state.workspaces(), ["caller-workspace"]);
});
