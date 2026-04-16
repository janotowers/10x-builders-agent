import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync, existsSync } from "node:fs";
import path from "node:path";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

const IS_WINDOWS = process.platform === "win32";

const GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
];

type ShellInfo = { exe: string; args: (cmd: string) => string[]; name: string };

/**
 * Resolves the best available shell:
 *   1. `bash` in PATH          (Unix, WSL, or Git Bash if user added it to PATH)
 *   2. Git Bash at known paths (Windows only)
 *   3. PowerShell              (Windows fallback)
 */
let _cachedShell: ShellInfo | null = null;

function resolveShell(): ShellInfo {
  if (_cachedShell) return _cachedShell;

  if (!IS_WINDOWS) {
    _cachedShell = { exe: "bash", args: (c) => ["-lc", c], name: "bash" };
    return _cachedShell;
  }

  for (const p of GIT_BASH_PATHS) {
    if (existsSync(p)) {
      _cachedShell = { exe: p, args: (c) => ["-lc", c], name: "git-bash" };
      console.log(`[bash-tool] Using Git Bash: ${p}`);
      return _cachedShell;
    }
  }

  _cachedShell = {
    exe: "powershell",
    args: (c) => ["-NoProfile", "-Command", c],
    name: "powershell",
  };
  console.log("[bash-tool] No bash found, falling back to PowerShell");
  return _cachedShell;
}

function resolveWorkingDirectory():
  | { ok: true; cwd: string }
  | { ok: false; error: string } {
  const raw = process.env.BASH_TOOL_CWD?.trim();
  if (!raw) {
    return { ok: true, cwd: process.cwd() };
  }
  try {
    const resolved = path.resolve(raw);
    const st = statSync(resolved);
    if (!st.isDirectory()) {
      return {
        ok: false,
        error: `BASH_TOOL_CWD no es un directorio: ${resolved}`,
      };
    }
    return { ok: true, cwd: resolved };
  } catch {
    return {
      ok: false,
      error: `BASH_TOOL_CWD inválido o inaccesible: ${raw}`,
    };
  }
}

export interface BashExecInput {
  terminal: string;
  prompt: string;
}

export interface BashExecResult {
  terminal: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd?: string;
  shell?: string;
  error?: string;
}

export function getActiveShellName(): string {
  return resolveShell().name;
}

export async function executeBashCommand(
  input: BashExecInput
): Promise<BashExecResult> {
  const terminal = input.terminal?.trim() || "default";
  const shell = resolveShell();

  if (process.env.BASH_TOOL_ENABLED !== "true") {
    return {
      terminal,
      stdout: "",
      stderr: "",
      exitCode: -1,
      shell: shell.name,
      error:
        "La herramienta bash está desactivada en el servidor. El administrador debe definir BASH_TOOL_ENABLED=true.",
    };
  }

  const cwdResult = resolveWorkingDirectory();
  if (!cwdResult.ok) {
    return {
      terminal,
      stdout: "",
      stderr: "",
      exitCode: -1,
      shell: shell.name,
      error: cwdResult.error,
    };
  }

  const prompt = input.prompt;
  if (!prompt || typeof prompt !== "string") {
    return {
      terminal,
      stdout: "",
      stderr: "",
      exitCode: -1,
      shell: shell.name,
      error: "El parámetro prompt es obligatorio.",
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      shell.exe,
      shell.args(prompt),
      {
        cwd: cwdResult.cwd,
        timeout: DEFAULT_TIMEOUT_MS,
        maxBuffer: DEFAULT_MAX_BUFFER,
        encoding: "utf8",
        env: process.env,
      }
    );
    return {
      terminal,
      stdout: stdout ?? "",
      stderr: stderr ?? "",
      exitCode: 0,
      cwd: cwdResult.cwd,
      shell: shell.name,
    };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      status?: number;
    };

    if (e.code === "ENOENT") {
      return {
        terminal,
        stdout: "",
        stderr: "",
        exitCode: -1,
        shell: shell.name,
        error: `No se encontró el ejecutable \`${shell.exe}\` en el PATH del servidor.`,
        cwd: cwdResult.cwd,
      };
    }

    const exitCode =
      typeof e.code === "number"
        ? e.code
        : typeof e.status === "number"
          ? e.status
          : 1;

    return {
      terminal,
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string"
          ? e.stderr
          : (e.message ?? String(err)),
      exitCode,
      cwd: cwdResult.cwd,
      shell: shell.name,
    };
  }
}
