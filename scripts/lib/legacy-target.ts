/**
 * Explicit Traditional Gu source-target resolution (R1 SL-1).
 *
 * The Supabase harness in `target-env.ts` resolves a Gu OS environment. It has
 * no notion of a legacy source system, so this is the second target slot the
 * SL-1 Definition of Done says must be built inside the Slice - bounded to what
 * SA-1.2/SA-1.3 need, not a generic multi-provider verification framework.
 *
 * It follows `target-env.ts`'s two rules deliberately:
 *
 *  1. FAIL CLOSED. A missing variable is an error, never a fallback. There is
 *     no default legacy environment, because the two Firestore projects are
 *     stage and PRODUCTION, and "whichever was configured" is not an acceptable
 *     answer to which one a read just touched.
 *
 *  2. POSITIVE BINDING. The resolved key file must actually belong to the
 *     declared environment's project, checked before any read. A stage run that
 *     silently used the production key would produce evidence labelled with the
 *     wrong environment - which is worse than no evidence.
 *
 * Asymmetry worth stating: Firestore has two projects, one per environment,
 * while Mongo is a single Atlas cluster reached by one identity. The variable
 * names reflect that rather than inventing a per-environment Mongo that does
 * not exist.
 *
 * Values are never printed. Callers report presence and identity only.
 */
import { readFileSync } from "node:fs";

/** The legacy environments Gu OS may read. Closed, and never defaulted. */
export const LEGACY_ENVIRONMENTS = ["stage", "prod"] as const;
export type LegacyEnvironment = (typeof LEGACY_ENVIRONMENTS)[number];

/**
 * Firestore project per environment, from the SL-1 prerequisite record. Pinned
 * here so a key file for the wrong project is a hard stop rather than a
 * mislabelled evidence run.
 */
export const LEGACY_FIRESTORE_PROJECTS: Record<LegacyEnvironment, string> = {
  stage: "unggafb",
  prod: "ungga-full",
};

export interface LegacySourceTarget {
  environment: LegacyEnvironment;
  firestore: {
    projectId: string;
    clientEmail: string;
    /** Path only. The key material itself is read once, at use time. */
    keyFilePath: string;
    serviceAccount: Record<string, unknown>;
  };
  mongo: {
    uri: string;
    database: string;
  } | null;
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(
      `could not read --env-file ${path}: ${(error as Error).message}`
    );
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

export interface ResolveLegacyOptions {
  envFile?: string;
  /** Required. There is deliberately no default. */
  legacyEnv?: string;
  /** Skip Mongo when the caller does not need the appointment capability. */
  requireMongo?: boolean;
}

export function resolveLegacyTarget(
  options: ResolveLegacyOptions
): LegacySourceTarget {
  const fromFile = options.envFile ? parseEnvFile(options.envFile) : {};
  const env = { ...fromFile, ...process.env } as Record<string, string | undefined>;

  const name = (options.legacyEnv ?? env.GUOS_LEGACY_ENV ?? "").trim().toLowerCase();
  if (!name) {
    throw new Error(
      "legacy environment not declared. Pass --legacy-env stage|prod (or set GUOS_LEGACY_ENV). " +
        "There is no default: one of these projects is production."
    );
  }
  if (!(LEGACY_ENVIRONMENTS as readonly string[]).includes(name)) {
    throw new Error(
      `unknown legacy environment "${name}". Known: ${LEGACY_ENVIRONMENTS.join(", ")}.`
    );
  }
  const environment = name as LegacyEnvironment;
  const prefix = `GUOS_LEGACY_${environment.toUpperCase()}_`;

  const keyFilePath = env[`${prefix}FIRESTORE_KEY_FILE`]?.trim();
  if (!keyFilePath) {
    throw new Error(
      `FAIL CLOSED - legacy environment "${environment}" is not configured. ` +
        `Missing ${prefix}FIRESTORE_KEY_FILE. No fallback to another environment is attempted.`
    );
  }

  let serviceAccount: Record<string, unknown>;
  try {
    serviceAccount = JSON.parse(readFileSync(keyFilePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    throw new Error(
      `could not read the Firestore key file at ${keyFilePath}: ${(error as Error).message}`
    );
  }

  const projectId = String(serviceAccount.project_id ?? "");
  const clientEmail = String(serviceAccount.client_email ?? "");
  const expected = LEGACY_FIRESTORE_PROJECTS[environment];
  if (projectId !== expected) {
    throw new Error(
      `STOP - target binding failed for legacy environment "${environment}": ` +
        `the key file references project "${projectId}", expected "${expected}". ` +
        "Do not repair this by adapting another environment's credentials."
    );
  }

  // One Atlas cluster serves both Firestore environments, so the Mongo
  // variables carry no environment segment. That is the source topology, not an
  // oversight.
  const uri = env.GUOS_LEGACY_MONGO_URI?.trim();
  const database = env.GUOS_LEGACY_MONGO_DB?.trim();
  let mongo: LegacySourceTarget["mongo"] = null;
  if (uri && database) {
    mongo = { uri, database };
  } else if (options.requireMongo) {
    throw new Error(
      "FAIL CLOSED - Mongo is required for this run but is not configured. " +
        "Set GUOS_LEGACY_MONGO_URI and GUOS_LEGACY_MONGO_DB (the appointments database)."
    );
  }

  return {
    environment,
    firestore: { projectId, clientEmail, keyFilePath, serviceAccount },
    mongo,
  };
}

/**
 * Presence/identity summary safe to log.
 *
 * The service-account email is an identity, not a credential, and printing it
 * is the point: an evidence run must state which identity performed the read.
 * Key material and the Mongo URI never appear.
 */
export function describeLegacyTarget(target: LegacySourceTarget): string {
  return (
    `legacy env=${target.environment} firestore-project=${target.firestore.projectId} ` +
    `identity=${target.firestore.clientEmail} ` +
    `mongo=${target.mongo ? `database ${target.mongo.database}, credential present` : "absent"}`
  );
}

/** `--env-file X --legacy-env Y` parsing shared by the legacy-aware scripts. */
export function parseLegacyArgs(argv: string[]): ResolveLegacyOptions & {
  apply: boolean;
  acknowledgeProductionRead: boolean;
} {
  let envFile: string | undefined;
  let legacyEnv: string | undefined;
  let apply = false;
  let acknowledgeProductionRead = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--env-file") envFile = argv[++i];
    else if (argv[i] === "--legacy-env") legacyEnv = argv[++i];
    else if (argv[i] === "--apply") apply = true;
    else if (argv[i] === "--i-understand-production-read") {
      acknowledgeProductionRead = true;
    }
  }
  return { envFile, legacyEnv, apply, acknowledgeProductionRead };
}

/**
 * Production reads need a second, explicit acknowledgement.
 *
 * The SL-1 prerequisite record is deliberate about this: the production key is
 * issued and valid but stays unwired until the hosted evidence run, so that the
 * window in which a project-wide production Firestore reader is exercised stays
 * as short as TD-5's time-boxed framing intends. A flag is how "deliberate"
 * becomes checkable.
 */
export function assertProductionReadAcknowledged(
  target: LegacySourceTarget,
  acknowledged: boolean
): void {
  if (target.environment === "prod" && !acknowledged) {
    throw new Error(
      "STOP - this run would read the PRODUCTION Traditional Gu project " +
        `(${target.firestore.projectId}). Pass --i-understand-production-read to proceed. ` +
        "Shadow-stage reads are read-only and have no prospect-facing effect, but the " +
        "production credential is deliberately exercised only for the hosted evidence run."
    );
  }
}
