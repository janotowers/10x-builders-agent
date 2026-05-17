/**
 * Queries para global_tool_requests.
 * Ver migración 00023_global_tool_requests.sql.
 *
 * Las solicitudes documentan el backlog de tools que deben incorporarse al
 * catálogo global o habilitar configuración por cuenta. No reemplazan a una
 * integración real.
 */
import type { DbClient } from "../client";
import type {
  GlobalToolRequest,
  GlobalToolRequestKind,
  GlobalToolRequestStatus,
} from "@agents/types";

export interface CreateGlobalToolRequestInput {
  userId: string;
  caseTypeId?: string | null;
  toolId: string;
  requestKind: GlobalToolRequestKind;
  businessContext?: string | null;
}

export async function createGlobalToolRequest(
  db: DbClient,
  input: CreateGlobalToolRequestInput
): Promise<GlobalToolRequest> {
  const row = {
    user_id: input.userId,
    case_type_id: input.caseTypeId ?? null,
    tool_id: input.toolId,
    request_kind: input.requestKind,
    business_context: input.businessContext ?? null,
  };
  const { data, error } = await db
    .from("global_tool_requests")
    .insert(row)
    .select("*")
    .single();
  if (error) throw error;
  return data as GlobalToolRequest;
}

export interface ListGlobalToolRequestsFilter {
  userId?: string;
  toolId?: string;
  caseTypeId?: string;
  status?: GlobalToolRequestStatus | GlobalToolRequestStatus[];
}

export async function listGlobalToolRequests(
  db: DbClient,
  filter: ListGlobalToolRequestsFilter = {}
): Promise<GlobalToolRequest[]> {
  let query = db
    .from("global_tool_requests")
    .select("*")
    .order("created_at", { ascending: false });
  if (filter.userId) query = query.eq("user_id", filter.userId);
  if (filter.toolId) query = query.eq("tool_id", filter.toolId);
  if (filter.caseTypeId) query = query.eq("case_type_id", filter.caseTypeId);
  if (filter.status) {
    if (Array.isArray(filter.status)) {
      query = query.in("status", filter.status);
    } else {
      query = query.eq("status", filter.status);
    }
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as GlobalToolRequest[];
}

/**
 * Marca como `shipped` cualquier solicitud abierta del user para las tools
 * indicadas. Útil cuando el user conecta exitosamente un provider y eso
 * resuelve automáticamente sus tickets pendientes (ej. conectar EasyBroker
 * cierra los pendings de las 4 tools de EasyBroker).
 *
 * Devuelve cuántas solicitudes actualizó.
 */
export async function shipGlobalToolRequestsForTools(
  db: DbClient,
  params: {
    userId: string;
    toolIds: string[];
    adminNote?: string;
  }
): Promise<number> {
  if (!params.toolIds.length) return 0;
  const { data, error } = await db
    .from("global_tool_requests")
    .update({
      status: "shipped",
      admin_notes: params.adminNote ?? "Resuelto automáticamente al conectar el provider en la cuenta del usuario.",
    })
    .eq("user_id", params.userId)
    .in("tool_id", params.toolIds)
    .in("status", ["requested", "in_review", "in_progress"])
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

export async function findExistingOpenToolRequest(
  db: DbClient,
  params: {
    userId: string;
    toolId: string;
    caseTypeId?: string | null;
  }
): Promise<GlobalToolRequest | null> {
  let query = db
    .from("global_tool_requests")
    .select("*")
    .eq("user_id", params.userId)
    .eq("tool_id", params.toolId)
    .in("status", ["requested", "in_review", "in_progress"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (params.caseTypeId === null || params.caseTypeId === undefined) {
    query = query.is("case_type_id", null);
  } else {
    query = query.eq("case_type_id", params.caseTypeId);
  }
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return (data as GlobalToolRequest | null) ?? null;
}
