import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  updateBusinessBrain,
} from "@agents/db";
import {
  buildWarehouseCompatibilityPatch,
} from "@agents/agent";
import type {
  BusinessBrain,
  BusinessBrainWarehouseSource,
} from "@agents/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getWarehouseFromPatch(
  patch: Partial<BusinessBrain>
): BusinessBrainWarehouseSource | undefined {
  const dataSources = isRecord(patch.data_sources) ? patch.data_sources : undefined;
  const warehouse = isRecord(dataSources?.warehouse)
    ? dataSources.warehouse
    : undefined;
  return warehouse as BusinessBrainWarehouseSource | undefined;
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

    const body = (await request.json()) as Record<string, unknown>;
    const patch = isRecord(body.patch)
      ? (body.patch as Partial<BusinessBrain>)
      : undefined;
    if (!patch) {
      return NextResponse.json({ error: "patch required" }, { status: 400 });
    }

    const warehouse = getWarehouseFromPatch(patch);
    const normalizedPatch: Partial<BusinessBrain> = warehouse
      ? { ...patch, ...buildWarehouseCompatibilityPatch(warehouse) }
      : patch;

    const db = createServerClient();
    const businessBrain = await updateBusinessBrain(db, user.id, normalizedPatch);
    return NextResponse.json({ ok: true, business_brain: businessBrain });
  } catch (err) {
    console.error("[PATCH /api/business-brain] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
