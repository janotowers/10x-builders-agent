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
export const AUTHORING_GAP_PLAN_VERSION = 1 as const;
export const AUTHORING_GAP_DEFAULT_PRIORITY = 50;
export const AUTHORING_GAP_MAX_QUESTIONS = 4;

export const authoringGapCandidateSchema = z.object({
  id: z.string().trim().regex(/^gap_[a-z0-9]{8}$/).optional(),
  key: z.string().trim().min(1).max(160).optional(),
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

export const authoringGapSchema = authoringGapCandidateSchema
  .omit({ id: true, key: true, depends_on: true })
  .extend({
    id: z.string().trim().regex(/^gap_[a-z0-9]{8}$/),
    state: z.enum(AUTHORING_GAP_STATES).default("open"),
    depends_on: z
      .array(z.string().trim().regex(/^gap_[a-z0-9]{8}$/))
      .max(16)
      .default([]),
    priority: z.number().int().min(0).max(100).default(
      AUTHORING_GAP_DEFAULT_PRIORITY
    ),
    age: z.number().int().nonnegative().default(0),
    resolution: z.string().trim().min(1).max(2000).optional(),
  });

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

export const authoringGapPlanSchema = z.object({
  version: z.literal(AUTHORING_GAP_PLAN_VERSION).default(
    AUTHORING_GAP_PLAN_VERSION
  ),
  gaps: z.array(authoringGapSchema).max(128).default([]),
  counts: authoringGapPlanCountsSchema,
  can_proceed: z.boolean(),
});

export type AuthoringGapCandidate = z.input<typeof authoringGapCandidateSchema>;
export type AuthoringGap = z.infer<typeof authoringGapSchema>;
export type AuthoringGapPlan = z.infer<typeof authoringGapPlanSchema>;
export type AuthoringGapPlanCounts = z.infer<
  typeof authoringGapPlanCountsSchema
>;
export type AuthoringAppliedDefault = z.infer<
  typeof authoringAppliedDefaultSchema
>;

const TERMINAL_STATES = new Set<AuthoringGap["state"]>([
  "answered",
  "resolved_by_evidence",
  "defaulted",
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
    "id" | "key" | "summary" | "target_dimension"
  >
): string {
  if (candidate.id) return candidate.id;
  const identity =
    candidate.key?.trim() ||
    `${candidate.target_dimension}:${normalizedIdentity(candidate.summary)}`;
  return `gap_${fnv1a32(normalizedIdentity(identity))}`;
}

export function isAuthoringGapResolved(gap: AuthoringGap): boolean {
  return TERMINAL_STATES.has(gap.state);
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
      (gap) => gap.state === "open" && Boolean(gap.question)
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
  const unlocked = withDependencyState(gaps);
  return authoringGapPlanSchema.parse({
    version: AUTHORING_GAP_PLAN_VERSION,
    gaps: unlocked,
    counts: countAuthoringGapPlan(unlocked),
    can_proceed: canProceedWithAuthoringGapPlan(unlocked),
  });
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
    idsByKey.set(candidate.key ?? id, id);
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
        id,
        state: "open",
        depends_on: candidate.depends_on
          .map(
            (dependency) =>
              idsByKey.get(dependency) ??
              (/^gap_[a-z0-9]{8}$/.test(dependency)
                ? dependency
                : `gap_${fnv1a32(normalizedIdentity(dependency))}`)
          ),
        age: 0,
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

/**
 * Reconciliación append-preserving: actualiza candidatos conocidos, agrega
 * nuevos y conserva todo gap anterior no resuelto, incluso si aún no se pidió.
 */
export function reconcileAuthoringGapPlan(params: {
  previous?: AuthoringGapPlan;
  candidates?: readonly AuthoringGapCandidate[];
  answeredGapIds?: readonly string[];
  evidenceResolvedGapIds?: readonly string[];
}): AuthoringGapPlan {
  const incoming = planAuthoringGaps(params.candidates ?? []).gaps;
  const previous = params.previous?.gaps ?? [];
  const incomingById = new Map(incoming.map((gap) => [gap.id, gap]));
  const answered = new Set(params.answeredGapIds ?? []);
  const evidenced = new Set(params.evidenceResolvedGapIds ?? []);
  const merged: AuthoringGap[] = previous.map((oldGap) => {
    const next = incomingById.get(oldGap.id);
    incomingById.delete(oldGap.id);
    const state = answered.has(oldGap.id)
      ? "answered"
      : evidenced.has(oldGap.id)
        ? "resolved_by_evidence"
        : oldGap.state === "asked"
          ? "open"
          : oldGap.state;
    return authoringGapSchema.parse({
      ...(next ?? oldGap),
      id: oldGap.id,
      state,
      age: isAuthoringGapResolved({ ...oldGap, state } as AuthoringGap)
        ? oldGap.age
        : oldGap.age + 1,
      resolution:
        state === "answered"
          ? "answered"
          : state === "resolved_by_evidence"
            ? "resolved_by_evidence"
            : oldGap.resolution,
    });
  });
  for (const gap of incomingById.values()) {
    merged.push({
      ...gap,
      state: answered.has(gap.id)
        ? "answered"
        : evidenced.has(gap.id)
          ? "resolved_by_evidence"
          : gap.state,
    });
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
    .filter((gap) => gap.state === "open" && Boolean(gap.question))
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
      ids.has(gap.id) ? { ...gap, state: "asked" as const } : gap
    )
  );
  return {
    plan: next,
    gaps: selected.map((gap) => ({ ...gap, state: "asked" })),
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
      resolution: gap.safe_default,
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
