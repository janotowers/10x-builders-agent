/**
 * Helpers puros para el hilo conversacional de Studio authoring.
 */
import {
  answerBodyFromClarification,
  authoringCapabilityNeedSchema,
  authoringClarifyingQuestionSchema,
  authoringGapPlanSchema,
  authoringInvocationChannelSchema,
  inputRequirementSchema,
  type AuthoringCapabilityNeed,
  type AuthoringClarifyingQuestion,
  type AuthoringInvocationChannel,
  type AuthoringGap,
  type InputRequirement,
} from "@agents/workflows";

export type AuthoringUnderstanding = {
  objective: string;
  sources: string[];
  actors: string[];
  decisions: string[];
  effects: string[];
  capabilities: string[];
  acceptance_criteria: string[];
  assumptions: string[];
  gaps: string[];
};

export type AuthoringThreadMessage =
  | {
      id: string;
      role: "user";
      kind: "description" | "answer" | "correction";
      text: string;
    }
  | {
      id: string;
      role: "gu";
      kind: "questions" | "checkpoint" | "proposal" | "blocked" | "status";
      text: string;
      questions?: string[];
      questionDetails?: AuthoringClarifyingQuestion[];
      understanding?: AuthoringUnderstanding;
      capabilityNeeds?: AuthoringCapabilityNeed[];
      inputRequirements?: InputRequirement[];
      invocationChannels?: AuthoringInvocationChannel[];
      pendingBlockers?: AuthoringGap[];
      safeDefaults?: Array<{
        gap_id: string;
        summary: string;
        value: string;
      }>;
    };

function asUnderstanding(value: unknown): AuthoringUnderstanding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.objective !== "string") return undefined;
  const list = (key: string): string[] =>
    Array.isArray(record[key])
      ? record[key].filter(
          (item): item is string => typeof item === "string" && item.trim().length > 0
        )
      : [];
  return {
    objective: record.objective,
    sources: list("sources"),
    actors: list("actors"),
    decisions: list("decisions"),
    effects: list("effects"),
    capabilities: list("capabilities"),
    acceptance_criteria: list("acceptance_criteria"),
    assumptions: list("assumptions"),
    gaps: list("gaps"),
  };
}

function asCapabilityNeeds(value: unknown): AuthoringCapabilityNeed[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = authoringCapabilityNeedSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function asInputRequirements(value: unknown): InputRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = inputRequirementSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function asInvocationChannels(value: unknown): AuthoringInvocationChannel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = authoringInvocationChannelSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function asGapPresentation(message: Record<string, unknown>): {
  pendingBlockers: AuthoringGap[];
  safeDefaults: Array<{ gap_id: string; summary: string; value: string }>;
} {
  const plan = authoringGapPlanSchema.safeParse(message.gap_plan);
  const gaps = plan.success ? plan.data.gaps : [];
  const pendingBlockers = gaps.filter(
    (gap) =>
      gap.severity === "blocking" &&
      gap.state !== "answered" &&
      gap.state !== "resolved_by_evidence" &&
      gap.state !== "defaulted"
  );
  const safeDefaults = gaps.flatMap((gap) =>
    gap.severity === "defaultable" &&
    gap.safe_default &&
    gap.state !== "answered" &&
    gap.state !== "resolved_by_evidence" &&
    gap.state !== "defaulted" &&
    gap.state !== "blocked_dependency"
      ? [
          {
            gap_id: gap.id,
            summary: gap.summary,
            value: gap.safe_default,
          },
        ]
      : []
  );
  return { pendingBlockers, safeDefaults };
}

export function hydrateAuthoringThread(params: {
  description: string;
  messages: unknown[];
}): AuthoringThreadMessage[] {
  const thread: AuthoringThreadMessage[] = [];
  if (params.description.trim()) {
    thread.push({
      id: "description",
      role: "user",
      kind: "description",
      text: params.description.trim(),
    });
  }
  for (const [index, raw] of params.messages.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const message = raw as Record<string, unknown>;
    const role = message.role;
    if (
      (role === "discovery_question" || role === "compiler_clarify") &&
      Array.isArray(message.questions)
    ) {
      const questions = message.questions.filter(
        (item): item is string =>
          typeof item === "string" && item.trim().length > 0
      );
      if (questions.length === 0) continue;
      thread.push({
        id: `q-${index}`,
        role: "gu",
        kind: "questions",
        text: "Para preparar un borrador seguro, necesito aclarar:",
        questions,
        questionDetails: Array.isArray(message.question_details)
          ? message.question_details.flatMap((detail) => {
              const parsed = authoringClarifyingQuestionSchema.safeParse(detail);
              return parsed.success ? [parsed.data] : [];
            })
          : [],
      });
    } else if (role === "user_answer" && typeof message.content === "string") {
      thread.push({
        id: `a-${index}`,
        role: "user",
        kind: "answer",
        text: answerBodyFromClarification(message.content),
      });
    } else if (
      role === "proposal_correction" &&
      typeof message.content === "string"
    ) {
      thread.push({
        id: `r-${index}`,
        role: "user",
        kind: "correction",
        text: message.content.trim(),
      });
    } else if (role === "discovery_checkpoint") {
      const questions = Array.isArray(message.questions)
        ? message.questions.filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0
          )
        : undefined;
      const gapPresentation = asGapPresentation(message);
      thread.push({
        id: `c-${index}`,
        role: "gu",
        kind: "checkpoint",
        text:
          gapPresentation.pendingBlockers.length > 0
            ? `Queda ${gapPresentation.pendingBlockers.length} decisión${
                gapPresentation.pendingBlockers.length === 1 ? "" : "es"
              } necesaria${
                gapPresentation.pendingBlockers.length === 1 ? "" : "s"
              }.`
            : "Ya tengo bastante contexto. ¿Seguimos aclarando o preparo la propuesta?",
        questions,
        questionDetails: Array.isArray(message.question_details)
          ? message.question_details.flatMap((detail) => {
              const parsed = authoringClarifyingQuestionSchema.safeParse(detail);
              return parsed.success ? [parsed.data] : [];
            })
          : [],
        understanding: asUnderstanding(message.content),
        capabilityNeeds: asCapabilityNeeds(message.capability_needs),
        pendingBlockers: gapPresentation.pendingBlockers,
        safeDefaults: gapPresentation.safeDefaults,
      });
    } else if (role === "understanding_summary") {
      const understanding = asUnderstanding(message.content);
      if (!understanding) continue;
      thread.push({
        id: `p-${index}`,
        role: "gu",
        kind: "proposal",
        text: "Esto entendí. Confirma antes de crear el borrador.",
        understanding,
        capabilityNeeds: asCapabilityNeeds(message.capability_needs),
        inputRequirements: asInputRequirements(message.input_requirements),
        invocationChannels: asInvocationChannels(message.invocation_channels),
        ...asGapPresentation(message),
      });
    }
  }
  return thread;
}

export type AuthoringProgressLike = {
  stage: string;
  message: string;
};

export function formatAuthoringTechnicalProgress(
  event: AuthoringProgressLike
): string {
  return `${event.message} · ${event.stage}`;
}

export function authoringHumanStatus(params: {
  phase: string;
  pendingAction?: string | null;
  progress?: readonly AuthoringProgressLike[];
}): string {
  if (params.pendingAction === "confirm") {
    return "Gu está creando el borrador…";
  }
  if (params.pendingAction === "revise_proposal") {
    return "Gu está aplicando tu ajuste a la propuesta…";
  }
  if (params.pendingAction === "answer") {
    return "Gu está analizando tu respuesta…";
  }
  if (params.pendingAction) {
    return "Gu está analizando la solicitud…";
  }
  const latest = params.progress?.[params.progress.length - 1];
  if (latest?.message.trim()) return latest.message.trim();
  switch (params.phase) {
    case "discovering":
      return "Gu espera tu respuesta para continuar.";
    case "checkpoint":
      return "Elige si seguimos aclarando o preparamos la propuesta.";
    case "proposal":
      return "La propuesta está lista para revisar, ajustar o confirmar.";
    case "blocked":
      return "La sesión conserva lo aclarado, pero necesita una reformulación.";
    case "redirect":
      return "Esta solicitud continuará en el chat.";
    default:
      return "";
  }
}

/** Separación UI: forma de trabajo ≠ estado conversacional. */
export function workFormLabelFromKind(
  kind: string | null | undefined
): string | null {
  switch (kind) {
    case "case_workflow":
      return "Flujo de caso";
    case "durable_task":
      return "Tarea durable";
    case "reusable_skill":
      return "Skill reusable";
    case "schedule":
      return "Programación";
    case "redirect_to_chat":
      return "Consulta en chat";
    default:
      return null;
  }
}
