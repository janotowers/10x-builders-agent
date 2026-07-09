/**
 * Lookup compartido del caso de laboratorio (settings test).
 * Acepta match por case_type_id o por slug (global vs fork privado).
 */

import type { DbClient } from "@agents/db";
import type { OperationalCase } from "@agents/types";
import { isSettingsOperationalTestCase } from "./settings-test-telegram-lab";

export type LabCaseTypeRef = {
  id: string;
  case_type: string;
};

export function isLabSettingsTestCaseForTemplate(
  opCase: OperationalCase,
  userId: string,
  caseType: LabCaseTypeRef
): boolean {
  if (opCase.user_id !== userId) return false;
  if (!isSettingsOperationalTestCase(opCase.context_jsonb)) return false;
  return (
    opCase.case_type_id === caseType.id ||
    opCase.case_type === caseType.case_type
  );
}

/**
 * Último caso de settings test para la plantilla.
 * 1) match exacto por case_type_id
 * 2) fallback por slug case_type (misma plantilla, otro UUID global/privado)
 */
export async function findLatestSettingsTestCase(
  db: DbClient,
  userId: string,
  caseTypeId: string,
  caseTypeSlug?: string
): Promise<OperationalCase | null> {
  const { data, error } = await db
    .from("operational_cases")
    .select("*")
    .eq("user_id", userId)
    .eq("case_type_id", caseTypeId)
    .eq("context_jsonb->>created_from", "case_type_settings_test")
    .eq("context_jsonb->>test_mode", "true")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const exact = (data as OperationalCase | null) ?? null;
  if (exact || !caseTypeSlug) return exact;

  const fallback = await db
    .from("operational_cases")
    .select("*")
    .eq("user_id", userId)
    .eq("case_type", caseTypeSlug)
    .eq("context_jsonb->>created_from", "case_type_settings_test")
    .eq("context_jsonb->>test_mode", "true")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (fallback.error) throw fallback.error;
  return (fallback.data as OperationalCase | null) ?? null;
}

export async function findLatestSettingsTestCaseId(
  db: DbClient,
  userId: string,
  caseTypeId: string,
  caseTypeSlug?: string
): Promise<string | null> {
  const opCase = await findLatestSettingsTestCase(
    db,
    userId,
    caseTypeId,
    caseTypeSlug
  );
  return opCase?.id ?? null;
}
