import path from "node:path";

import { loadConfig, normalizeConfig } from "../config.mjs";
import { buildContext, decide } from "../autorun.mjs";
import {
  herdrBin,
  paneHasAgent,
  paneList,
  paneProcessInfo,
  stateDir,
} from "../herdr.mjs";

function configDirectory() {
  return process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(process.cwd(), "config");
}

function printValue(value) {
  return JSON.stringify(value);
}

function printDecision(decision) {
  console.log("decision:");
  console.log(`  action: ${decision.action}`);
  console.log(`  reason: ${decision.reason}`);
  if (decision.rule) {
    console.log(`  matched rule: ${decision.rule.name} (index ${decision.index})`);
    console.log(`  run: ${printValue(decision.rule.run || {})}`);
  } else {
    console.log("  matched rule: none");
    console.log("  run: none");
  }
}

function main() {
  const configDir = configDirectory();
  const loaded = loadConfig(configDir);
  const normalized = normalizeConfig(loaded.config || {});
  const configErrors = [
    ...(Array.isArray(loaded.errors) ? loaded.errors : []),
    ...(Array.isArray(normalized.errors) ? normalized.errors : []),
  ];

  console.log(`plugin id: ${process.env.HERDR_PLUGIN_ID || "(unset)"}`);
  console.log(`herdr bin path: ${herdrBin()}`);
  console.log(`config dir: ${configDir}`);
  console.log(`state dir: ${stateDir()}`);
  console.log(`config path: ${loaded.path || path.join(configDir, "rules.toml")}`);
  console.log(`config exists: ${loaded.exists ? "yes" : "no"}`);

  for (const error of configErrors) {
    console.log(`error: ${error}`);
  }

  console.log("effective defaults:");
  for (const [key, value] of Object.entries(normalized.defaults || {})) {
    console.log(`  ${key}: ${printValue(value)}`);
  }

  const context = buildContext(process.env);
  console.log("context:");
  console.log(JSON.stringify(context, null, 2));

  const decision = decide(context, normalized);
  printDecision(decision);

  const paneId = context?.pane_id || context?.focused_pane_id;
  console.log("pane readiness:");
  console.log(`  pane id: ${paneId || "(unresolved)"}`);
  if (paneId) {
    console.log(`  process info: ${printValue(paneProcessInfo(paneId))}`);
    console.log(`  has agent: ${paneHasAgent(paneId) ? "true" : "false"}`);
  } else {
    console.log("  process info: null");
    console.log("  has agent: false");
  }

  // loadConfig errors represent a parse failure. Normalization errors are
  // diagnostics, but do not make the doctor command fail.
  const parseFailed = loaded.exists &&
    Array.isArray(loaded.errors) &&
    loaded.errors.length > 0;
  return parseFailed ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
