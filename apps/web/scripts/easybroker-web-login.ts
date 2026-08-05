// Refresca la sesión web de EasyBroker (storage-state.json) usando las
// credenciales per-account (provider easybroker_web) igual que producción.
// Lanza el login híbrido del POC: autollenado + ventana visible para que un
// humano resuelva CAPTCHA/MFA si el checkbox automático no basta.
//
// Uso (desde apps/web):
//   npx tsx scripts/easybroker-web-login.ts [--user <uuid>]

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvIntoProcess(path: string): void {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const key = line.slice(0, idx).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvIntoProcess(resolve(__dirname, "..", ".env.local"));

function arg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? (process.argv[idx + 1] ?? null) : null;
}

async function main() {
  const { createServerClient, getAccountToolSecretForRuntime } = await import(
    "@agents/db"
  );
  const db = createServerClient();

  let userId = arg("--user");
  if (!userId) {
    const { data, error } = await db
      .from("account_tool_secrets")
      .select("user_id")
      .eq("provider", "easybroker_web")
      .limit(2);
    if (error) throw error;
    if (!data || data.length === 0) {
      throw new Error("no hay secretos easybroker_web configurados; pasa --user");
    }
    if (data.length > 1) {
      throw new Error(
        "varios usuarios tienen easybroker_web; pasa --user <uuid>"
      );
    }
    userId = data[0].user_id;
  }
  if (!userId) throw new Error("no se pudo resolver el usuario; pasa --user");

  const secret = await getAccountToolSecretForRuntime<{
    email?: string;
    password?: string;
  }>(db, { userId, provider: "easybroker_web" });
  const email = secret?.secret?.email?.trim();
  const password = secret?.secret?.password?.trim();
  if (!email || !password) {
    throw new Error(
      "credenciales easybroker_web incompletas para el usuario; configúralas en Ajustes"
    );
  }
  console.log(`Credenciales easybroker_web resueltas para user=${userId}`);

  const repoRoot = resolve(__dirname, "..", "..", "..");
  const pocDir = resolve(repoRoot, "pocs", "easybroker-mls-cli");
  const browsersPath =
    process.env.POC_PLAYWRIGHT_BROWSERS_PATH ??
    resolve(repoRoot, ".cache", "ms-playwright");

  const child = spawn(
    process.execPath,
    [resolve(pocDir, "src", "login-hybrid.mjs")],
    {
      cwd: pocDir,
      stdio: "inherit",
      env: {
        ...process.env,
        EASYBROKER_WEB_EMAIL: email,
        EASYBROKER_WEB_PASSWORD: password,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      },
    }
  );
  const code: number = await new Promise((resolveExit) => {
    child.on("close", (c) => resolveExit(c ?? 1));
  });
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
