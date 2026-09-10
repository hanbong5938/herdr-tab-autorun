import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as fsp from "node:fs/promises";
import os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const herdrModuleUrl = pathToFileURL(path.join(repoRoot, "src", "herdr.mjs")).href;
const activeChildren = new Set();
let barrierSequence = 0;

const childCode = `
import fs from "node:fs";
import path from "node:path";
import { claimTab, rateLimit } from ${JSON.stringify(herdrModuleUrl)};

const barrier = process.env.HERDR_TEST_BARRIER;
const childId = process.env.HERDR_TEST_ID;
if (barrier && childId) {
  fs.writeFileSync(path.join(barrier, "ready-" + childId), "ready");
  const release = path.join(barrier, "go");
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(release)) {
    Atomics.wait(waitBuffer, 0, 0, 2);
  }
}

const key = process.env.HERDR_TEST_KEY || "terminal-key";
const action = process.env.HERDR_TEST_ACTION || "claim";
const count = Number(process.env.HERDR_TEST_COUNT || "3");
const windowMs = Number(process.env.HERDR_TEST_WINDOW_MS || "10000");
let result;
if (action === "claim") {
  result = claimTab(key);
} else if (action === "rate") {
  result = rateLimit({ count, windowMs });
} else if (action === "both") {
  result = { claim: claimTab(key), rate: rateLimit({ count, windowMs }) };
} else {
  throw new Error("unknown test action");
}
process.stdout.write(JSON.stringify(result));
`;

function launchChild({ stateDir, socketPath, key, action, count = 3, windowMs = 10_000, barrier, id }) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HERDR_PLUGIN_STATE_DIR: stateDir,
      HERDR_SOCKET_PATH: socketPath,
      HERDR_TEST_BARRIER: barrier,
      HERDR_TEST_ID: String(id),
      HERDR_TEST_KEY: key,
      HERDR_TEST_ACTION: action,
      HERDR_TEST_COUNT: String(count),
      HERDR_TEST_WINDOW_MS: String(windowMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const record = { child, promise: null };
  record.promise = new Promise((resolve, reject) => {
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      activeChildren.delete(record);
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`state child exited with code ${code ?? "null"} (${signal ?? "no signal"}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`state child returned invalid JSON: ${stdout || stderr}`, { cause: error }));
      }
    });
  });
  record.promise.catch(() => {});
  activeChildren.add(record);
  return record;
}

async function waitForChildrenReady(barrier, count) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const entries = await fsp.readdir(barrier);
    if (entries.filter((entry) => entry.startsWith("ready-")).length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${count} state children to initialize`);
}

async function runConcurrent(root, specifications) {
  const barrier = path.join(root, `barrier-${barrierSequence++}`);
  await fsp.mkdir(barrier);
  const records = specifications.map((specification, id) => launchChild({
    ...specification,
    barrier,
    id,
  }));
  await waitForChildrenReady(barrier, records.length);
  await fsp.writeFile(path.join(barrier, "go"), "go");
  return Promise.all(records.map(({ promise }) => promise));
}

async function cleanupChildren() {
  const records = [...activeChildren];
  for (const { child } of records) {
    child.kill("SIGKILL");
  }
  await Promise.allSettled(records.map(({ promise }) => promise));
}

async function withTemporaryRoot(callback) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "herdr-state-test-"));
  try {
    return await callback(root);
  } finally {
    await cleanupChildren();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function claimSpecifications(count, stateDir, socketPath, key = "terminal-key") {
  return Array.from({ length: count }, () => ({
    stateDir,
    socketPath,
    key,
    action: "claim",
  }));
}

test("concurrent claimTab allows exactly one claim for a terminal key", async () => {
  await withTemporaryRoot(async (root) => {
    const stateDir = path.join(root, "state");
    const socketPath = path.join(root, "fake-herdr.sock");
    const results = await runConcurrent(root, claimSpecifications(24, stateDir, socketPath));

    assert.equal(results.length, 24);
    assert.ok(results.every((result) => typeof result === "boolean"));
    assert.equal(results.filter(Boolean).length, 1);
  });
});

test("separate socket namespaces each allow the same terminal key", async () => {
  await withTemporaryRoot(async (root) => {
    const stateDir = path.join(root, "state");
    const socketPaths = [path.join(root, "fake-herdr-a.sock"), path.join(root, "fake-herdr-b.sock")];
    const specifications = Array.from({ length: 24 }, (_, index) => ({
      stateDir,
      socketPath: socketPaths[index % socketPaths.length],
      key: "terminal-key",
      action: "claim",
    }));
    const results = await runConcurrent(root, specifications);

    assert.ok(results.every((result) => typeof result === "boolean"));
    assert.equal(results.filter(Boolean).length, 2);
    for (const socketPath of socketPaths) {
      const namespaceResults = results.filter((_, index) => specifications[index].socketPath === socketPath);
      assert.equal(namespaceResults.filter(Boolean).length, 1);
    }
  });
});

test("concurrent rateLimit allows exactly three operations in a ten-second window", async () => {
  await withTemporaryRoot(async (root) => {
    const stateDir = path.join(root, "state");
    const socketPath = path.join(root, "fake-herdr-rate.sock");
    const specifications = Array.from({ length: 24 }, () => ({
      stateDir,
      socketPath,
      key: "rate-limit-key",
      action: "rate",
      count: 3,
      windowMs: 10_000,
    }));
    const results = await runConcurrent(root, specifications);

    assert.equal(results.length, specifications.length);
    assert.ok(results.every((result) => typeof result === "boolean"));
    assert.equal(results.filter(Boolean).length, 3);
  });
});

test("regular-file state fails closed for claim and rate-limited execution", async () => {
  await withTemporaryRoot(async (root) => {
    const stateFile = path.join(root, "state-file");
    const socketPath = path.join(root, "fake-herdr-unwritable.sock");
    await fsp.writeFile(stateFile, "not a directory");
    const specifications = Array.from({ length: 8 }, () => ({
      stateDir: stateFile,
      socketPath,
      key: "terminal-key",
      action: "both",
      count: 3,
      windowMs: 10_000,
    }));
    const results = await runConcurrent(root, specifications);

    assert.ok(results.every((result) => result && result.claim === false && result.rate === false));
    assert.equal(results.filter((result) => result.claim || result.rate).length, 0);
  });
});
