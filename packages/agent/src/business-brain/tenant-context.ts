/**
 * V1-C-α: bloque `[Contexto de tenant]`.
 *
 * Cuando la skill activa marca `requires_tenant_context: true` (en su
 * frontmatter), `runAgent` materializa este bloque y lo concatena al
 * SystemMessage del turno. El bloque enseña al modelo:
 *
 *   - en qué MODO está (OBLIGATORIO vs ADMIN UNGGA),
 *   - qué `organization_id` aplicar (si aplica),
 *   - qué project / location de BigQuery usar,
 *   - cómo manejar ambigüedad cuando el usuario no nombra inmobiliaria.
 *
 * Decisiones explícitas:
 *
 * 1. **No hacemos i18n**: el bloque va en español, igual que las
 *    referencias de la skill. Las anclas léxicas técnicas
 *    ("cross-tenant", "MODO OBLIGATORIO", "MODO ADMIN UNGGA") quedan
 *    consistentes con la subsección "Cross-tenant" de los `fewshots-*.md`,
 *    que es donde el modelo va a buscar los patrones.
 *
 * 2. **Detección de "inmobiliaria mencionada en el turno"** (Caso 3):
 *    heurística simple por palabra-clave + match contra `org_name`s
 *    conocidos. NO hacemos un round-trip a BigQuery aquí — ese trabajo
 *    es del SQL (helper `org_name → organization_id` en
 *    `references/conventions.md`). Aquí solo bajamos al modelo una
 *    pista: "este turno mencionó X, resuélvelo con el helper".
 *
 * 3. **No hacemos `read_skill_reference`** desde aquí. Este módulo no
 *    sabe qué skill está activa; solo sabe los datos del tenant. La
 *    skill ya tiene en su body las instrucciones para usar los
 *    references — este bloque añade contexto, no comportamiento.
 *
 * 4. **Defensivo con datos faltantes**: si `business_brain.identity` está
 *    vacío y el usuario no es admin Ungga, devolvemos un MODO OBLIGATORIO
 *    "no configurado" que le dice al modelo que pida configurar la
 *    inmobiliaria en Settings antes de correr ningún query.
 */
import type { BusinessBrain } from "@agents/types";

export interface BuildTenantContextArgs {
  /** Business Brain del perfil (puede venir vacío `{}`). */
  readonly businessBrain: BusinessBrain;
  /** TRUE para staff Ungga (visibilidad cross-tenant). */
  readonly isUnggaAdmin: boolean;
  /** Mensaje del usuario en este turno; usado para detectar nombres de
   *  inmobiliarias mencionadas (solo cuando `isUnggaAdmin = true`). */
  readonly userMessage: string | undefined;
  /** Override de `business_brain.bigquery.project_id` cuando V1 corre con
   *  `BIGQUERY_PROJECT_ID` env. `undefined` = leer del Business Brain. */
  readonly defaultProjectId?: string;
  /** Análogo para `location`. */
  readonly defaultLocation?: string;
}

export type TenantContextMode =
  | "obligatorio"
  | "obligatorio_no_configurado"
  | "admin_cross_tenant"
  | "admin_organizacion_mencionada";

export interface TenantContextResult {
  /** Texto listo para concatenar al SystemMessage. Vacío si no aplica. */
  readonly block: string;
  /** Modo resuelto, expuesto para logging / tests. */
  readonly mode: TenantContextMode;
  /** organization_id efectivo para este turno (puede ser undefined). */
  readonly organizationId?: string;
  /** Org name detectado en el mensaje (solo Caso 3). */
  readonly mentionedOrgName?: string;
}

/** Heurística mínima para encontrar nombres de inmobiliarias en un turno
 *  cuando el admin Ungga escribe libremente. Detecta:
 *
 *    - "inmobiliaria(s) <Nombre> [Más] [Más]"  (la palabra "inmobiliaria"
 *      es case-insensitive; el nombre es 1..4 palabras CAPITALIZADAS
 *      consecutivas — así no se traga complementos en minúscula como
 *      "este mes", "del año", etc.).
 *    - "<X>" si está entre comillas (rectas, tipográficas, francesas).
 *
 *  NO intenta resolver el id — eso lo hace el SQL helper en
 *  `references/conventions.md`. Solo extrae el fragmento textual.
 */
const NAME_PROPER = "[A-ZÁÉÍÓÚÜÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9\\-]+";
const NAME_PROPER_RUN_RE = new RegExp(
  `^(${NAME_PROPER}(?:\\s+${NAME_PROPER}){0,3})`
);
const TRIGGER_INMOBILIARIA_RE = /\binmobiliaria(?:s)?\s+/i;

function extractMentionedOrgName(message: string | undefined): string | undefined {
  if (!message) return undefined;

  const trigger = TRIGGER_INMOBILIARIA_RE.exec(message);
  if (trigger) {
    const tail = message.slice(trigger.index + trigger[0].length);
    const m1 = tail.match(NAME_PROPER_RUN_RE);
    if (m1?.[1]) {
      const cleaned = m1[1].replace(/\s{2,}/g, " ").trim();
      if (cleaned.length >= 2) return cleaned;
    }
  }
  // Comillas: rectas, tipográficas, francesas. Aquí sí permitimos multi-palabra
  // libre porque el usuario citó explícitamente el nombre.
  const m2 = message.match(/["“«]([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][\wÁÉÍÓÚÜÑáéíóúüñ\-\s]{1,40})["”»]/);
  if (m2?.[1]) {
    const cleaned = m2[1].trim();
    if (cleaned.length >= 2) return cleaned;
  }
  return undefined;
}

function formatBigqueryLine(
  bq: BusinessBrain["bigquery"],
  defaults: { defaultProjectId?: string; defaultLocation?: string }
): string {
  const project =
    bq?.project_id ?? defaults.defaultProjectId ?? "(no configurado)";
  const location =
    bq?.location ?? defaults.defaultLocation ?? "(no configurada)";
  return `- BigQuery project: ${project} | location: ${location}`;
}

/**
 * Construye el bloque `[Contexto de tenant]`. Devuelve `block: ""` si no
 * hay nada útil que decir (por ejemplo, business brain vacío y no admin —
 * en ese caso preferimos un modo "no configurado" explícito antes que
 * un bloque silencioso, así que esto no debería pasar; el `""` es para
 * llamadas explícitas con `isUnggaAdmin=false` y BB vacío que el caller
 * decide ignorar).
 */
export function buildTenantContextBlock(
  args: BuildTenantContextArgs
): TenantContextResult {
  const { businessBrain, isUnggaAdmin, userMessage } = args;
  const bq = businessBrain.bigquery;
  const identity = businessBrain.identity;

  // ── Caso ADMIN UNGGA ────────────────────────────────────────────────
  if (isUnggaAdmin) {
    const mentioned = extractMentionedOrgName(userMessage);

    if (mentioned) {
      const lines: string[] = [
        "[Contexto de tenant — generado automáticamente]",
        "- MODO: ADMIN UNGGA (usuario interno de Ungga con visibilidad cross-tenant).",
        `- Inmobiliaria mencionada en el turno: "${mentioned}". Resuélvela a su \`organization_id\` con el helper \`org_name → organization_id\` de \`references/conventions.md\` y aplica \`u.organization_id = (resultado del helper)\` en TODOS los queries de este turno.`,
        "- Si el helper devuelve más de una coincidencia, enuméralas y pide confirmación al usuario antes de correr la métrica.",
        "- Si el helper no encuentra ninguna, díselo al usuario y NO inventes el id.",
        formatBigqueryLine(bq, args),
        "- Pasa parámetros literales (fechas, organization_id, etc.) como `@params` en `bigquery_run_query`, no los concatenes en el SQL.",
      ];
      return {
        block: lines.join("\n"),
        mode: "admin_organizacion_mencionada",
        mentionedOrgName: mentioned,
      };
    }

    const lines: string[] = [
      "[Contexto de tenant — generado automáticamente]",
      "- MODO: ADMIN UNGGA (usuario interno de Ungga con visibilidad cross-tenant).",
      formatBigqueryLine(bq, args),
      "- Reglas para queries BigQuery:",
      "  · Por defecto, los queries son cross-tenant (sin filtro de `organization_id`). Usa los patrones de la subsección \"Cross-tenant\" en cada `fewshots-*.md`.",
      "  · Si el usuario nombra una inmobiliaria (\"Garios\", \"Inmobiliaria Ruz\", etc.), aplica el helper `org_name → organization_id` de `references/conventions.md` y filtra por ese `organization_id`. Si el helper devuelve más de una coincidencia, enuméralas y pide confirmación antes de correr la métrica.",
      "  · Si el usuario es ambiguo (\"dame datos del mes\"), pregunta UNA cosa: \"¿de qué inmobiliaria(s) o de todas?\".",
      "- Pasa parámetros literales (fechas, organization_id, etc.) como `@params` en `bigquery_run_query`, no los concatenes en el SQL.",
    ];
    return {
      block: lines.join("\n"),
      mode: "admin_cross_tenant",
    };
  }

  // ── Caso usuario regular ────────────────────────────────────────────
  const orgId = identity?.organization_id?.trim();
  const orgName = identity?.org_name?.trim();

  if (!orgId) {
    const lines: string[] = [
      "[Contexto de tenant — generado automáticamente]",
      "- MODO: OBLIGATORIO (usuario de inmobiliaria) — **inmobiliaria NO configurada todavía**.",
      "- Esta cuenta aún no tiene un `organization_id` registrado en su Business Brain. NO corras consultas a BigQuery: pídele al usuario que vaya a Ajustes → Inmobiliaria y registre su `organization_id` y nombre. Solo después puedes consultar datos.",
      formatBigqueryLine(bq, args),
    ];
    return {
      block: lines.join("\n"),
      mode: "obligatorio_no_configurado",
    };
  }

  const orgLabel = orgName ? `${orgId} (${orgName})` : orgId;
  const lines: string[] = [
    "[Contexto de tenant — generado automáticamente]",
    "- MODO: OBLIGATORIO (usuario de inmobiliaria).",
    `- \`organization_id\` del usuario: ${orgLabel}.`,
    formatBigqueryLine(bq, args),
    "- Reglas no negociables para queries BigQuery:",
    "  · TODO query DEBE filtrar por `u.organization_id = @organization_id` (o joinear vía un CTE `user_ids` que lo aplique).",
    "  · NO devolver ni mencionar datos de otras inmobiliarias, aunque el usuario lo pida directamente.",
    `  · Si la pregunta es ambigua respecto a otra inmobiliaria, declina y aclara: "Solo puedo consultar datos de ${orgName ?? "tu inmobiliaria"}".`,
    "- Pasa el `organization_id` como parámetro literal `@organization_id` en `bigquery_run_query`, no lo concatenes en el SQL.",
  ];
  return {
    block: lines.join("\n"),
    mode: "obligatorio",
    organizationId: orgId,
  };
}

/**
 * Helper de conveniencia para `runAgent`: concatena el bloque al system
 * prompt si la skill activa lo requiere. Si `requiresTenantContext` es
 * `false` o el bloque sale vacío, devuelve `basePrompt` sin cambios.
 */
export function appendTenantContextBlock(
  basePrompt: string,
  args: BuildTenantContextArgs & { readonly requiresTenantContext: boolean }
): { prompt: string; result: TenantContextResult | null } {
  if (!args.requiresTenantContext) {
    return { prompt: basePrompt, result: null };
  }
  const result = buildTenantContextBlock(args);
  if (!result.block) {
    return { prompt: basePrompt, result };
  }
  return {
    prompt: `${basePrompt.trimEnd()}\n\n${result.block}`,
    result,
  };
}
