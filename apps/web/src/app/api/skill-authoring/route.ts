import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient } from "@agents/db";
import {
  getGlobalSkillRegistry,
  MAX_SKILL_BODY_TOKENS,
  parseAccountSkillSource,
  runAgent,
  SkillParseError,
  TOOL_CATALOG,
  type SkillRecord,
} from "@agents/agent";
import { ensureAgentToolDepsWired } from "@/lib/agent/wire-tool-deps";

type SkillAuthoringRequest = {
  caseType?: unknown;
  displayName?: unknown;
  description?: unknown;
  fieldList?: unknown;
  intakeSchema?: unknown;
  skillSlug?: unknown;
  baseSkillSlug?: unknown;
};

type RubricItem = {
  item: string;
  status: "PASS" | "WARN" | "FAIL" | "N/A";
  note: string;
};

type AuthoringEvent =
  | {
      type: "stage";
      stage: string;
      message: string;
      attempt?: number;
      ts: number;
    }
  | {
      type: "result";
      payload: Record<string, unknown>;
      ts: number;
    }
  | {
      type: "error";
      error: string;
      details?: string;
      raw?: string;
      ts: number;
    };

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function concreteModelNote(value: unknown): string {
  const note = cleanText(value).slice(0, 300);
  if (!note) return "";
  const hasConcreteReference =
    /`[^`]+`|[a-z0-9]+_[a-z0-9_]+|[a-z0-9]+-[a-z0-9-]+|operational_case|current_step|intake_schema|case_type|allowed_tools|includes|guardrails/i.test(
      note
    );
  const soundsLikeGenericReview =
    /revis(ar|a)|chec(ar|a)|validaci[oó]n|flujo/i.test(note);
  if (soundsLikeGenericReview && !hasConcreteReference) return "";
  return note;
}

function ndjsonResponse(
  stream: ReadableStream<Uint8Array>,
  init?: ResponseInit
): Response {
  return new Response(stream, {
    ...init,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      ...(init?.headers ?? {}),
    },
  });
}

function repoRoot(): string {
  const cwd = process.cwd();
  return cwd.endsWith(path.join("apps", "web")) ? path.resolve(cwd, "../..") : cwd;
}

async function readGlobalSkillBody(slug: string): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return null;
  const filePath = path.join(repoRoot(), "skills", "global", slug, "SKILL.md");
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("agent_response_not_json");
  }
}

/**
 * Extracts the content of a tagged section like
 *   <skill-draft>...</skill-draft>
 * Robust to surrounding whitespace, tag attributes are not supported.
 */
function extractTagged(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function stripFences(value: string): string {
  const fenced = value.match(/^```(?:[a-z]+)?\s*\n([\s\S]*?)\n```\s*$/i);
  return fenced ? fenced[1] : value;
}

/**
 * Tries to extract the largest valid JSON object from `source`. Useful when the
 * model truncates mid-response: we walk back from the end of the string
 * removing characters until JSON.parse succeeds, with a safety cap on
 * iterations. Returns null if no usable prefix can be parsed.
 */
function tryParsePartialJson(source: string): unknown {
  const trimmed = source.trim();
  if (!trimmed.startsWith("{")) return null;
  // First pass: try the input verbatim.
  try {
    return JSON.parse(trimmed);
  } catch {
    // fallthrough
  }
  // Second pass: progressively close braces/brackets/quotes from the end.
  // We walk character by character, attempting to parse with synthetic
  // closures appended; we cap to avoid pathological input.
  const maxAttempts = Math.min(trimmed.length, 4000);
  for (let cut = trimmed.length - 1; cut > 0 && trimmed.length - cut < maxAttempts; cut -= 1) {
    const candidate = trimmed.slice(0, cut);
    // Skip cuts that obviously land mid-token to keep cost low.
    const last = candidate[candidate.length - 1];
    if (last === undefined) continue;
    if (last === "," || last === ":") continue;
    const repaired = balanceJsonClosers(candidate);
    if (!repaired) continue;
    try {
      return JSON.parse(repaired);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Rough JSON closer balancer: counts open `{`/`[` and unterminated quotes
 * (ignoring escapes) and appends matching closers. Returns null if the
 * structure looks too broken to recover.
 */
function balanceJsonClosers(source: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}") {
      if (stack[stack.length - 1] === "{") stack.pop();
      else return null;
    } else if (ch === "]") {
      if (stack[stack.length - 1] === "[") stack.pop();
      else return null;
    }
  }
  let repaired = source;
  if (inString) repaired += '"';
  // If we are inside a string immediately before a value boundary we'd have
  // produced invalid JSON; the JSON.parse retry will catch it.
  while (stack.length > 0) {
    const open = stack.pop();
    repaired += open === "{" ? "}" : "]";
  }
  return repaired;
}

/**
 * Parses the agent response. Preferred shape is:
 *
 *   <metadata>
 *   { "suggestedEvals": {...}, "notes": "..." }
 *   </metadata>
 *   <skill-draft>
 *   ...raw SKILL.md...
 *   </skill-draft>
 *
 * The metadata comes first so short structured eval suggestions are protected
 * from output truncation. The skill-draft block must be complete (closing
 * </skill-draft>); if it truncates, retries should produce a shorter/cleaner
 * response rather than accepting an incomplete artifact.
 *
 * If the agent returned the legacy single-JSON shape, falls back to extractJson.
 */
function parseAuthoringResponse(text: string): {
  skillDraft: string;
  metadata: Record<string, unknown>;
  metadataTruncated: boolean;
} {
  const draftTagged = extractTagged(text, "skill-draft");
  if (draftTagged) {
    let metaRaw: string | null = extractTagged(text, "metadata");
    let metadataTruncated = false;
    if (!metaRaw) {
      // Try to recover from a missing/truncated </metadata> closing tag.
      const openIdx = text.indexOf("<metadata>");
      if (openIdx >= 0) {
        metaRaw = text.slice(openIdx + "<metadata>".length).trim();
        metadataTruncated = true;
      }
    }
    let metadata: Record<string, unknown> = {};
    if (metaRaw) {
      const cleaned = stripFences(metaRaw);
      try {
        const parsed = JSON.parse(cleaned);
        if (isRecord(parsed)) metadata = parsed;
      } catch {
        const recovered = tryParsePartialJson(cleaned);
        if (isRecord(recovered)) {
          metadata = recovered;
          metadataTruncated = true;
        } else {
          metadata = {};
          metadataTruncated = true;
        }
      }
    }
    return {
      skillDraft: stripFences(draftTagged),
      metadata,
      metadataTruncated,
    };
  }

  const legacy = extractJson(text);
  if (!isRecord(legacy) || typeof legacy.skillDraft !== "string") {
    throw new Error("agent_response_missing_skill_draft");
  }
  const { skillDraft, ...rest } = legacy;
  return { skillDraft, metadata: rest, metadataTruncated: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSkillDraft(value: string): string {
  // Gu's frontmatter parser is a strict subset of YAML and only supports
  // `key: |` block scalars (clip mode). Anything like `|-`, `|+`, `>`, `>-`
  // or `>+` is treated as a plain `"|-"` string by the parser and then the
  // next indented line is rejected as "unexpected indentation outside of a
  // block value". We rewrite those indicators to `|` so authors get the
  // intended behaviour without touching the parser.
  return value
    .split("\n")
    .map((line) => {
      const match = line.match(
        /^([a-z_][a-z0-9_]*):\s*([|>])([+-]?)\s*$/u
      );
      if (match) {
        const [, key] = match;
        return `${key}: |`;
      }
      return line.replace(/[ \t]+$/u, "");
    })
    .join("\n")
    .trim();
}

async function buildBackendRubric(params: {
  record: SkillRecord | null;
  parserError: unknown;
  skillDraft: string;
  expectedSlug: string;
}): Promise<RubricItem[]> {
  if (!params.record) {
    return [
      {
        item: "Gu parser validation",
        status: "FAIL",
        note:
          params.parserError instanceof SkillParseError ||
          params.parserError instanceof Error
            ? params.parserError.message
            : String(params.parserError ?? "unknown_parse_error"),
      },
    ];
  }

  const metadata = params.record.metadata;
  const body = await params.record.loadBody();
  const bodyLower = body.toLowerCase();
  const instructionTextLower = `${metadata.guardrails ?? ""}\n${body}`.toLowerCase();
  const descriptionLower = metadata.description.toLowerCase();
  const catalogIds = new Set(TOOL_CATALOG.map((tool) => tool.id));
  const unknownTools = metadata.allowedTools.filter((tool) => !catalogIds.has(tool));
  const registry = await getGlobalSkillRegistry();
  const missingIncludes = metadata.includes.filter((slug) => !registry.has(slug));
  const tenantTools = metadata.allowedTools.filter((tool) =>
    /bigquery|easybroker|ungga|telegram|operational_case|calendar/.test(tool)
  );
  const writeOrSendTools = metadata.allowedTools.filter((tool) =>
    /(send|create|update|upload|publish|generate|add_event)/.test(tool)
  );
  const hitlMentioned = /hitl|humano aprueba|confirmaci[oó]n|aprobar|aprueba/.test(
    instructionTextLower
  );
  const asksOrStops = /falta|pide|pregunta|no avances|no env[ií]es|stop|no-action|sin acci[oó]n/.test(
    bodyLower
  );
  const escalates = /escala|escalaci[oó]n|escalate/.test(bodyLower);
  const usesCaseCreate = body.includes("operational_case_create");
  const hasCaseCreateTool = metadata.allowedTools.includes("operational_case_create");

  return [
    {
      item: "Gu parser validation",
      status: "PASS",
      note: "parseAccountSkillSource aceptó el SKILL.md generado.",
    },
    {
      item: "Required fields present, types correct, lengths within limits.",
      status: "PASS",
      note: "Frontmatter y tamaño del cuerpo cumplen el contrato de Gu.",
    },
    {
      item: "Description includes both trigger and non-trigger boundaries.",
      status:
        descriptionLower.includes("use when") &&
        descriptionLower.includes("do not use")
          ? "PASS"
          : "WARN",
      note:
        descriptionLower.includes("use when") &&
        descriptionLower.includes("do not use")
          ? "Incluye límites de activación y no activación."
          : "Conviene incluir explícitamente Use when... y Do not use...",
    },
    {
      item: "allowed_tools are minimal and scoped; each tool exists in the catalog.",
      status: unknownTools.length === 0 ? "PASS" : "FAIL",
      note:
        unknownTools.length === 0
          ? "Todas las herramientas declaradas existen en el catálogo."
          : `Herramientas no encontradas: ${unknownTools.join(", ")}`,
    },
    {
      item: "includes exist; no cycles; composition order is intentional.",
      status: missingIncludes.length === 0 ? "PASS" : "FAIL",
      note:
        missingIncludes.length === 0
          ? "Las sub-skills existen en el registry global."
          : `Includes no encontrados: ${missingIncludes.join(", ")}`,
    },
    {
      item: "requires_tenant_context is true for any skill that touches tenant data.",
      status:
        tenantTools.length === 0 || metadata.requiresTenantContext ? "PASS" : "WARN",
      note:
        tenantTools.length === 0 || metadata.requiresTenantContext
          ? "El contexto del tenant está correctamente requerido."
          : "Usa herramientas por-tenant; marca requires_tenant_context: true.",
    },
    {
      item: "Write/send tools are absent OR gated by explicit HITL in guardrails AND body.",
      status: writeOrSendTools.length === 0 || hitlMentioned ? "PASS" : "WARN",
      note:
        writeOrSendTools.length === 0 || hitlMentioned
          ? "Las acciones de escritura/envío están cubiertas por HITL o no aplican."
          : "Hay tools de escritura/envío; documenta HITL explícito.",
    },
    {
      item: "Body explains stop, ask, escalate, and no-action paths.",
      status: asksOrStops && escalates ? "PASS" : "WARN",
      note:
        asksOrStops && escalates
          ? "El cuerpo cubre pedir datos, detenerse/no avanzar y escalar."
          : "Falta explicar mejor pedir datos, detenerse/no avanzar o escalar.",
    },
    {
      item: "If operational_case_create appears in the body, it appears in allowed_tools.",
      status: !usesCaseCreate || hasCaseCreateTool ? "PASS" : "FAIL",
      note:
        !usesCaseCreate || hasCaseCreateTool
          ? "La tool conversacional está alineada con allowed_tools."
          : "El body menciona operational_case_create pero no está en allowed_tools.",
    },
    {
      item: "Heartbeat skills have a documented no-action path.",
      status: metadata.heartbeatMode === "blocked" ? "N/A" : "WARN",
      note:
        metadata.heartbeatMode === "blocked"
          ? "No aplica: heartbeat está bloqueado."
          : "Si corre por heartbeat, documenta no-action path.",
    },
    {
      item: "Body length ≤5,000 tokens; long references moved to references/.",
      status: "PASS",
      note: `El parser ya validó el límite de ${MAX_SKILL_BODY_TOKENS} tokens.`,
    },
    {
      item: "Skill does not ask the model to invent data unavailable through tools.",
      status: /nunca asumas|no asumas|no invent/.test(instructionTextLower)
        ? "PASS"
        : "WARN",
      note: /nunca asumas|no asumas|no invent/.test(instructionTextLower)
        ? "La habilidad evita asumir datos no observados."
        : "Conviene decir explícitamente que no asuma/invente datos.",
    },
  ];
}

export async function POST(request: Request) {
  try {
    ensureAgentToolDepsWired();
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as SkillAuthoringRequest;
    const caseType = cleanText(body.caseType);
    const displayName = cleanText(body.displayName);
    const description = cleanText(body.description);
    const fieldList = cleanText(body.fieldList);
    const skillSlug = cleanText(body.skillSlug);
    const baseSkillSlug = cleanText(body.baseSkillSlug) || skillSlug;
    const baseSkillBody = await readGlobalSkillBody(baseSkillSlug);

    if (!displayName && !description) {
      return NextResponse.json(
        { error: "displayName or description required" },
        { status: 400 }
      );
    }

    const db = createServerClient();
    const { data: profile } = await supabase
      .from("profiles")
      .select("name, agent_system_prompt, timezone, email, phone, business_brain, is_ungga_admin")
      .eq("id", user.id)
      .single();
    const { data: toolSettings } = await supabase
      .from("user_tool_settings")
      .select("*")
      .eq("user_id", user.id);
    const { data: skillSettings } = await supabase
      .from("user_skill_settings")
      .select("*")
      .eq("user_id", user.id);

    let session = await supabase
      .from("agent_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("channel", "web")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()
      .then((r) => r.data);
    if (!session) {
      const { data } = await supabase
        .from("agent_sessions")
        .insert({
          user_id: user.id,
          channel: "web",
          status: "active",
          budget_tokens_used: 0,
          budget_tokens_limit: 100000,
        })
        .select()
        .single();
      session = data;
    }
    if (!session) {
      return NextResponse.json(
        { error: "Failed to create session" },
        { status: 500 }
      );
    }

    const baseAuthoringPrompt = [
      "Usa la skill `skill-authoring` para proponer un SKILL.md optimizado para Gu OS.",
      "FORMATO DE SALIDA OBLIGATORIO (no añadas texto fuera de las etiquetas):",
      "<metadata>",
      `{"suggestedEvals":{"positive":["..."],"nearMiss":["..."],"heartbeat":["..."]},"notes":"<opcional, ≤300 chars, solo si es concreta>"}`,
      "</metadata>",
      "<skill-draft>",
      "...el SKILL.md completo aquí, tal cual, sin escapar nada, sin ```fences```...",
      "</skill-draft>",
      "Reglas del bloque <metadata>:",
      "- JSON válido. Una sola línea preferible. Sin saltos dentro de strings.",
      "- NO incluyas `validationRubric`; el backend la calcula con el parser real y checks determinísticos.",
      "- NO incluyas `activationRecommendation`; el backend la calcula a partir de la rúbrica.",
      "- `notes` es OPCIONAL: inclúyelo solo si nombra un campo, paso, tool o riesgo exacto. Omítelo si sería genérico como \"revisar validación\" o \"checar flujo\". Máximo 300 caracteres.",
      "- Mantén `suggestedEvals` con máximo 3 elementos por lista; si no hay heartbeat, omite la clave.",
      "Nunca metas el SKILL.md dentro del JSON: va exclusivamente en <skill-draft>.",
      "",
      "Reglas no negociables para el skillDraft:",
      "- El frontmatter debe usar el subset YAML que soporta el parser de Gu: solo `key: value`, strings entre comillas, `[]`, listas con `- item`, o bloques literales `key: |` (no `|-`, `|+`, `>`, `>-`, `>+`).",
      "- `description` es metadata de routing: una frase/párrafo corto con qué hace, Use when..., Do not use...; NO pongas bullets, tablas ni el workflow completo ahí.",
      "- Prefiere `description` en una sola línea con comillas dobles. Si necesitas multilínea, usa exactamente `description: |` (clip mode) y deja el cuerpo indentado dos espacios.",
      "- Para casos operacionales, el UI crea instancias con `current_step=intake`. El body DEBE describir cómo se transiciona desde `intake` al primer paso operativo, validando los campos del intake_schema antes de avanzar.",
      "- El body también DEBE cubrir el camino conversacional: si el usuario pide el workflow desde chat/Telegram sin caso_id, la skill pregunta los campos required de intake_schema_jsonb y crea el caso con la tool `operational_case_create` (no envía mensajes externos en ese paso).",
      "- Si el borrador menciona `operational_case_create` en el body, DEBE incluirla también en `allowed_tools`; si no, el runtime no podrá ejecutarla (rúbrica: FAIL).",
      "- El primer paso del workflow no debe contradecir el camino conversacional: si falta `case_id`, instruye crear el caso con `operational_case_create` tras recoger intake; no limites la respuesta a \"abre el caso en la UI\".",
      "- Si no puedes inferir una transición o un dato crítico desde el contexto, marca WARN en la rúbrica y pide exactamente qué información falta.",
      "- La rúbrica debe usar N/A para checks que no aplican (por ejemplo heartbeat no-action cuando heartbeat=blocked).",
      "",
      "Contexto del caso de uso:",
      JSON.stringify(
        {
          caseType,
          displayName,
          skillSlug,
          description,
          fieldList,
          intakeSchema: body.intakeSchema ?? null,
          baseSkillSlug,
          hasBaseSkillBody: Boolean(baseSkillBody),
        },
        null,
        2
      ),
      "",
      baseSkillBody
        ? `SKILL.md global base (úsalo como baseline y documenta el delta, no regeneres desde cero):\n\n${baseSkillBody}`
        : "No se encontró SKILL.md global base; genera un draft nuevo aplicando la rúbrica completa.",
    ].join("\n");

    const RETRY_PROMPT_PREFIX = [
      "REINTENTO: el intento anterior tuvo metadata truncada o no parseable. Esta vez:",
      "- Mantén la metadata primero y el draft completo después.",
      "- No incluyas `validationRubric` ni `activationRecommendation`.",
      "- Recorta `suggestedEvals` a ≤2 elementos por lista y omite `notes` si no es concreta.",
      "- Garantiza que `<metadata>` cierra y el JSON es válido en una sola línea.",
      "- Garantiza que `<skill-draft>` también cierra; si necesitas ahorrar tokens, compacta el cuerpo sin perder reglas críticas.",
      "",
    ].join("\n");

    const encoder = new TextEncoder();
    const startedAt = Date.now();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: AuthoringEvent) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };
        const stage = (stageId: string, message: string, attempt?: number) => {
          send({
            type: "stage",
            stage: stageId,
            message,
            attempt,
            ts: Date.now(),
          });
        };

        const MAX_AUTHORING_ATTEMPTS = 3;
        let result: Awaited<ReturnType<typeof runAgent>> | null = null;
        let parsedAuthoring: ReturnType<typeof parseAuthoringResponse> | null =
          null;
        let lastParseError: unknown = null;
        let attemptsUsed = 0;

        try {
          stage("context_loaded", "Contexto cargado; preparando prompt de authoring.");
          for (let attempt = 1; attempt <= MAX_AUTHORING_ATTEMPTS; attempt += 1) {
            attemptsUsed = attempt;
            const promptForAttempt =
              attempt === 1
                ? baseAuthoringPrompt
                : RETRY_PROMPT_PREFIX + baseAuthoringPrompt;
            stage(
              "attempt_started",
              `Ejecutando skill-authoring (intento ${attempt}/${MAX_AUTHORING_ATTEMPTS}).`,
              attempt
            );
            const attemptStartedAt = Date.now();
            let progressTickCount = 0;
            const progressTimer = setInterval(() => {
              progressTickCount += 1;
              const seconds = Math.floor((Date.now() - attemptStartedAt) / 1000);
              stage(
                "attempt_progress",
                `Skill-authoring sigue ejecutándose (intento ${attempt}); ${seconds}s transcurridos.`,
                attempt
              );
            }, 15000);
            let attemptResult: Awaited<ReturnType<typeof runAgent>>;
            try {
              attemptResult = await runAgent({
                message: promptForAttempt,
                userId: user.id,
                sessionId: session.id,
                systemPrompt:
                  (profile?.agent_system_prompt as string) ??
                  "Eres Gu, asistente operativo.",
                db,
                enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
                  id: t.id as string,
                  user_id: t.user_id as string,
                  tool_id: t.tool_id as string,
                  enabled: t.enabled as boolean,
                  config_json: (t.config_json as Record<string, unknown>) ?? {},
                })),
                enabledSkills: (skillSettings ?? []).map((s: Record<string, unknown>) => ({
                  id: s.id as string,
                  user_id: s.user_id as string,
                  skill_id: s.skill_id as string,
                  enabled: s.enabled as boolean,
                  config_json: (s.config_json as Record<string, unknown>) ?? {},
                })),
                integrations: [],
                userTimezone: (profile?.timezone as string) ?? undefined,
                userName: (profile?.name as string | null) ?? null,
                userEmail: (profile?.email as string | null) ?? null,
                userPhone: (profile?.phone as string | null) ?? null,
                businessBrain:
                  (profile?.business_brain as Record<string, unknown> | null) ?? {},
                isUnggaAdmin: (profile?.is_ungga_admin as boolean | null) ?? false,
                channel: "web",
                forcedSkillId: "skill-authoring",
              });
            } finally {
              clearInterval(progressTimer);
            }
            result = attemptResult;
            stage(
              "attempt_completed",
              progressTickCount > 0
                ? `Respuesta recibida del intento ${attempt} tras ${Math.floor(
                    (Date.now() - attemptStartedAt) / 1000
                  )}s.`
                : `Respuesta recibida del intento ${attempt}.`,
              attempt
            );
            try {
              const parsed = parseAuthoringResponse(attemptResult.response);
              if (!parsed.metadataTruncated || attempt === MAX_AUTHORING_ATTEMPTS) {
                parsedAuthoring = parsed;
                stage(
                  parsed.metadataTruncated ? "metadata_recovered" : "metadata_parsed",
                  parsed.metadataTruncated
                    ? "Metadata recuperada parcialmente; se usará la validación backend."
                    : "Metadata parseada correctamente.",
                  attempt
                );
                break;
              }
              parsedAuthoring = parsed;
              stage(
                "metadata_recovered_retrying",
                "Metadata recuperada parcialmente; reintentando para mejorar la respuesta.",
                attempt
              );
              console.warn(
                `[POST /api/skill-authoring] attempt ${attempt} returned recovered metadata; retrying`
              );
            } catch (err) {
              lastParseError = err;
              stage(
                "parse_failed_retrying",
                `No se pudo parsear la respuesta del intento ${attempt}.`,
                attempt
              );
              console.warn(
                `[POST /api/skill-authoring] attempt ${attempt} parse failed:`,
                err
              );
              if (attempt === MAX_AUTHORING_ATTEMPTS) break;
            }
          }

          if (!parsedAuthoring || !result) {
            send({
              type: "error",
              error: "invalid_agent_response",
              details:
                lastParseError instanceof Error
                  ? lastParseError.message
                  : String(lastParseError ?? "unknown_parse_error"),
              raw: result?.response,
              ts: Date.now(),
            });
            controller.close();
            return;
          }

          const { skillDraft: rawSkillDraft, metadata: parsed, metadataTruncated } =
            parsedAuthoring;

          stage("normalizing", "Normalizando frontmatter para el parser de Gu.");
          const skillDraft = normalizeSkillDraft(rawSkillDraft);
          let parsedSkill: SkillRecord | null = null;
          let parseError: unknown = null;
          try {
            parsedSkill = parseAccountSkillSource(
              skillDraft,
              skillSlug || baseSkillSlug,
              user.id
            );
            stage("parser_validation_pass", "El parser de Gu aceptó el SKILL.md.");
          } catch (err) {
            parseError = err;
            stage("parser_validation_fail", "El parser de Gu encontró errores en el SKILL.md.");
          }
          stage("rubric_building", "Construyendo rúbrica determinística backend.");
          const validationRubric = await buildBackendRubric({
            record: parsedSkill,
            parserError: parseError,
            skillDraft,
            expectedSlug: skillSlug || baseSkillSlug,
          });
          const hasBlockingIssue = validationRubric.some(
            (item) => item.status === "FAIL"
          );
          const hasWarning = validationRubric.some((item) => item.status === "WARN");
          const baseRecommendation = hasBlockingIssue
            ? "No activar todavía: hay errores bloqueantes de validación. Corrige el SKILL.md y vuelve a validar antes de guardarlo."
            : hasWarning
              ? "Revisar antes de activar: no hay errores bloqueantes, pero quedan advertencias en la rúbrica."
              : "Lista para activar: el SKILL.md pasó la validación del parser y la rúbrica no contiene advertencias ni errores.";
          const modelNotes = concreteModelNote(parsed.notes);
          const activationRecommendation = modelNotes
            ? `${baseRecommendation}\n\nNotas del modelo: ${modelNotes}`
            : baseRecommendation;
          const elapsedMs = Date.now() - startedAt;

          stage("done", "Borrador listo; enviando resultado final.");
          send({
            type: "result",
            payload: {
              ok: true,
              skillDraft,
              validationRubric,
              suggestedEvals: isRecord(parsed.suggestedEvals)
                ? parsed.suggestedEvals
                : {},
              activationRecommendation,
              parserValid: Boolean(parsedSkill),
              metadataTruncated,
              attemptsUsed,
              elapsedMs,
              raw: result.response,
              turnId: result.turnId,
            },
            ts: Date.now(),
          });
          controller.close();
        } catch (err) {
          console.error("[POST /api/skill-authoring] stream failed:", err);
          send({
            type: "error",
            error: "Internal error",
            details: err instanceof Error ? err.message : String(err),
            ts: Date.now(),
          });
          controller.close();
        }
      },
    });

    return ndjsonResponse(stream);
  } catch (err) {
    console.error("[POST /api/skill-authoring] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
