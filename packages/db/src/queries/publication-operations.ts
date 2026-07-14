import type { DbClient } from "../client";

export type PublicationOperationStatus =
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown_outcome";

export type PublicationOperationRow = {
  id: string;
  case_id: string;
  destination: string;
  operation_key: string;
  operation_type: string;
  status: PublicationOperationStatus;
  request_jsonb: Record<string, unknown>;
  result_jsonb: Record<string, unknown>;
  error_text: string | null;
  claimed_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ClaimPublicationOperationInput = {
  caseId: string;
  destination: "easybroker" | "ungga" | "manual";
  operationKey: string;
  operationType: string;
  request?: Record<string, unknown>;
};

/**
 * Reclama una operación idempotente. Si ya existe:
 * - succeeded → reutiliza
 * - failed/unknown_outcome → permite reclaim solo si forceRetry (revisión humana)
 * - claimed/running/unknown_outcome → no re-ejecutar
 */
export async function claimPublicationOperation(
  db: DbClient,
  input: ClaimPublicationOperationInput,
  options?: { forceRetry?: boolean }
): Promise<
  | { status: "claimed"; operation: PublicationOperationRow }
  | { status: "reuse"; operation: PublicationOperationRow }
  | { status: "in_flight"; operation: PublicationOperationRow }
  | { status: "unknown_outcome"; operation: PublicationOperationRow }
  | { status: "failed_terminal"; operation: PublicationOperationRow }
> {
  const nowIso = new Date().toISOString();
  const insertPayload = {
    case_id: input.caseId,
    destination: input.destination,
    operation_key: input.operationKey,
    operation_type: input.operationType,
    status: "claimed" as const,
    request_jsonb: input.request ?? {},
    result_jsonb: {},
    claimed_at: nowIso,
    updated_at: nowIso,
  };

  const { data: inserted, error: insertError } = await db
    .from("publication_operations")
    .insert(insertPayload)
    .select("*")
    .maybeSingle();

  if (!insertError && inserted) {
    return {
      status: "claimed",
      operation: inserted as PublicationOperationRow,
    };
  }

  // Unique violation → fetch existing
  const { data: existing, error: selectError } = await db
    .from("publication_operations")
    .select("*")
    .eq("case_id", input.caseId)
    .eq("destination", input.destination)
    .eq("operation_key", input.operationKey)
    .maybeSingle();
  if (selectError) throw selectError;
  if (!existing) {
    if (insertError) throw insertError;
    throw new Error("claimPublicationOperation: insert failed without existing row");
  }

  const operation = existing as PublicationOperationRow;
  if (operation.status === "succeeded") {
    return { status: "reuse", operation };
  }
  if (operation.status === "unknown_outcome" && !options?.forceRetry) {
    return { status: "unknown_outcome", operation };
  }
  if (operation.status === "claimed" || operation.status === "running") {
    return { status: "in_flight", operation };
  }
  if (
    (operation.status === "failed" || operation.status === "unknown_outcome") &&
    options?.forceRetry
  ) {
    const { data: updated, error: updateError } = await db
      .from("publication_operations")
      .update({
        status: "claimed",
        request_jsonb: input.request ?? operation.request_jsonb,
        result_jsonb: {},
        error_text: null,
        claimed_at: nowIso,
        finished_at: null,
        updated_at: nowIso,
      })
      .eq("id", operation.id)
      .eq("status", operation.status)
      .select("*")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) {
      return {
        status:
          operation.status === "unknown_outcome"
            ? "unknown_outcome"
            : "failed_terminal",
        operation,
      };
    }
    return {
      status: "claimed",
      operation: updated as PublicationOperationRow,
    };
  }
  return { status: "failed_terminal", operation };
}

export async function markPublicationOperationRunning(
  db: DbClient,
  operationId: string
): Promise<PublicationOperationRow | null> {
  const { data, error } = await db
    .from("publication_operations")
    .update({
      status: "running",
      updated_at: new Date().toISOString(),
    })
    .eq("id", operationId)
    .in("status", ["claimed", "running"])
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as PublicationOperationRow | null) ?? null;
}

export async function finishPublicationOperation(
  db: DbClient,
  params: {
    operationId: string;
    status: "succeeded" | "failed" | "unknown_outcome";
    result?: Record<string, unknown>;
    errorText?: string | null;
  }
): Promise<PublicationOperationRow | null> {
  const { data, error } = await db
    .from("publication_operations")
    .update({
      status: params.status,
      result_jsonb: params.result ?? {},
      error_text: params.errorText ?? null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.operationId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return (data as PublicationOperationRow | null) ?? null;
}

export async function getPublicationOperation(
  db: DbClient,
  params: {
    caseId: string;
    destination: string;
    operationKey: string;
  }
): Promise<PublicationOperationRow | null> {
  const { data, error } = await db
    .from("publication_operations")
    .select("*")
    .eq("case_id", params.caseId)
    .eq("destination", params.destination)
    .eq("operation_key", params.operationKey)
    .maybeSingle();
  if (error) throw error;
  return (data as PublicationOperationRow | null) ?? null;
}

export async function listPublicationOperationsForCase(
  db: DbClient,
  caseId: string,
  limit = 50
): Promise<PublicationOperationRow[]> {
  const { data, error } = await db
    .from("publication_operations")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as PublicationOperationRow[];
}
