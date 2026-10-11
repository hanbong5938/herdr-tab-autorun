import fs from "node:fs";
import path from "node:path";

const EXAMPLE_URL = new URL("../../rules.example.toml", import.meta.url);

function configPath() {
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR || path.join(process.cwd(), "config");
  return path.join(configDir, "rules.toml");
}

function main() {
  const filePath = configPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let starterConfig;
  try {
    starterConfig = fs.readFileSync(EXAMPLE_URL, "utf8");
  } catch (error) {
    if (fs.existsSync(filePath)) {
      console.log(`${filePath} already exists, not overwritten`);
      return 0;
    }
    throw error;
  }

  try {
    const fd = fs.openSync(filePath, "wx", 0o644);
    try {
      fs.writeFileSync(fd, starterConfig, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    console.log(`${filePath} created; edit the commented repo_name rule to opt in to autorun`);
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
