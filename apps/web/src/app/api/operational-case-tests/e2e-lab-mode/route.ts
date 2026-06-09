import { NextResponse } from "next/server";
import {
  activateE2ELabSession,
  cancelE2ELabSession,
  createServerClient,
  getActiveE2ELabSession,
  getOperationalCaseTypeById,
} from "@agents/db";
import { createClient } from "@/lib/supabase/server";

const E2E_LAB_SESSION_HOURS = 2;

async function resolveCaseType(params: {
  db: ReturnType<typeof createServerClient>;
  userId: string;
  caseTypeId?: string | null;
}) {
  const caseTypeId = params.caseTypeId?.trim();
  if (!caseTypeId) return null;
  const caseType = await getOperationalCaseTypeById(params.db, caseTypeId);
  if (
    !caseType ||
    caseType.status !== "active" ||
    (caseType.user_id && caseType.user_id !== params.userId)
  ) {
    return null;
  }
  return caseType;
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
    const db = createServerClient();
    const caseType = await resolveCaseType({
      db,
      userId: user.id,
      caseTypeId: searchParams.get("case_type_id"),
    });
    if (!caseType) {
      return NextResponse.json({ error: "active_case_type_required" }, { status: 400 });
    }

    const session = await getActiveE2ELabSession(db, {
      userId: user.id,
      caseType: caseType.case_type,
    });
    return NextResponse.json({
      ok: true,
      active: Boolean(session),
      session,
      expires_in_hours: E2E_LAB_SESSION_HOURS,
    });
  } catch (err) {
    console.error("[GET /api/operational-case-tests/e2e-lab-mode] failed:", err);
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

    const body = (await request.json().catch(() => ({}))) as {
      case_type_id?: string;
    };
    const db = createServerClient();
    const caseType = await resolveCaseType({
      db,
      userId: user.id,
      caseTypeId: body.case_type_id,
    });
    if (!caseType) {
      return NextResponse.json({ error: "active_case_type_required" }, { status: 400 });
    }

    const session = await activateE2ELabSession(db, {
      userId: user.id,
      caseType: caseType.case_type,
      metadata: {
        source: "settings_operational_case_types",
        case_type_id: caseType.id,
        activated_at: new Date().toISOString(),
      },
    });
    return NextResponse.json({
      ok: true,
      active: true,
      session,
      expires_in_hours: E2E_LAB_SESSION_HOURS,
    });
  } catch (err) {
    console.error("[POST /api/operational-case-tests/e2e-lab-mode] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const db = createServerClient();
    const caseType = await resolveCaseType({
      db,
      userId: user.id,
      caseTypeId: searchParams.get("case_type_id"),
    });
    if (!caseType) {
      return NextResponse.json({ error: "active_case_type_required" }, { status: 400 });
    }

    const session = await cancelE2ELabSession(db, {
      userId: user.id,
      caseType: caseType.case_type,
    });
    return NextResponse.json({
      ok: true,
      active: false,
      session,
      expires_in_hours: E2E_LAB_SESSION_HOURS,
    });
  } catch (err) {
    console.error("[DELETE /api/operational-case-tests/e2e-lab-mode] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
