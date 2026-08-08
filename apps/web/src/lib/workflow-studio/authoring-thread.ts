/**
 * Helpers puros para el hilo conversacional de Studio authoring.
 */
import {
  answerBodyFromClarification,
  authoringCapabilityNeedSchema,
  authoringClarifyingQuestionSchema,
  type AuthoringCapabilityNeed,
  type AuthoringClarifyingQuestion,
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
      kind: "description" | "answer";
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
    if (role === "discovery_question" && Array.isArray(message.questions)) {
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
    } else if (role === "discovery_checkpoint") {
      const questions = Array.isArray(message.questions)
        ? message.questions.filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0
          )
        : undefined;
      thread.push({
        id: `c-${index}`,
        role: "gu",
        kind: "checkpoint",
        text: "Ya tengo bastante contexto. ¿Seguimos aclarando o preparo la propuesta?",
        questions,
        questionDetails: Array.isArray(message.question_details)
          ? message.question_details.flatMap((detail) => {
              const parsed = authoringClarifyingQuestionSchema.safeParse(detail);
              return parsed.success ? [parsed.data] : [];
            })
          : [],
        understanding: asUnderstanding(message.content),
        capabilityNeeds: asCapabilityNeeds(message.capability_needs),
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
      });
    }
  }
  return thread;
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
