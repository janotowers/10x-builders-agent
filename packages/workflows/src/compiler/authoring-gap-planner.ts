/**
 * Planificador puro de gaps de authoring.
 *
 * El modelo identifica candidatos semánticos. Este módulo asigna identidad,
 * conserva estado entre turnos y decide qué preguntar sin inferir semántica.
 */
import { z } from "zod";

export const AUTHORING_GAP_SEVERITIES = [
  "blocking",
  "defaultable",
  "optional",
] as const;
export const AUTHORING_GAP_STATES = [
  "open",
  "asked",
  "answered",
  "resolved_by_evidence",
  "blocked_dependency",
  "defaulted",
] as const;
export const AUTHORING_GAP_RESOLUTION_STATUSES = [
  "resolved",
  "partial",
  "unanswered",
  "superseded",
  "open",
] as const;
export const AUTHORING_GAP_PLAN_VERSION = 2 as const;
export const AUTHORING_GAP_DEFAULT_PRIORITY = 50;
export const AUTHORING_GAP_MAX_QUESTIONS = 4;
export const AUTHORING_GAP_MAX_ASK_COUNT = 2;

export const authoringGapCandidateSchema = z.object({
  id: z.string().trim().regex(/^gap_[a-z0-9]{8}$/).optional(),
  key: z.string().trim().min(1).max(160).optional(),
  /**
   * Identidad canónica de la afirmación faltante. La semántica la aporta el
   * modelo o un patrón registrado; este módulo solo conserva esa identidad.
   */
  claim_identity: z.string().trim().min(1).max(160).optional(),
  summary: z.string().trim().min(1).max(500),
  target_dimension: z.string().trim().min(1).max(64),
  question: z.string().trim().min(1).max(2000).optional(),
  severity: z.enum(AUTHORING_GAP_SEVERITIES),
  depends_on: z.array(z.string().trim().min(1).max(160)).max(16).default([]),
  priority: z.number().int().min(0).max(100).default(
    AUTHORING_GAP_DEFAULT_PRIORITY
  ),
  safe_default: z.string().trim().min(1).max(1000).optional(),
  examples: z.array(z.string().trim().min(1).max(240)).max(3).default([]),
});

const authoringGapV2Schema = authoringGapCandidateSchema
  .omit({ id: true, depends_on: true })
  .extend({
    id: z.string().trim().regex(/^gap_[a-z0-9]{8}$/),
    state: z.enum(AUTHORING_GAP_STATES).default("open"),
    resolution_status: z.enum(AUTHORING_GAP_RESOLUTION_STATUSES).default("open"),
    depends_on: z
      .array(z.string().trim().regex(/^gap_[a-z0-9]{8}$/))
      .max(16)
      .default([]),
    priority: z.number().int().min(0).max(100).default(
      AUTHORING_GAP_DEFAULT_PRIORITY
    ),
    age: z.number().int().nonnegative().default(0),
    ask_count: z.number().int().nonnegative().default(0),
    times_reopened: z.number().int().nonnegative().default(0),
    resolution: z.string().trim().min(1).max(2000).optional(),
    evidence: z.array(z.string().min(1).max(8000)).max(64).default([]),
    residual: z.string().min(1).max(8000).optional(),
    superseded_by: z
      .string()
      .trim()
      .regex(/^gap_[a-z0-9]{8}$/)
      .optional(),
  });

function legacyResolutionStatus(value: Record<string, unknown>): string {
  if (typeof value.resolution_status === "string") {
    return value.resolution_status;
  }
  return value.state === "answered" ||
    value.state === "resolved_by_evidence" ||
    value.state === "defaulted"
    ? "resolved"
    : "open";
}

/** Parses both v2 gaps and v1 gaps that did not separate queue and semantics. */
export const authoringGapSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  return {
    ...value,
    resolution_status: legacyResolutionStatus(value),
    evidence: value.evidence ?? [],
  };
}, authoringGapV2Schema);

export const authoringGapPlanCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  blockers: z.number().int().nonnegative(),
  defaultable: z.number().int().nonnegative(),
  optional: z.number().int().nonnegative(),
  askable: z.number().int().nonnegative(),
});

export const authoringAppliedDefaultSchema = z.object({
  gap_id: z.string().trim().regex(/^gap_[a-z0-9]{8}$/),
  value: z.string().trim().min(1).max(1000),
});

const authoringGapPlanV2Schema = z.object({
  version: z.literal(AUTHORING_GAP_PLAN_VERSION).default(
    AUTHORING_GAP_PLAN_VERSION
  ),
  gaps: z.array(authoringGapSchema).max(128).default([]),
  counts: authoringGapPlanCountsSchema,
  can_proceed: z.boolean(),
});

/**
 * Backward-compatible parser for persisted v1 plans. Queue state is retained
 * verbatim and terminal v1 states acquire the equivalent semantic status.
 */
export const authoringGapPlanSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1 && value.version !== undefined) return value;
  return {
    ...value,
    version: AUTHORING_GAP_PLAN_VERSION,
  };
}, authoringGapPlanV2Schema);

export type AuthoringGapCandidate = z.input<typeof authoringGapCandidateSchema>;
export type AuthoringGap = z.infer<typeof authoringGapSchema>;
export type AuthoringGapPlan = z.infer<typeof authoringGapPlanSchema>;
export type AuthoringGapPlanCounts = z.infer<
  typeof authoringGapPlanCountsSchema
>;
export type AuthoringAppliedDefault = z.infer<
  typeof authoringAppliedDefaultSchema
>;

export const authoringPriorGapDispositionSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const value = raw as Record<string, unknown>;
  const residual =
    typeof value.residual === "string" ? value.residual.trim() : value.residual;
  const supersededBy =
    typeof value.superseded_by === "string"
      ? value.superseded_by.trim()
      : value.superseded_by;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : value.evidence;
  // Providers often emit residual:"" on non-partial rows; empty means absent.
  // A claimed partial without residual is salvaged to unanswered so a flaky
  // empty string does not fail-close an otherwise usable turn.
  const status =
    value.status === "partial" && !residual ? "unanswered" : value.status;
  return {
    ...value,
    status,
    evidence,
    residual: residual || undefined,
    superseded_by: supersededBy || undefined,
  };
}, z
  .object({
    gap_id: z.string().trim().regex(/^gap_[a-z0-9]{8}$/),
    status: z.enum(AUTHORING_GAP_RESOLUTION_STATUSES),
    evidence: z.array(z.string().min(1).max(8000)).max(64).default([]),
    residual: z.string().min(1).max(8000).optional(),
    superseded_by: z
      .string()
      .trim()
      .regex(/^gap_[a-z0-9]{8}$/)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "partial" && value.residual === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["residual"],
        message: "partial requiere residual explícito",
      });
    }
    if (value.status === "superseded" && value.superseded_by === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["superseded_by"],
        message: "superseded requiere superseded_by",
      });
    }
  }));

export type AuthoringPriorGapDisposition = z.infer<
  typeof authoringPriorGapDispositionSchema
>;

const TERMINAL_RESOLUTION_STATUSES = new Set<
  AuthoringGap["resolution_status"]
>([
  "resolved",
  "superseded",
]);

function normalizedIdentity(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(8, "0").slice(-8);
}

/** ID estable derivado solo de la identidad semántica suministrada. */
export function createAuthoringGapId(
  candidate: Pick<
    AuthoringGapCandidate,
    "id" | "key" | "claim_identity" | "summary" | "target_dimension"
  >
): string {
  if (candidate.id) return candidate.id;
  const identity =
    candidate.claim_identity?.trim() ||
    candidate.key?.trim() ||
    `${candidate.target_dimension}:${normalizedIdentity(candidate.summary)}`;
  return `gap_${fnv1a32(normalizedIdentity(identity))}`;
}

/** Canonical claim identity supplied by the semantic layer. */
export function authoringGapClaimIdentity(
  candidate: Pick<
    AuthoringGapCandidate,
    "key" | "claim_identity" | "summary" | "target_dimension"
  >
): string {
  return (
    candidate.claim_identity?.trim() ||
    candidate.key?.trim() ||
    `${candidate.target_dimension}:${normalizedIdentity(candidate.summary)}`
  );
}

export function isAuthoringGapResolved(gap: AuthoringGap): boolean {
  return TERMINAL_RESOLUTION_STATUSES.has(gap.resolution_status);
}

function withDependencyState(gaps: readonly AuthoringGap[]): AuthoringGap[] {
  const byId = new Map(gaps.map((gap) => [gap.id, gap]));
  return gaps.map((gap) => {
    if (isAuthoringGapResolved(gap) || gap.state === "asked") return gap;
    const blocked = gap.depends_on.some((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return dependency === undefined || !isAuthoringGapResolved(dependency);
    });
    if (blocked) return { ...gap, state: "blocked_dependency" };
    if (gap.state === "blocked_dependency") return { ...gap, state: "open" };
    return gap;
  });
}

export function countAuthoringGapPlan(
  gaps: readonly AuthoringGap[]
): AuthoringGapPlanCounts {
  const unresolved = gaps.filter((gap) => !isAuthoringGapResolved(gap));
  return {
    total: gaps.length,
    unresolved: unresolved.length,
    blockers: unresolved.filter((gap) => gap.severity === "blocking").length,
    defaultable: unresolved.filter((gap) => gap.severity === "defaultable")
      .length,
    optional: unresolved.filter((gap) => gap.severity === "optional").length,
    askable: unresolved.filter(
      (gap) =>
        gap.state === "open" &&
        gap.ask_count < AUTHORING_GAP_MAX_ASK_COUNT &&
        Boolean(gap.question)
    ).length,
  };
}

export function canProceedWithAuthoringGapPlan(
  gapsOrPlan: readonly AuthoringGap[] | AuthoringGapPlan
): boolean {
  const gaps = Array.isArray(gapsOrPlan)
    ? gapsOrPlan
    : (gapsOrPlan as AuthoringGapPlan).gaps;
  return !gaps.some(
    (gap) => gap.severity === "blocking" && !isAuthoringGapResolved(gap)
  );
}

export function buildAuthoringGapPlan(
  gaps: readonly AuthoringGap[]
): AuthoringGapPlan {
  const parsed = gaps.map((gap) => authoringGapSchema.parse(gap));
  const unlocked = withDependencyState(parsed);
  return authoringGapPlanSchema.parse({
    version: AUTHORING_GAP_PLAN_VERSION,
    gaps: unlocked,
    counts: countAuthoringGapPlan(unlocked),
    can_proceed: canProceedWithAuthoringGapPlan(unlocked),
  });
}

/** Public parse/migration boundary for persisted plans from any supported version. */
export function parseAuthoringGapPlan(raw: unknown): AuthoringGapPlan {
  const parsed = authoringGapPlanSchema.parse(raw);
  return buildAuthoringGapPlan(parsed.gaps);
}

/** Named migration alias for persistence adapters that want an explicit step. */
export function migrateAuthoringGapPlan(raw: unknown): AuthoringGapPlan {
  return parseAuthoringGapPlan(raw);
}

/** Convierte candidatos del modelo en un plan determinístico. */
export function planAuthoringGaps(
  rawCandidates: readonly AuthoringGapCandidate[]
): AuthoringGapPlan {
  const candidates = rawCandidates.map((candidate) =>
    authoringGapCandidateSchema.parse(candidate)
  );
  const idsByKey = new Map<string, string>();
  for (const candidate of candidates) {
    const id = createAuthoringGapId(candidate);
    idsByKey.set(authoringGapClaimIdentity(candidate), id);
    if (candidate.key) idsByKey.set(candidate.key, id);
    idsByKey.set(id, id);
  }
  const seen = new Set<string>();
  const gaps: AuthoringGap[] = [];
  for (const candidate of candidates) {
    const id = createAuthoringGapId(candidate);
    if (seen.has(id)) continue;
    seen.add(id);
    gaps.push(
      authoringGapSchema.parse({
        ...candidate,
        claim_identity: authoringGapClaimIdentity(candidate),
        id,
        state: "open",
        resolution_status: "open",
        depends_on: candidate.depends_on
          .map(
            (dependency) =>
              idsByKey.get(dependency) ??
              (/^gap_[a-z0-9]{8}$/.test(dependency)
                ? dependency
                : `gap_${fnv1a32(normalizedIdentity(dependency))}`)
          ),
        age: 0,
        ask_count: 0,
        times_reopened: 0,
        evidence: [],
      })
    );
  }
  return buildAuthoringGapPlan(gaps);
}

/**
 * Migra sesiones anteriores. Sin severidad histórica, se usa `blocking`
 * conservadoramente: nunca convierte ausencia de metadata en permiso.
 */
export function migrateLegacyAuthoringGapPlan(params: {
  gaps?: readonly string[];
  questions?: readonly string[];
  questionDetails?: ReadonlyArray<{
    question: string;
    target_dimension?: string;
    gap?: string;
    gap_id?: string;
  }>;
}): AuthoringGapPlan {
  const details = params.questionDetails ?? [];
  const candidates: AuthoringGapCandidate[] = (params.gaps ?? []).map(
    (summary, index) => {
      const detail =
        details.find((entry) => entry.gap === summary) ?? details[index];
      return {
        key: detail?.gap_id ?? `legacy-gap:${normalizedIdentity(summary)}`,
        summary,
        target_dimension: detail?.target_dimension ?? "legacy",
        question: detail?.question ?? params.questions?.[index],
        severity: "blocking",
        priority: AUTHORING_GAP_DEFAULT_PRIORITY,
        depends_on: [],
      };
    }
  );
  for (const [index, detail] of details.entries()) {
    if (
      candidates.some(
        (candidate) =>
          candidate.question === detail.question || candidate.summary === detail.gap
      )
    ) {
      continue;
    }
    candidates.push({
      key: detail.gap_id ?? `legacy-question:${normalizedIdentity(detail.question)}`,
      summary: detail.gap ?? detail.question,
      target_dimension: detail.target_dimension ?? "legacy",
      question: detail.question,
      severity: "blocking",
      priority: AUTHORING_GAP_DEFAULT_PRIORITY,
      depends_on: [],
    });
  }
  for (const [index, question] of (params.questions ?? []).entries()) {
    if (candidates.some((candidate) => candidate.question === question)) continue;
    candidates.push({
      key: `legacy-question:${normalizedIdentity(question)}:${index}`,
      summary: question,
      target_dimension: "legacy",
      question,
      severity: "blocking",
      priority: AUTHORING_GAP_DEFAULT_PRIORITY,
      depends_on: [],
    });
  }
  return planAuthoringGaps(candidates);
}

function queueStateForDisposition(
  gap: AuthoringGap,
  disposition: AuthoringPriorGapDisposition
): AuthoringGap["state"] {
  switch (disposition.status) {
    case "resolved":
      return gap.state === "defaulted" || gap.state === "resolved_by_evidence"
        ? gap.state
        : "answered";
    case "partial":
    case "unanswered":
    case "open":
      return "open";
    case "superseded":
      return "answered";
  }
}

function applyPriorGapDisposition(
  gap: AuthoringGap,
  disposition: AuthoringPriorGapDisposition | undefined
): AuthoringGap {
  if (!disposition) return gap;
  const evidence = [...gap.evidence, ...disposition.evidence].filter(
    (entry, index, all) => all.indexOf(entry) === index
  );
  const reopensResolvedGap =
    isAuthoringGapResolved(gap) &&
    disposition.status !== "resolved" &&
    disposition.status !== "superseded";
  const resetsQuestion =
    disposition.status === "partial" &&
    disposition.residual !== undefined &&
    disposition.residual !== gap.question;
  return authoringGapSchema.parse({
    ...gap,
    state: queueStateForDisposition(gap, disposition),
    resolution_status: disposition.status,
    evidence,
    residual: disposition.residual,
    superseded_by: disposition.superseded_by,
    ask_count: resetsQuestion ? 0 : gap.ask_count,
    times_reopened:
      gap.times_reopened + (reopensResolvedGap ? 1 : 0),
    question:
      disposition.status === "partial"
        ? disposition.residual
        : gap.question,
    resolution:
      disposition.status === "resolved"
        ? disposition.evidence.at(-1) ?? gap.resolution ?? "resolved"
        : disposition.status === "partial"
          ? disposition.residual
          : disposition.status === "unanswered"
            ? "unanswered"
            : disposition.status === "superseded"
              ? `superseded_by:${disposition.superseded_by}`
              : gap.resolution,
  });
}

/**
 * Reconciliación append-preserving. A prior asked gap remains asked until an
 * explicit disposition says resolved, partial, unanswered, superseded or open;
 * absence from the next model output never reopens or closes it implicitly.
 */
export function reconcileAuthoringGapPlan(params: {
  previous?: unknown;
  candidates?: readonly AuthoringGapCandidate[];
  priorGapDispositions?: readonly AuthoringPriorGapDisposition[];
  /** @deprecated Prefer priorGapDispositions with exact evidence. */
  answeredGapIds?: readonly string[];
  /** @deprecated Prefer priorGapDispositions with exact evidence. */
  evidenceResolvedGapIds?: readonly string[];
}): AuthoringGapPlan {
  const incoming = planAuthoringGaps(params.candidates ?? []).gaps;
  const previous =
    params.previous === undefined ? [] : parseAuthoringGapPlan(params.previous).gaps;
  const incomingById = new Map(incoming.map((gap) => [gap.id, gap]));
  const incomingByClaim = new Map(
    incoming.map((gap) => [authoringGapClaimIdentity(gap), gap])
  );
  const dispositions = new Map<string, AuthoringPriorGapDisposition>();
  const explicitDispositionIds = new Set<string>();
  for (const rawDisposition of params.priorGapDispositions ?? []) {
    const disposition = authoringPriorGapDispositionSchema.parse(rawDisposition);
    dispositions.set(disposition.gap_id, disposition);
    explicitDispositionIds.add(disposition.gap_id);
  }
  for (const gapId of params.answeredGapIds ?? []) {
    if (!dispositions.has(gapId)) {
      dispositions.set(gapId, {
        gap_id: gapId,
        status: "resolved",
        evidence: [],
      });
    }
  }
  for (const gapId of params.evidenceResolvedGapIds ?? []) {
    if (!dispositions.has(gapId)) {
      dispositions.set(gapId, {
        gap_id: gapId,
        status: "resolved",
        evidence: [],
      });
    }
  }
  const evidenced = new Set(params.evidenceResolvedGapIds ?? []);
  const applyDisposition = (gap: AuthoringGap): AuthoringGap => {
    const applied = applyPriorGapDisposition(gap, dispositions.get(gap.id));
    if (evidenced.has(gap.id) && !explicitDispositionIds.has(gap.id)) {
      return authoringGapSchema.parse({
        ...applied,
        state: "resolved_by_evidence",
        resolution: applied.resolution ?? "resolved_by_evidence",
      });
    }
    return applied;
  };
  const merged: AuthoringGap[] = previous.map((oldGap) => {
    const next =
      incomingById.get(oldGap.id) ??
      incomingByClaim.get(authoringGapClaimIdentity(oldGap));
    if (next) {
      incomingById.delete(next.id);
      incomingByClaim.delete(authoringGapClaimIdentity(next));
    }
    const updated = authoringGapSchema.parse({
      ...oldGap,
      ...(next ?? {}),
      id: oldGap.id,
      key: next?.key ?? oldGap.key,
      claim_identity:
        next?.claim_identity ??
        oldGap.claim_identity ??
        authoringGapClaimIdentity(oldGap),
      state: oldGap.state,
      resolution_status: oldGap.resolution_status,
      age: isAuthoringGapResolved(oldGap) ? oldGap.age : oldGap.age + 1,
      ask_count: oldGap.ask_count,
      times_reopened: oldGap.times_reopened,
      resolution: oldGap.resolution,
      evidence: oldGap.evidence,
      residual: oldGap.residual,
      superseded_by: oldGap.superseded_by,
    });
    return applyDisposition(updated);
  });
  for (const gap of incomingById.values()) {
    merged.push(applyDisposition(gap));
  }
  return buildAuthoringGapPlan(merged);
}

/**
 * Selecciona y marca como `asked`. Prioridad efectiva incluye edad, por lo que
 * un gap abierto no puede quedar postergado indefinidamente.
 */
export function selectAuthoringGapQuestions(
  plan: AuthoringGapPlan,
  maxQuestions = AUTHORING_GAP_MAX_QUESTIONS
): {
  plan: AuthoringGapPlan;
  gaps: AuthoringGap[];
  questions: string[];
} {
  const limit = Math.max(0, Math.min(AUTHORING_GAP_MAX_QUESTIONS, maxQuestions));
  const severityRank: Record<AuthoringGap["severity"], number> = {
    blocking: 3,
    defaultable: 2,
    optional: 1,
  };
  const selected = plan.gaps
    .filter(
      (gap) =>
        gap.state === "open" &&
        (gap.resolution_status === "open" ||
          gap.resolution_status === "partial" ||
          gap.resolution_status === "unanswered") &&
        gap.ask_count < AUTHORING_GAP_MAX_ASK_COUNT &&
        Boolean(gap.question)
    )
    .sort(
      (left, right) =>
        severityRank[right.severity] - severityRank[left.severity] ||
        right.age * 101 +
          right.priority -
          (left.age * 101 + left.priority) ||
        left.id.localeCompare(right.id)
    )
    .slice(0, limit);
  const ids = new Set(selected.map((gap) => gap.id));
  const next = buildAuthoringGapPlan(
    plan.gaps.map((gap) =>
      ids.has(gap.id)
        ? {
            ...gap,
            state: "asked" as const,
            ask_count: gap.ask_count + 1,
          }
        : gap
    )
  );
  return {
    plan: next,
    gaps: selected.map((gap) => ({
      ...gap,
      state: "asked",
      ask_count: gap.ask_count + 1,
    })),
    questions: selected.flatMap((gap) => (gap.question ? [gap.question] : [])),
  };
}

/** Aplica únicamente defaults pedidos explícitamente y declarados seguros. */
export function applyAuthoringGapDefaults(params: {
  plan: AuthoringGapPlan;
  gapIds: readonly string[];
}): {
  plan: AuthoringGapPlan;
  applied: AuthoringAppliedDefault[];
  rejected_gap_ids: string[];
} {
  const requested = new Set(params.gapIds);
  const applied: AuthoringAppliedDefault[] = [];
  const rejected = new Set(params.gapIds);
  const gaps = params.plan.gaps.map((gap) => {
    if (
      !requested.has(gap.id) ||
      isAuthoringGapResolved(gap) ||
      gap.state === "blocked_dependency" ||
      gap.severity !== "defaultable" ||
      !gap.safe_default
    ) {
      return gap;
    }
    applied.push({ gap_id: gap.id, value: gap.safe_default });
    rejected.delete(gap.id);
    return {
      ...gap,
      state: "defaulted" as const,
      resolution_status: "resolved" as const,
      resolution: gap.safe_default,
      evidence: [...gap.evidence, gap.safe_default],
      residual: undefined,
    };
  });
  return {
    plan: buildAuthoringGapPlan(gaps),
    applied,
    rejected_gap_ids: [...rejected],
  };
}

/** Flat compatibility view: only unresolved gaps remain visible. */
export function deriveFlatAuthoringGaps(plan: AuthoringGapPlan): string[] {
  return plan.gaps
    .filter((gap) => !isAuthoringGapResolved(gap))
    .map((gap) => gap.summary);
}
