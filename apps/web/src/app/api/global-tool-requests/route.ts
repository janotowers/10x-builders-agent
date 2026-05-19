/**
 * GET    /api/global-tool-requests
 *   Lista las solicitudes del usuario autenticado.
 *   Soporta query params opcionales: case_type_id, tool_id, status (csv).
 *
 * POST   /api/global-tool-requests
 *   Crea una solicitud de incorporación/configuración global para una tool.
 *   body: {
 *     tool_id: string;
 *     request_kind: "incorporate_to_catalog" | "enable_account_config" | "provide_tenant_asset";
 *     case_type_id?: string;
 *     business_context?: string;
 *   }
 *   Si el usuario ya tiene una solicitud abierta para la misma tool y
 *   case_type, devuelve la existente (no crea duplicado).
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createGlobalToolRequest,
  createServerClient,
  findExistingOpenToolRequest,
  listGlobalToolRequests,
  updateGlobalToolRequestStatus,
} from "@agents/db";
import type {
  GlobalToolRequestKind,
  GlobalToolRequestStatus,
} from "@agents/types";

const REQUEST_KINDS: GlobalToolRequestKind[] = [
  "incorporate_to_catalog",
  "enable_account_config",
  "provide_tenant_asset",
];

const STATUS_VALUES: GlobalToolRequestStatus[] = [
  "requested",
  "in_review",
  "in_progress",
  "shipped",
  "rejected",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { searchParams } = new URL(request.url);
    const caseTypeId = searchParams.get("case_type_id")?.trim();
    const toolId = searchParams.get("tool_id")?.trim();
    const statusParam = searchParams.get("status")?.trim();
    const statuses = statusParam
      ? statusParam
          .split(",")
          .map((value) => value.trim())
          .filter((value): value is GlobalToolRequestStatus =>
            STATUS_VALUES.includes(value as GlobalToolRequestStatus)
          )
      : undefined;

    const db = createServerClient();
    const requests = await listGlobalToolRequests(db, {
      userId: user.id,
      caseTypeId: caseTypeId || undefined,
      toolId: toolId || undefined,
      status:
        statuses && statuses.length > 0
          ? statuses.length === 1
            ? statuses[0]
            : statuses
          : undefined,
    });
    return NextResponse.json({ ok: true, requests });
  } catch (err) {
    console.error("[GET /api/global-tool-requests] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as unknown;
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const toolId = cleanText(body.tool_id);
    if (!toolId) {
      return NextResponse.json({ error: "tool_id required" }, { status: 400 });
    }

    const requestKindRaw = cleanText(body.request_kind);
    if (!REQUEST_KINDS.includes(requestKindRaw as GlobalToolRequestKind)) {
      return NextResponse.json(
        {
          error:
            "request_kind must be incorporate_to_catalog | enable_account_config | provide_tenant_asset",
        },
        { status: 400 }
      );
    }
    const requestKind = requestKindRaw as GlobalToolRequestKind;

    const caseTypeId = cleanText(body.case_type_id) || null;
    const businessContext = cleanText(body.business_context) || null;

    const db = createServerClient();
    const existing = await findExistingOpenToolRequest(db, {
      userId: user.id,
      toolId,
      caseTypeId,
    });
    if (existing) {
      return NextResponse.json({ ok: true, request: existing, duplicate: true });
    }

    const created = await createGlobalToolRequest(db, {
      userId: user.id,
      caseTypeId,
      toolId,
      requestKind,
      businessContext,
    });
    return NextResponse.json({ ok: true, request: created, duplicate: false });
  } catch (err) {
    console.error("[POST /api/global-tool-requests] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as unknown;
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const id = cleanText(body.id);
    const statusRaw = cleanText(body.status);
    if (!id) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }
    if (!STATUS_VALUES.includes(statusRaw as GlobalToolRequestStatus)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }

    const db = createServerClient();
    const requestRow = await updateGlobalToolRequestStatus(db, {
      id,
      userId: user.id,
      status: statusRaw as GlobalToolRequestStatus,
      adminNotes: cleanText(body.admin_notes) || null,
    });
    if (!requestRow) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, request: requestRow });
  } catch (err) {
    console.error("[PATCH /api/global-tool-requests] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
