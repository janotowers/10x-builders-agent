import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const browserPath =
  process.env.POC_PLAYWRIGHT_BROWSERS_PATH ??
  resolve(root, ".cache", "ms-playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
const checkOnly = process.argv.includes("--check");
const pocs = ["pocs/ungga-cli", "pocs/easybroker-mls-cli"];

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserPath },
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const npmCli = process.env.npm_execpath;

function executableFor(poc) {
  const packageJson = resolve(root, poc, "package.json");
  try {
    const require = createRequire(packageJson);
    const { chromium } = require("playwright");
    return chromium.executablePath();
  } catch {
    return null;
  }
}

const missingDependencies = pocs.filter(
  (poc) => !existsSync(resolve(root, poc, "node_modules", "playwright"))
);

if (missingDependencies.length > 0) {
  if (checkOnly) {
    console.error(
      `Playwright dependencies missing in: ${missingDependencies.join(", ")}. Run npm run setup:pocs.`
    );
    process.exit(1);
  }
  for (const poc of missingDependencies) {
    console.log(`[poc-browsers] installing dependencies: ${poc}`);
    if (!npmCli) {
      console.error("npm_execpath unavailable; run `npm ci` from npm.");
      process.exit(1);
    }
    run(process.execPath, [npmCli, "ci", "--prefix", poc]);
  }
}

const missingBrowsers = pocs.filter((poc) => {
  const executable = executableFor(poc);
  return !executable || !existsSync(executable);
});

if (missingBrowsers.length > 0) {
  if (checkOnly) {
    console.error(
      `Chromium missing for: ${missingBrowsers.join(", ")} (PLAYWRIGHT_BROWSERS_PATH=${browserPath}). Run npm run setup:pocs.`
    );
    process.exit(1);
  }
  // Both POCs are pinned to the same Playwright revision, so one install into
  // the stable repo cache satisfies both and avoids Cursor/TEMP cache loss.
  console.log(
    `[poc-browsers] installing Chromium in stable cache: ${browserPath}`
  );
  run(process.execPath, [
    resolve(root, "pocs", "ungga-cli", "node_modules", "playwright", "cli.js"),
    "install",
    "chromium",
  ]);
}

for (const poc of pocs) {
  const executable = executableFor(poc);
  if (!executable || !existsSync(executable)) {
    console.error(`[poc-browsers] Chromium still unavailable for ${poc}`);
    process.exit(1);
  }
}

console.log(
  `[poc-browsers] ready (${browserPath}); Playwright dependencies and Chromium match.`
);
