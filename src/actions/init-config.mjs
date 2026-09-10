import fs from "node:fs";
import path from "node:path";

const STARTER_CONFIG = `# Herdr tab autorun rules.
# Uncomment and edit a rule to run it for matching tabs.

[defaults]
enabled = true
ready_timeout_ms = 8000
poll_interval_ms = 60
total_timeout_ms = 15000
rate_limit_count = 5
rate_limit_window_ms = 10000

# Example: run lazygit in workspace directories.
# [[rules]]
# name = "lazygit in workspace"
# [rules.when]
# cwd_glob = "~/workspace/**"
# [rules.run]
# mode = "command"
# command = "lazygit"

# Example: start an OMP coding agent and give it an initial prompt.
# [[rules]]
# name = "start omp"
# [rules.when]
# repo_name = "backend"
# [rules.run]
# mode = "agent"
# kind = "omp"
# name = "omp"
# prompt = "summarize repo"

# Safe active example: linked worktrees are explicitly skipped.
[[rules]]
name = "skip linked worktrees"
[rules.when]
is_linked_worktree = true
[rules.run]
mode = "skip"
`;

function configPath() {
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(process.cwd(), "config");
  return path.join(configDir, "rules.toml");
}

function main() {
  const filePath = configPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  try {
    const fd = fs.openSync(filePath, "wx", 0o644);
    try {
      fs.writeFileSync(fd, STARTER_CONFIG, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    console.log(filePath);
    return 0;
  } catch (error) {
    if (error && error.code === "EEXIST") {
      console.log(`${filePath} already exists, not overwritten`);
      return 0;
    }
    throw error;
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
