import type {
  AuthoringDiscoveryCompactState,
  AuthoringDiscoveryOutput,
} from "@agents/workflows";

type UnderstandingListField =
  | "sources"
  | "actors"
  | "decisions"
  | "effects"
  | "capabilities"
  | "acceptance_criteria"
  | "assumptions";

const DIMENSION_FIELD: Partial<
  Record<
    AuthoringDiscoveryOutput["covered_dimensions"][number]["key"],
    UnderstandingListField | "objective"
  >
> = {
  objective: "objective",
  data_sources: "sources",
  actors: "actors",
  human_decisions: "decisions",
  side_effects: "effects",
  capabilities: "capabilities",
  acceptance_criteria: "acceptance_criteria",
};

const STOP_WORDS = new Set([
  "para",
  "como",
  "cada",
  "esta",
  "este",
  "esto",
  "desde",
  "debe",
  "deben",
  "usuario",
  "capacidad",
  "the",
  "with",
  "from",
  "that",
]);

function normalizedText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function significantTokens(value: string): Set<string> {
  return new Set(
    normalizedText(value)
      .split(" ")
      .filter((token) => token.length >= 5 && !STOP_WORDS.has(token))
  );
}

function isDescriptionEcho(item: string, description: string): boolean {
  const normalizedItem = normalizedText(item);
  const normalizedDescription = normalizedText(description);
  if (!normalizedItem || !normalizedDescription) return false;
  if (normalizedItem === normalizedDescription) return true;
  if (normalizedItem.length < 80) return false;
  return (
    normalizedDescription.includes(normalizedItem) ||
    normalizedItem.includes(normalizedDescription)
  );
}

function correctionContradictsItem(item: string, correction: string): boolean {
  if (
    !/\b(?:no|nunca|ya no|en lugar de|sino|instead of|not)\b/i.test(correction)
  ) {
    return false;
  }
  const itemTokens = significantTokens(item);
  if (itemTokens.size === 0) return false;
  const correctionTokens = significantTokens(correction);
  const overlap = [...itemTokens].filter((token) =>
    correctionTokens.has(token)
  ).length;
  return overlap >= Math.max(1, Math.ceil(itemTokens.size * 0.6));
}

function uniqueItems(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const identity = normalizedText(value);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    output.push(value);
  }
  return output;
}

function touchedUnderstandingFields(params: {
  discovery: AuthoringDiscoveryOutput;
  latestAnswerIndex: number;
}): Set<UnderstandingListField | "objective"> {
  const touched = new Set<UnderstandingListField | "objective">();
  for (const dimension of params.discovery.covered_dimensions) {
    const field = DIMENSION_FIELD[dimension.key];
    if (
      field &&
      dimension.evidence.some(
        (evidence) =>
          evidence.source === "answer" &&
          evidence.answer_index === params.latestAnswerIndex
      )
    ) {
      touched.add(field);
    }
  }
  return touched;
}

/**
 * Proposal corrections are patches, not fresh summaries. Preserve canonical
 * facts unless the latest correction touches and explicitly contradicts them.
 */
export function mergeConservativeProposalRevision(params: {
  discovery: AuthoringDiscoveryOutput;
  priorCompactState: AuthoringDiscoveryCompactState | null | undefined;
  description: string;
  latestCorrection: string;
  latestAnswerIndex: number;
}): AuthoringDiscoveryOutput {
  const prior = params.priorCompactState?.understanding;
  if (!prior) return params.discovery;

  const current = params.discovery.understanding;
  const touched = touchedUnderstandingFields({
    discovery: params.discovery,
    latestAnswerIndex: params.latestAnswerIndex,
  });
  const listFields: UnderstandingListField[] = [
    "sources",
    "actors",
    "decisions",
    "effects",
    "capabilities",
    "acceptance_criteria",
    "assumptions",
  ];
  const merged = { ...current };

  for (const field of listFields) {
    const priorItems = prior[field];
    if (!touched.has(field) && field !== "assumptions") {
      merged[field] = [...priorItems];
      continue;
    }
    merged[field] = uniqueItems([
      ...priorItems.filter(
        (item) =>
          !correctionContradictsItem(item, params.latestCorrection)
      ),
      ...current[field],
    ]);
  }

  if (!touched.has("objective")) {
    merged.objective = prior.objective;
  }

  merged.sources = uniqueItems(
    merged.sources.filter(
      (item) => !isDescriptionEcho(item, params.description)
    )
  );

  // Open gaps belong to the current deterministic plan, never to stale copy.
  merged.gaps = [...current.gaps];
  return { ...params.discovery, understanding: merged };
}
