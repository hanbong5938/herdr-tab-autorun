import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseTomlDocument } from "smol-toml";

/** Default timing, enablement, restore, and rate-limit settings. */
export const DEFAULTS = {
  ready_timeout_ms: 8000,
  poll_interval_ms: 60,
  total_timeout_ms: 15000,
  enabled: true,
  rate_limit_count: 5,
  rate_limit_window_ms: 10000,
};

const DEFAULT_NUMBER_KEYS = new Set([
  "ready_timeout_ms",
  "poll_interval_ms",
  "total_timeout_ms",
  "rate_limit_count",
  "rate_limit_window_ms",
]);
const WHEN_STRING_KEYS = new Set([
  "repo_name",
  "repo_root",
  "workspace_label",
  "invocation_source",
]);
const WHEN_KEYS = new Set([
  ...WHEN_STRING_KEYS,
  "cwd_glob",
  "tab_label",
  "is_linked_worktree",
]);
const RUN_MODES = new Set(["command", "agent", "skip"]);
const AGENT_KINDS = new Set([
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "devin",
  "agy",
  "cline",
  "omp",
  "mastracode",
  "opencode",
  "copilot",
  "kimi",
  "kiro",
  "droid",
  "amp",
  "grok",
  "hermes",
  "kilo",
  "qodercli",
  "qwen",
  "maki",
  "muse",
]);
const TOP_LEVEL_KEYS = new Set(["defaults", "rules"]);
const RULE_KEYS = new Set(["name", "when", "run"]);
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function runKeysForMode(mode) {
  if (mode === "command") {
    return new Set(["mode", "command"]);
  }
  if (mode === "agent") {
    return new Set(["mode", "kind", "name", "agent_args", "prompt"]);
  }
  return new Set(["mode"]);
}

function validateKeys(object, allowed, prefix, errors) {
  let valid = true;
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      errors.push(`${prefix}.${key} is unknown; rule dropped`);
      valid = false;
    }
  }
  return valid;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isTable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configErrorLine(error) {
  return error && Number.isInteger(error.line) && error.line > 0 ? error.line : 1;
}

/**
 * Parse the rules file with a complete TOML implementation.
 * @param {string} text TOML source text.
 * @returns {object} Parsed TOML table.
 * @throws {Error} For invalid TOML syntax, with a rules.toml line prefix.
 */
export function parseToml(text) {
  try {
    return parseTomlDocument(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`rules.toml:${configErrorLine(error)}: ${message}`);
  }
}

/**
 * Load rules.toml from a plugin configuration directory without throwing.
 * @param {string} configDir Directory containing rules.toml.
 * @returns {{path: string, exists: boolean, config: object, errors: string[]}} Load result.
 */
export function loadConfig(configDir) {
  let configPath = "rules.toml";
  try {
    if (typeof configDir !== "string") {
      throw new TypeError("config directory must be a string");
    }
    configPath = path.join(configDir, "rules.toml");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path: configPath, exists: false, config: {}, errors: [message] };
  }

  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { path: configPath, exists: false, config: {}, errors: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { path: configPath, exists: true, config: {}, errors: [message] };
  }

  try {
    return { path: configPath, exists: true, config: parseToml(text), errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path: configPath, exists: true, config: {}, errors: [message] };
  }
}
function positiveInteger(value) {
  if (typeof value !== "number") {
    return null;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function copyStringOrArray(value) {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.slice();
  }
  return null;
}

function normalizeWhen(rawWhen, ruleIndex, errors) {
  if (rawWhen === undefined) {
    return {};
  }
  if (!isTable(rawWhen)) {
    errors.push(`rules[${ruleIndex}].when must be a table; rule dropped`);
    return null;
  }

  const when = {};
  let valid = true;
  for (const key of Object.keys(rawWhen)) {
    if (!WHEN_KEYS.has(key)) {
      errors.push(`rules[${ruleIndex}].when.${key} is unknown; rule dropped`);
      valid = false;
      continue;
    }
    const value = rawWhen[key];
    if (WHEN_STRING_KEYS.has(key)) {
      const normalized = copyStringOrArray(value);
      if (normalized === null) {
        errors.push(`rules[${ruleIndex}].when.${key} must be a string or an array of strings; rule dropped`);
        valid = false;
      } else {
        when[key] = normalized;
      }
    } else if (key === "cwd_glob" || key === "tab_label") {
      if (typeof value !== "string") {
        errors.push(`rules[${ruleIndex}].when.${key} must be a string; rule dropped`);
        valid = false;
      } else {
        if (key === "tab_label") {
          try {
            new RegExp(value);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`rules[${ruleIndex}].when.tab_label is not a valid regex (${message}); rule dropped`);
            valid = false;
            continue;
          }
        }
        when[key] = value;
      }
    } else if (typeof value !== "boolean") {
      errors.push(`rules[${ruleIndex}].when.is_linked_worktree must be a boolean; rule dropped`);
      valid = false;
    } else {
      when[key] = value;
    }
  }

  return valid ? when : null;
}

function normalizeRule(rawRule, ruleIndex, errors) {
  if (!isTable(rawRule)) {
    errors.push(`rules[${ruleIndex}] must be a table; rule dropped`);
    return null;
  }
  if (!validateKeys(rawRule, RULE_KEYS, `rules[${ruleIndex}]`, errors)) {
    return null;
  }

  const fallbackName = `rule-${ruleIndex + 1}`;
  let name = fallbackName;
  if (hasOwn(rawRule, "name")) {
    if (typeof rawRule.name !== "string") {
      errors.push(`rules[${ruleIndex}].name must be a string; using ${fallbackName}`);
    } else {
      name = rawRule.name;
    }
  }

  const when = normalizeWhen(rawRule.when, ruleIndex, errors);
  if (when === null) {
    return null;
  }

  const rawRun = rawRule.run;
  if (!isTable(rawRun)) {
    errors.push(`rules[${ruleIndex}].run must be a table; rule dropped`);
    return null;
  }

  const mode = rawRun.mode;
  if (typeof mode !== "string") {
    errors.push(`rules[${ruleIndex}].run.mode is required; rule dropped`);
    return null;
  }
  if (!RUN_MODES.has(mode)) {
    errors.push(`rules[${ruleIndex}].run.mode must be command, agent, or skip; rule dropped`);
    return null;
  }
  if (!validateKeys(rawRun, runKeysForMode(mode), `rules[${ruleIndex}].run`, errors)) {
    return null;
  }

  let run;
  if (mode === "skip") {
    run = { mode };
  } else if (mode === "command") {
    if (typeof rawRun.command !== "string" || rawRun.command.trim() === "") {
      errors.push(`rules[${ruleIndex}].run.command must be a non-empty string; rule dropped`);
      return null;
    }
    run = { mode, command: rawRun.command };
  } else {
    if (typeof rawRun.kind !== "string" || !AGENT_KINDS.has(rawRun.kind)) {
      errors.push(`rules[${ruleIndex}].run.kind must be a supported agent kind; rule dropped`);
      return null;
    }
    const agentName = rawRun.name === undefined ? rawRun.kind : rawRun.name;
    if (typeof agentName !== "string" || !AGENT_NAME_PATTERN.test(agentName)) {
      errors.push(`rules[${ruleIndex}].run.name must match /^[a-z][a-z0-9_-]{0,31}$/; rule dropped`);
      return null;
    }
    if (
      hasOwn(rawRun, "agent_args") &&
      (!Array.isArray(rawRun.agent_args) ||
        !rawRun.agent_args.every((argument) => typeof argument === "string"))
    ) {
      errors.push(`rules[${ruleIndex}].run.agent_args must be an array of strings; rule dropped`);
      return null;
    }
    if (hasOwn(rawRun, "prompt") && typeof rawRun.prompt !== "string") {
      errors.push(`rules[${ruleIndex}].run.prompt must be a string; rule dropped`);
      return null;
    }
    run = { mode, kind: rawRun.kind, name: agentName };
    if (hasOwn(rawRun, "agent_args")) {
      run.agent_args = rawRun.agent_args.slice();
    }
    if (hasOwn(rawRun, "prompt")) {
      run.prompt = rawRun.prompt;
    }
  }

  return { name, when, run, index: ruleIndex };
}

/**
 * Validate and normalize raw TOML configuration for runtime consumers.
 * @param {object} raw Parsed configuration object.
 * @returns {{defaults: object, rules: object[], errors: string[]}} Normalized configuration.
 */
export function normalizeConfig(raw) {
  const errors = [];
  const source = isTable(raw) ? raw : {};
  if (!isTable(raw)) {
    errors.push("configuration must be a table; using defaults");
  } else {
    for (const key of Object.keys(source)) {
      if (!TOP_LEVEL_KEYS.has(key)) {
        errors.push(`top-level key '${key}' is unknown; ignored`);
      }
    }
  }

  const defaults = { ...DEFAULTS };
  if (hasOwn(source, "defaults")) {
    const rawDefaults = source.defaults;
    if (!isTable(rawDefaults)) {
      errors.push("defaults must be a table; using defaults");
    } else {
      for (const key of Object.keys(rawDefaults)) {
        if (!hasOwn(DEFAULTS, key)) {
          errors.push(`defaults.${key} is unknown; ignored`);
        }
      }
      for (const key of Object.keys(DEFAULTS)) {
        if (!hasOwn(rawDefaults, key)) {
          continue;
        }
        const value = rawDefaults[key];
        if (key === "enabled") {
          if (typeof value !== "boolean") {
            errors.push(`defaults.${key} must be a boolean; using default`);
          } else {
            defaults[key] = value;
          }
        } else if (DEFAULT_NUMBER_KEYS.has(key)) {
          const number = positiveInteger(value);
          if (number === null) {
            errors.push(`defaults.${key} must be a finite positive safe integer; using default`);
          } else {
            defaults[key] = number;
          }
        }
      }
    }
  }

  if (!hasOwn(source, "rules")) {
    return { defaults, rules: [], errors };
  }
  const rawRules = source.rules;
  if (!Array.isArray(rawRules)) {
    errors.push("rules must be an array of tables; using no rules");
    return { defaults, rules: [], errors };
  }

  const rules = [];
  for (let index = 0; index < rawRules.length; index += 1) {
    const rule = normalizeRule(rawRules[index], index, errors);
    if (rule !== null) {
      rules.push(rule);
    }
  }
  return { defaults, rules, errors };
}

function escapeRegexCharacter(character) {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

function globRegex(pattern) {
  const expanded = pattern.startsWith("~/")
    ? path.join(os.homedir(), pattern.slice(2))
    : pattern;
  let source = "^";
  for (let index = 0; index < expanded.length; index += 1) {
    const character = expanded[index];
    if (character === "*") {
      if (expanded[index + 1] === "*") {
        while (expanded[index + 1] === "*") {
          index += 1;
        }
        if (expanded[index + 1] === "/") {
          source += "(?:.*/)?";
          index += 1;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegexCharacter(character);
    }
  }
  return new RegExp(`${source}$`);
}

function matchesWhen(when, ctx) {
  if (!isTable(when)) {
    return false;
  }

  for (const key of Object.keys(when)) {
    if (WHEN_STRING_KEYS.has(key)) {
      const actual = ctx[key];
      if (actual === undefined || actual === null) {
        return false;
      }
      const expected = when[key];
      if (Array.isArray(expected)) {
        if (!expected.some((candidate) => candidate === actual)) {
          return false;
        }
      } else if (expected !== actual) {
        return false;
      }
      continue;
    }

    if (key === "tab_label") {
      if (ctx.tab_label === undefined || ctx.tab_label === null) {
        return false;
      }
      try {
        if (!new RegExp(when[key]).test(ctx.tab_label ?? "")) {
          return false;
        }
      } catch (error) {
        return false;
      }
      continue;
    }

    if (key === "cwd_glob") {
      if (typeof when[key] !== "string") {
        return false;
      }
      let matcher;
      try {
        matcher = globRegex(when[key]);
      } catch (error) {
        return false;
      }
      const cwd =
        ctx.cwd === undefined || ctx.cwd === null ? ctx.workspace_cwd : ctx.cwd;
      if (typeof cwd !== "string" || !matcher.test(cwd)) {
        return false;
      }
      continue;
    }

    if (key === "is_linked_worktree") {
      if (when[key] !== Boolean(ctx.is_linked_worktree)) {
        return false;
      }
      continue;
    }

    return false;
  }
  return true;
}

/**
 * Return the first normalized rule whose predicates match a flat context.
 * @param {object[]} rules Normalized rules in declaration order.
 * @param {object} ctx Flat runtime context.
 * @returns {{rule: object, index: number}|null} Matching rule and source index, or null.
 */
export function matchRule(rules, ctx) {
  if (!Array.isArray(rules)) {
    return null;
  }
  const context = isTable(ctx) ? ctx : {};
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (!isTable(rule) || !matchesWhen(rule.when ?? {}, context)) {
      continue;
    }
    const sourceIndex = Number.isInteger(rule.index) ? rule.index : index;
    return { rule, index: sourceIndex };
  }
  return null;
}
