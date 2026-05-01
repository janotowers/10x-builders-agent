import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Log ejecutivo tipo "dashboard" — un bloque consolidado por cada turno de
 * usuario que agrupa la información clave de los distintos componentes
 * (profile, short-term, compaction, long-term retrieval, prompt, decisión
 * del agente, flush eval). Pensado para lectura humana rápida.
 *
 * Versión actual: **v1 Lite** — sólo datos accesibles desde `runAgent` y
 * `trigger.ts`, sin tocar nodos ni `GraphState`. Los campos que requieren
 * instrumentación interna de nodos aparecen marcados como `n/a` y pueden
 * consultarse en `compaction.log` o `memory.log` para ese mismo turno.
 *
 * Ver `docs/memory/long_term_memory_plan.md` → "Observabilidad ejecutiva"
 * para el diseño completo y la propuesta de v2 enriquecida.
 *
 * Config (env vars):
 *   - TURN_LOG_FILE      ruta del log o `off|0|false` para desactivar.
 *                        Default: packages/agent/logs/turn_summary.log
 *   - TURN_LOG_DISABLED  `1|true|on` → apaga el log sin tocar código.
 *   - TURN_LOG_VERBOSE   `1|true|on` → incluye user input sin truncar
 *                        y detalles extra. Default: off (trunca a 200 chars).
 *
 * Opción "A" (cercanía a v2 sin tocar nodos): sección
 * [PROMPT SNAPSHOT — derivado en runAgent] con conteos aprox. de
 * tokens (≈ chars/4) y previews de líneas del bloque de memorias, todo
 * a partir del estado final del grafo, sin leer compaction.log.
 */

const DEFAULT_LOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "logs",
  "turn_summary.log"
);

function isDisabled(): boolean {
  const raw = process.env.TURN_LOG_DISABLED?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function resolveLogFilePath(): string | null {
  if (isDisabled()) return null;
  const raw = process.env.TURN_LOG_FILE?.trim();
  if (raw === "" || raw === "0" || raw === "false" || raw === "off") {
    return null;
  }
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  }
  return DEFAULT_LOG_PATH;
}

function isVerbose(): boolean {
  const raw = process.env.TURN_LOG_VERBOSE?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(+${s.length - max} chars)`;
}

/** Estimación barata de tokens para logs (no es tiktoken). */
export function approxTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** Shape de los campos que `runAgent` sabe recolectar en v1 Lite. */
export interface TurnSummaryInput {
  /** ISO timestamp al inicio del turno. Default: new Date(). */
  startedAt?: Date;
  /** Milisegundos que tardó el turno end-to-end. */
  elapsedMs: number;

  /** Identidad del turno. */
  userId: string;
  userEmail?: string | null;
  sessionId: string;
  channel: "web" | "telegram" | "cron";
  threadId?: string;

  /** El texto crudo del usuario en este turno (truncado en no-verbose). */
  userInput?: string | null;

  /** Datos canónicos leídos de `profiles`. */
  profile?: {
    name?: string | null;
    timezone?: string | null;
    language?: string | null;
    email?: string | null;
    phone?: string | null;
  };

  /** Historia corta cargada de `agent_messages` (antes de pasar al grafo). */
  shortTerm?: {
    loadedCount: number;
    /** Breakdown opcional por rol si se pudo calcular. */
    userCount?: number;
    assistantCount?: number;
    toolCount?: number;
  };

  /** Integraciones activas (para contexto). */
  integrationsActive?: string[];

  /** Tools habilitadas (ids). */
  toolsEnabled?: {
    enabled: string[];
    totalKnown?: number;
  };

  /**
   * Selección de skill para el turno (V1-B). Si la selección no se
   * ejecutó (resume HITL, mensaje vacío, etc.) déjalo `undefined`.
   */
  skillSelection?: {
    /** Slug de la skill activa, o `none` cuando ninguna aplicó. */
    active: string | "none";
    /** Razón de `none` (`empty_registry`, `model_returned_none`, etc.). */
    reason?: string;
    /** Tools restringidas por la skill (solo cuando hay skill activa). */
    allowedTools?: readonly string[];
    /** `requires_tenant_context` del frontmatter (solo cuando hay skill). */
    requiresTenantContext?: boolean;
    /** Path raíz del registro (para diagnosticar `empty_registry`). */
    registryRoot?: string;
    /** Tamaño del registro al momento del turno. */
    registrySize?: number;
  };

  /**
   * Bloque `[Contexto de tenant]` (V1-C-α). `applied=false` cuando la
   * skill activa no lo requiere o el caller decidió omitirlo.
   */
  tenantContext?: {
    applied: boolean;
    mode?:
      | "obligatorio"
      | "obligatorio_no_configurado"
      | "admin_cross_tenant"
      | "admin_organizacion_mencionada";
    organizationId?: string;
    mentionedOrgName?: string;
    bigqueryProject?: string;
    bigqueryLocation?: string;
    /** Descripción legible si `applied=false` (p.ej. "skill no requiere"). */
    reason?: string;
  };

  /** Resultado del retrieval de largo plazo (INJECT). Si no aplica
   *  (cron, resume HITL) dejar `skipped` con la razón. */
  longTermRetrieval?:
    | {
        skipped: true;
        reason: string;
      }
    | {
        skipped: false;
        /** `true` si el nodo reescribió el SystemMessage con memorias. */
        injected: boolean;
        matchesCount: number;
        threshold?: number;
        topK?: number;
        embeddingModel?: string;
        embeddingDim?: number;
      };

  /** Decisión del agente en este turno. */
  agentDecision?: {
    model?: string;
    toolsCalled: string[];
    status: "completed" | "pending_hitl" | "error";
    errorMessage?: string;
  };

  /** Evaluación del flush POST. `runAgent` suele no saberlo directamente;
   *  `trigger.ts` es quien la completa tras el turno. En v1 Lite se
   *  registra cuando esté disponible; si no, queda como n/a. */
  flushEval?: {
    decision: "fire" | "skip";
    reason: string;
    signals?: Record<string, unknown>;
  };

  /** Contadores simples. */
  warnings?: number;

  /**
   * Resolución de `MEMORY_RETRIEVE_TOP_K` y `MEMORY_MATCH_THRESHOLD` (mismos
   * defaults que `memory_injection_node`). Informativo en todos los turnos
   * (aunque long-term esté en skip).
   */
  memorySearchEnv: {
    topK: number;
    matchThreshold: number;
  };

  /**
   * Métricas derivadas en `runAgent` a partir del estado final del grafo
   * (opción A hacia v2). Tokens ≈ ceil(chars/4), orientativo.
   */
  promptSnapshot?: {
    systemChars: number;
    systemApproxTokens: number;
    nonSystemMessageCount: number;
    nonSystemChars: number;
    nonSystemApproxTokens: number;
    totalWindowChars: number;
    totalWindowApproxTokens: number;
    memoryBlockChars: number;
    memoryItemPreviews: string[];
  };

}

/** Fila de "KEY: value" alineada en columnas fijas. */
function row(key: string, value: string): string {
  const keyPadded = key.padEnd(18, " ");
  return `  ${keyPadded}${value}`;
}

function formatProfileLine(p: TurnSummaryInput["profile"]): string {
  if (!p) return "n/a";
  const parts: string[] = [];
  if (p.name) parts.push(`name=${p.name}`);
  if (p.timezone) parts.push(`tz=${p.timezone}`);
  if (p.language) parts.push(`lang=${p.language}`);
  parts.push(`email=${p.email ? p.email : "(not set)"}`);
  parts.push(`phone=${p.phone ? p.phone : "(not set)"}`);
  return parts.join("  ");
}

function formatShortTermLine(s: TurnSummaryInput["shortTerm"]): string {
  if (!s) return "n/a";
  const breakdown: string[] = [];
  if (typeof s.userCount === "number") breakdown.push(`${s.userCount} user`);
  if (typeof s.assistantCount === "number") breakdown.push(`${s.assistantCount} assistant`);
  if (typeof s.toolCount === "number") breakdown.push(`${s.toolCount} tool`);
  const suffix = breakdown.length > 0 ? ` (${breakdown.join(" / ")})` : "";
  return `loaded ${s.loadedCount} msgs from agent_messages${suffix}`;
}

function formatRetrievalLines(r: TurnSummaryInput["longTermRetrieval"]): string[] {
  if (!r) return [row("long-term", "n/a")];
  if (r.skipped) {
    return [row("long-term", `SKIPPED (${r.reason})  (injection no aplica)`)];
  }
  const lines: string[] = [];
  // top_k / threshold: ver fila "mem search (env)" (evita duplicar con mismo valor).
  const params: string[] = [];
  if (r.embeddingModel) params.push(`embed_model=${r.embeddingModel}`);
  if (typeof r.embeddingDim === "number") params.push(`embed_dim=${r.embeddingDim}`);
  lines.push(
    row(
      "long-term",
      `retrieved=${r.matchesCount}  injected=${r.injected}${params.length > 0 ? "  " + params.join("  ") : ""}`
    )
  );
  lines.push(row("", "(sim por memoria → memory.log bloque INJECT)"));
  return lines;
}

function formatPromptSnapshotSection(
  p: TurnSummaryInput["promptSnapshot"]
): string[] {
  if (!p) {
    return ["[PROMPT SNAPSHOT]  n/a"];
  }
  const lines: string[] = [];
  lines.push(
    "[PROMPT SNAPSHOT]  (derivado en runAgent; tok ≈ chars÷4, orientativo)"
  );
  lines.push(
    row(
      "first SystemMessage",
      `${p.systemChars} chars  ~${p.systemApproxTokens} tok`
    )
  );
  lines.push(
    row(
      "rest of window",
      `${p.nonSystemMessageCount} msgs  ${p.nonSystemChars} chars  ~${p.nonSystemApproxTokens} tok`
    )
  );
  lines.push(
    row(
      "total (system+rest)",
      `${p.totalWindowChars} chars  ~${p.totalWindowApproxTokens} tok`
    )
  );
  if (p.memoryBlockChars > 0) {
    lines.push(
      row("memory sub-block", `${p.memoryBlockChars} chars  (previews):`)
    );
    const prevMax = isVerbose() ? 12 : 6;
    for (const prev of p.memoryItemPreviews.slice(0, prevMax)) {
      lines.push(`      · ${prev}`);
    }
    if (p.memoryItemPreviews.length > prevMax) {
      lines.push(
        `      · …(+${p.memoryItemPreviews.length - prevMax} more lines)`
      );
    }
  } else {
    lines.push(row("memory sub-block", "none (no [MEMORIA DEL USUARIO] o vacío)"));
  }
  return lines;
}

function formatAgentDecisionLines(a: TurnSummaryInput["agentDecision"]): string[] {
  if (!a) return [row("decision", "n/a")];
  const lines: string[] = [];
  if (a.model) lines.push(row("model", a.model));
  lines.push(
    row(
      "tools_called",
      a.toolsCalled.length > 0 ? a.toolsCalled.join(", ") : "(none)"
    )
  );
  lines.push(row("status", a.status.toUpperCase()));
  if (a.errorMessage) {
    lines.push(row("error", truncate(a.errorMessage, 300)));
  }
  return lines;
}

function formatSkillSelectionLines(
  s: TurnSummaryInput["skillSelection"]
): string[] {
  if (!s) {
    return [
      "[SKILL SELECTION]",
      row("active", "n/a (resume HITL, cron sin mensaje, o turno vacío)"),
    ];
  }
  const lines: string[] = ["[SKILL SELECTION]"];
  if (s.active === "none") {
    lines.push(row("active", `none  (reason=${s.reason ?? "unknown"})`));
  } else {
    lines.push(row("active", s.active));
    if (typeof s.requiresTenantContext === "boolean") {
      lines.push(
        row("requires_tenant", s.requiresTenantContext ? "true" : "false")
      );
    }
    if (s.allowedTools && s.allowedTools.length > 0) {
      lines.push(row("allowed_tools", s.allowedTools.join(", ")));
    }
  }
  if (s.registryRoot) {
    lines.push(
      row(
        "registry",
        `root=${s.registryRoot}` +
          (typeof s.registrySize === "number" ? `  size=${s.registrySize}` : "")
      )
    );
  } else if (typeof s.registrySize === "number") {
    lines.push(row("registry", `size=${s.registrySize}`));
  }
  return lines;
}

function formatTenantContextLines(
  t: TurnSummaryInput["tenantContext"]
): string[] {
  if (!t) {
    return ["[TENANT CONTEXT]", row("applied", "n/a")];
  }
  const lines: string[] = ["[TENANT CONTEXT]"];
  if (!t.applied) {
    lines.push(row("applied", `false  (${t.reason ?? "skill no requiere"})`));
    return lines;
  }
  lines.push(row("applied", "true"));
  if (t.mode) lines.push(row("mode", t.mode));
  if (t.organizationId) lines.push(row("organization_id", t.organizationId));
  if (t.mentionedOrgName) {
    lines.push(row("mentioned_org", `"${t.mentionedOrgName}"`));
  }
  if (t.bigqueryProject || t.bigqueryLocation) {
    lines.push(
      row(
        "bigquery",
        `project=${t.bigqueryProject ?? "(none)"}  location=${
          t.bigqueryLocation ?? "(none)"
        }`
      )
    );
  }
  return lines;
}

function formatFlushEvalLines(f: TurnSummaryInput["flushEval"]): string[] {
  if (!f) {
    return [
      row("flush_eval", "n/a (ver memory.log bloque TRIGGER tras el turno)"),
    ];
  }
  const lines: string[] = [];
  lines.push(row("decision", f.decision.toUpperCase()));
  lines.push(row("reason", f.reason));
  if (f.signals && Object.keys(f.signals).length > 0) {
    const flat = Object.entries(f.signals)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("  ");
    lines.push(row("signals", flat));
  }
  return lines;
}

function buildBlock(input: TurnSummaryInput): string {
  const started = input.startedAt ?? new Date();
  const ts = started.toISOString();
  const elapsedSec = (input.elapsedMs / 1000).toFixed(2);
  const userLabel = input.userEmail
    ? `${input.userEmail} (${input.userId})`
    : input.userId;

  const userInputMax = isVerbose() ? 2000 : 200;
  const userInput = input.userInput
    ? truncate(input.userInput, userInputMax)
    : "(no user input this turn)";

  const integrations =
    input.integrationsActive && input.integrationsActive.length > 0
      ? input.integrationsActive.join(", ")
      : "(none active)";

  const tools = input.toolsEnabled
    ? `${input.toolsEnabled.enabled.length}${
        typeof input.toolsEnabled.totalKnown === "number"
          ? ` / ${input.toolsEnabled.totalKnown}`
          : ""
      } tools enabled${
        input.toolsEnabled.enabled.length > 0
          ? `: ${input.toolsEnabled.enabled.join(", ")}`
          : ""
      }`
    : "n/a";

  const outcome =
    input.agentDecision?.status === "pending_hitl"
      ? "pending_hitl"
      : input.agentDecision?.status === "error"
      ? "error"
      : "ok";
  const warnings = input.warnings ?? 0;

  const lines: string[] = [];
  lines.push(
    "================================================================"
  );
  lines.push(` TURN ${ts}   elapsed=${elapsedSec}s`);
  lines.push(
    ` user=${userLabel}  session=${input.sessionId}  channel=${input.channel}` +
      (input.threadId ? `\n thread=${input.threadId}` : "")
  );
  lines.push(
    "----------------------------------------------------------------"
  );
  lines.push("USER INPUT:");
  lines.push(`  ${userInput}`);
  lines.push("");
  lines.push("[CONTEXT BUILDERS]  (fuentes consultadas en DB)");
  lines.push(row("profile", formatProfileLine(input.profile)));
  lines.push(row("short-term", formatShortTermLine(input.shortTerm)));
  lines.push(row("", "(stages de compaction → compaction.log para este turno)"));
  for (const line of formatRetrievalLines(input.longTermRetrieval)) {
    lines.push(line);
  }
  lines.push(
    row(
      "mem search (env)",
      `MEMORY_RETRIEVE_TOP_K=${input.memorySearchEnv.topK}  MEMORY_MATCH_THRESHOLD=${input.memorySearchEnv.matchThreshold}  (misma lógica que memory_injection → RPC)`
    )
  );
  lines.push(row("integrations", integrations));
  lines.push(row("tool_settings", tools));

  lines.push("");
  for (const line of formatSkillSelectionLines(input.skillSelection)) {
    lines.push(line);
  }

  lines.push("");
  for (const line of formatTenantContextLines(input.tenantContext)) {
    lines.push(line);
  }

  lines.push("");
  for (const line of formatPromptSnapshotSection(input.promptSnapshot)) {
    lines.push(line);
  }

  lines.push("");
  lines.push("[AGENT DECISION]");
  for (const line of formatAgentDecisionLines(input.agentDecision)) {
    lines.push(line);
  }

  lines.push("");
  lines.push("[LONG-TERM FLUSH EVAL - POST-turn]");
  for (const line of formatFlushEvalLines(input.flushEval)) {
    lines.push(line);
  }

  lines.push("");
  lines.push(
    `================================================================`
  );
  lines.push(` END TURN   outcome=${outcome}   warnings=${warnings}`);
  lines.push(
    `================================================================`
  );
  lines.push(""); // blank line entre bloques

  return lines.join("\n");
}

/**
 * Emite el bloque al archivo de log. **Nunca lanza**: errores de disco,
 * permisos, etc. se absorben en silencio (stderr console.error en dev).
 * Fire-and-forget desde el caller — no bloquea el response al usuario.
 */
export async function writeTurnSummary(input: TurnSummaryInput): Promise<void> {
  const filePath = resolveLogFilePath();
  if (!filePath) return;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await appendFile(filePath, buildBlock(input), "utf8");
  } catch (e) {
    console.error("[turn_log] write failed:", e);
  }
}

/**
 * Helper para crear un objeto `TurnSummaryInput` parcial al inicio de un
 * turno y que el caller vaya rellenando campos. Sólo ayuda tipográfica.
 */
export function createTurnCollector(
  seed: Pick<TurnSummaryInput, "userId" | "sessionId" | "channel"> &
    Partial<TurnSummaryInput>
): TurnSummaryInput {
  return {
    startedAt: seed.startedAt ?? new Date(),
    elapsedMs: 0,
    warnings: 0,
    memorySearchEnv: seed.memorySearchEnv ?? {
      topK: 8,
      matchThreshold: 0.5,
    },
    ...seed,
  };
}
