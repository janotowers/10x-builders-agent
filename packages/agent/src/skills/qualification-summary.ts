export interface SkillQualificationOutputLike {
  readonly response?: string | null;
  readonly toolCalls?: readonly string[] | null;
  readonly appliedSkills?:
    | readonly {
        readonly id: string;
        readonly role?: string;
      }[]
    | null;
  readonly pendingConfirmation?: unknown;
}

export interface SkillQualificationSummary {
  readonly toolCalls: {
    readonly total: number;
    readonly sequence: readonly string[];
    readonly unique: readonly string[];
    readonly counts: Readonly<Record<string, number>>;
  };
  readonly agentOutput: {
    readonly text: string;
    readonly nonEmpty: boolean;
    readonly characterCount: number;
  };
  readonly appliedSkillIds: readonly string[];
  readonly pendingConfirmation: boolean;
}

/**
 * Produce deterministic, contract-agnostic evidence from a production agent
 * run. Callers can compare this summary with any skill-specific qualification
 * contract without coupling the agent package to Studio persistence or UI.
 */
export function summarizeSkillQualificationEvidence(
  output: SkillQualificationOutputLike
): SkillQualificationSummary {
  const sequence = Object.freeze(
    (output.toolCalls ?? [])
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.trim())
      .filter(Boolean)
  );
  const counts: Record<string, number> = {};
  const unique: string[] = [];
  for (const name of sequence) {
    if (counts[name] === undefined) {
      counts[name] = 1;
      unique.push(name);
    } else {
      counts[name] += 1;
    }
  }

  const text = typeof output.response === "string" ? output.response : "";
  const appliedSkillIds = Object.freeze(
    (output.appliedSkills ?? [])
      .map((skill) => skill.id.trim())
      .filter(Boolean)
  );

  return Object.freeze({
    toolCalls: Object.freeze({
      total: sequence.length,
      sequence,
      unique: Object.freeze(unique),
      counts: Object.freeze(counts),
    }),
    agentOutput: Object.freeze({
      text,
      nonEmpty: text.trim().length > 0,
      characterCount: text.length,
    }),
    appliedSkillIds,
    pendingConfirmation:
      output.pendingConfirmation !== null &&
      output.pendingConfirmation !== undefined,
  });
}
