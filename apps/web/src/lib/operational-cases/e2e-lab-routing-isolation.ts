import { getOperationalCase } from "@agents/db";
import {
  isControlledE2EOperationalCase,
  type OperationalCase,
  type OperationalCaseConversationBinding,
} from "@agents/types";

type DbClient = Parameters<typeof getOperationalCase>[0];

/**
 * While the E2E lab session is active, property-optioning routing must not
 * adopt or clarify against Real (`e2e_controlled=false`) conversational cases.
 */
export function filterBindingsForActiveE2ELabSync(
  bindings: OperationalCaseConversationBinding[],
  caseById: Map<string, OperationalCase>
): OperationalCaseConversationBinding[] {
  return bindings.filter((binding) => {
    const opCase = caseById.get(binding.case_id);
    return Boolean(opCase && isControlledE2EOperationalCase(opCase));
  });
}

export async function filterBindingsForActiveE2ELab(
  db: DbClient,
  bindings: OperationalCaseConversationBinding[]
): Promise<OperationalCaseConversationBinding[]> {
  if (bindings.length === 0) return bindings;
  const caseById = new Map<string, OperationalCase>();
  for (const binding of bindings) {
    if (caseById.has(binding.case_id)) continue;
    const opCase = await getOperationalCase(db, binding.case_id);
    if (opCase) caseById.set(binding.case_id, opCase);
  }
  return filterBindingsForActiveE2ELabSync(bindings, caseById);
}

export async function resolvePropertyOptioningRoutingBindings(params: {
  db: DbClient;
  pendingBindings: OperationalCaseConversationBinding[];
  e2eLabSessionActive: boolean;
}): Promise<OperationalCaseConversationBinding[]> {
  if (!params.e2eLabSessionActive) return params.pendingBindings;
  return filterBindingsForActiveE2ELab(params.db, params.pendingBindings);
}

/**
 * When creating/adopting under an active E2E lab, never reuse a Real draft.
 */
export function isAdoptableConversationalCaseForE2ELab(
  opCase: OperationalCase,
  e2eControlled: boolean
): boolean {
  if (!e2eControlled) return true;
  return isControlledE2EOperationalCase(opCase);
}

/**
 * The E2E lab session may reference an older case id. Treat it as usable only
 * when it belongs to the same user/case type and is itself E2E-controlled.
 */
export function isUsableE2ELabSessionCase(params: {
  opCase: OperationalCase | null | undefined;
  userId: string;
  caseType: string;
}): boolean {
  const { opCase, userId, caseType } = params;
  return Boolean(
    opCase &&
      opCase.user_id === userId &&
      opCase.case_type === caseType &&
      opCase.context_jsonb?.created_from === "agent_conversation" &&
      opCase.status !== "completed" &&
      opCase.status !== "failed" &&
      isControlledE2EOperationalCase(opCase)
  );
}
