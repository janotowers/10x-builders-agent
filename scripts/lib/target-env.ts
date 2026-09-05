/**
 * Explicit deployment-target resolution. Shared by every script that can reach
 * a hosted database or API.
 *
 * Two rules, both learned the hard way during SL-0 Gate A:
 *
 *  1. FAIL CLOSED. A missing target variable is an error, never a fallback.
 *    `scripts/bootstrap-organization.ts` merges `apps/web/.env.local` under
 *    `process.env`, so an unset variable there silently resolves to whatever
 *    the app is configured with — production. Nothing here inherits that.
 *
 *  2. POSITIVE BINDING before any write. Every supplied value must reference the
 *    declared project ref, and any value referencing a *different* project is a
 *    hard stop rather than something to repair by adapting another environment's
 *    credentials.
 *
 * Values are never printed. Callers report presence, the environment name and
 * the project ref only.
 */
import { readFileSync } from "node:fs";

export interface TargetEnv {
  /** Human-readable environment name, e.g. "staging". */
  name: string;
  projectRef: string;
  databaseUrl: string;
  supabaseUrl?: string;
  /**
   * Public client credential. Named for the modern Supabase key form
   * (`sb_publishable_…`) rather than institutionalising the legacy `anon`
   * wording in new infrastructure. Application runtime code still reads
   * `NEXT_PUBLIC_SUPABASE_ANON_KEY`; see `runtimeEnvFor()` for the mapping.
   */
  publishableKey?: string;
  /**
   * Privileged server credential. Deliberately optional and NOT supplied to the
   * generic staging workflow — least privilege. Only slice-specific verification
   * that genuinely needs admin operations should provide it, under its own
   * governed configuration.
   */
  serviceRoleKey?: string;
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`could not read --env-file ${path}: ${(error as Error).message}`);
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

/** Extracts the project ref from a Supabase URL or a pooler connection string. */
function refFrom(value: string): string | null {
  const url = /https:\/\/([a-z0-9]{20})\.supabase\.co/i.exec(value);
  if (url) return url[1];
  const pooler = /postgres\.([a-z0-9]{20})/i.exec(value);
  if (pooler) return pooler[1];
  const direct = /db\.([a-z0-9]{20})\.supabase\.co/i.exec(value);
  if (direct) return direct[1];
  return null;
}

export interface ResolveOptions {
  /** Local env file, e.g. `.env.staging.local`. Values map GUOS_<ENV>_SUPABASE_* → target. */
  envFile?: string;
  /** Environment name used for the GUOS_<ENV>_* prefix when reading a file. */
  envName?: string;
}

/**
 * Resolves the target from `GUOS_TARGET_*` (CI/secrets) or, for local use, from
 * an env file's `GUOS_<ENV>_SUPABASE_*` variables.
 */
export function resolveTarget(options: ResolveOptions = {}): TargetEnv {
  const fromFile = options.envFile ? parseEnvFile(options.envFile) : {};
  const env = { ...fromFile, ...process.env } as Record<string, string | undefined>;
  const name = (options.envName ?? env.GUOS_TARGET_ENV ?? "").trim();
  if (!name) {
    throw new Error(
      "target environment not declared. Set GUOS_TARGET_ENV (e.g. staging) or pass --env <name>."
    );
  }
  const prefix = `GUOS_${name.toUpperCase()}_SUPABASE_`;

  const pick = (targetKey: string, fileKey: string): string | undefined =>
    (env[targetKey] ?? env[`${prefix}${fileKey}`])?.trim() || undefined;

  // The public credential was renamed to PUBLISHABLE_KEY. The old envelope name
  // is deliberately NOT accepted as an alias: silently honouring both would
  // leave two names meaning one thing, which is exactly the ambiguity the
  // rename removes. Fail closed with an explicit instruction instead.
  const staleAnon = env.GUOS_TARGET_ANON_KEY ?? env[`${prefix}ANON_KEY`];
  if (staleAnon && !(env.GUOS_TARGET_PUBLISHABLE_KEY ?? env[`${prefix}PUBLISHABLE_KEY`])) {
    throw new Error(
      `${prefix}ANON_KEY / GUOS_TARGET_ANON_KEY is no longer accepted. ` +
        `Rename it to ${prefix}PUBLISHABLE_KEY (the value is a Supabase publishable key). ` +
        "Application runtime naming (NEXT_PUBLIC_SUPABASE_ANON_KEY) is unchanged."
    );
  }

  const projectRef = (env.GUOS_TARGET_PROJECT_REF ?? "").trim() ||
    refFrom(pick("GUOS_TARGET_SUPABASE_URL", "URL") ?? "") ||
    "";
  const databaseUrl = pick("GUOS_TARGET_DATABASE_URL", "DATABASE_URL");
  const supabaseUrl = pick("GUOS_TARGET_SUPABASE_URL", "URL");
  const serviceRoleKey = pick("GUOS_TARGET_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY");
  const publishableKey = pick("GUOS_TARGET_PUBLISHABLE_KEY", "PUBLISHABLE_KEY");

  const missing: string[] = [];
  if (!projectRef) missing.push("GUOS_TARGET_PROJECT_REF (or a resolvable target URL)");
  if (!databaseUrl) missing.push(`GUOS_TARGET_DATABASE_URL (or ${prefix}DATABASE_URL)`);
  if (missing.length > 0) {
    throw new Error(
      `FAIL CLOSED — target "${name}" is not fully configured. Missing: ${missing.join(", ")}. ` +
        "No fallback to another environment is attempted."
    );
  }

  return { name, projectRef, databaseUrl: databaseUrl!, supabaseUrl, serviceRoleKey, publishableKey };
}

/**
 * Maps a resolved target onto the variable names application runtime code
 * expects, so a child process can be pointed at a non-default environment
 * without editing `apps/web/.env.local` and without any variable falling
 * through to it. All four are always set — an unset one would resolve to the
 * application's own configuration.
 *
 * This is the compatibility seam: infrastructure uses PUBLISHABLE_KEY, while
 * unrelated application naming stays as it is.
 */
export function runtimeEnvFor(target: TargetEnv): Record<string, string> {
  const out: Record<string, string> = {
    NEXT_PUBLIC_SUPABASE_URL: target.supabaseUrl ?? "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: target.publishableKey ?? "",
    SUPABASE_SERVICE_ROLE_KEY: target.serviceRoleKey ?? "",
    DATABASE_URL: target.databaseUrl,
  };
  const blank = Object.entries(out).filter(([, v]) => !v).map(([k]) => k);
  if (blank.length > 0) {
    throw new Error(
      `FAIL CLOSED — cannot build a runtime environment for "${target.name}": ${blank.join(", ")} ` +
        "would be empty and could fall through to the application's own configuration."
    );
  }
  return out;
}

/**
 * Hard stop unless every supplied value binds to the declared project.
 * Call this before ANY hosted write.
 */
export function assertBinding(target: TargetEnv): void {
  const problems: string[] = [];
  const checkValue = (label: string, value?: string): void => {
    if (!value) return;
    const ref = refFrom(value);
    if (ref === null) {
      // Opaque by design (e.g. sb_secret_ keys carry no recoverable ref); such
      // credentials are proved by a successful read-only call instead.
      return;
    }
    if (ref !== target.projectRef) {
      problems.push(`${label} references project ${ref}, expected ${target.projectRef}`);
    }
  };

  checkValue("GUOS_TARGET_DATABASE_URL", target.databaseUrl);
  checkValue("GUOS_TARGET_SUPABASE_URL", target.supabaseUrl);

  if (!refFrom(target.databaseUrl)) {
    problems.push("GUOS_TARGET_DATABASE_URL does not carry the project ref (expected postgres.<ref>)");
  }

  if (problems.length > 0) {
    throw new Error(
      `STOP — target binding failed for "${target.name}":\n  - ${problems.join("\n  - ")}\n` +
        "Do not repair this by adapting another project's credentials."
    );
  }
}

/** Presence/identity summary safe to log. Never includes a value. */
export function describeTarget(target: TargetEnv): string {
  const present = (v?: string) => (v ? "present" : "absent");
  return (
    `target env=${target.name} project=${target.projectRef} ` +
    `db=${present(target.databaseUrl)} url=${present(target.supabaseUrl)} ` +
    `service=${present(target.serviceRoleKey)} publishable=${present(target.publishableKey)}`
  );
}

/** `--env-file X --env Y` parsing shared by the target-aware scripts. */
export function parseTargetArgs(argv: string[]): ResolveOptions & { apply: boolean } {
  let envFile: string | undefined;
  let envName: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--env-file") envFile = argv[++i];
    else if (argv[i] === "--env") envName = argv[++i];
    else if (argv[i] === "--apply") apply = true;
  }
  return { envFile, envName, apply };
}

/**
 * Application encryption key for the DECLARED environment, read as
 * `GUOS_<ENV>_ENCRYPTION_KEY`.
 *
 * An ambient `ENCRYPTION_KEY` is deliberately not accepted. Material encrypted
 * with a developer's local key stores cleanly and then fails to decrypt in the
 * environment that has to use it — a credential that looks configured and is
 * not. Binding the key to the declared target is what makes that impossible,
 * and it is the same fail-closed rule the rest of this module applies.
 *
 * The value is never returned to a caller that logs; callers assign it to
 * `process.env.ENCRYPTION_KEY` and nothing else.
 */
export function resolveEncryptionKeyForTarget(
  envFile: string | undefined,
  envName: string
): string {
  const key = `GUOS_${envName.toUpperCase()}_ENCRYPTION_KEY`;
  const fromFile = envFile ? parseEnvFile(envFile)[key] : undefined;
  const resolved = (process.env[key] ?? fromFile ?? "").trim();
  if (!resolved) {
    throw new Error(
      `FAIL CLOSED — ${key} is not set. Organization-scoped credentials are encrypted at ` +
        `rest with the SAME key the "${envName}" runtime decrypts with; an ambient ` +
        "ENCRYPTION_KEY is not accepted."
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(resolved)) {
    throw new Error(`${key} must be 64 hex characters (32 bytes).`);
  }
  return resolved;
}
