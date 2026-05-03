import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  BUSINESS_BRAIN_SLOT_DESCRIPTIONS,
  reviewBusinessBrainFields,
  reviewBusinessBrainSlot,
  type BusinessBrainReviewSlot,
} from "@agents/agent";

const VALID_SLOTS = new Set(Object.keys(BUSINESS_BRAIN_SLOT_DESCRIPTIONS));

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as Record<string, unknown>;
    const fields = body.fields;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      const safeFields: Partial<Record<BusinessBrainReviewSlot, string>> = {};
      for (const [slot, value] of Object.entries(fields)) {
        if (VALID_SLOTS.has(slot) && typeof value === "string") {
          safeFields[slot as BusinessBrainReviewSlot] = value;
        }
      }

      const result = await reviewBusinessBrainFields({ fields: safeFields });
      return NextResponse.json({ ok: true, result });
    }

    const slot = typeof body.slot === "string" ? body.slot : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!VALID_SLOTS.has(slot)) {
      return NextResponse.json({ error: "Invalid slot" }, { status: 400 });
    }

    const result = await reviewBusinessBrainSlot({
      slot: slot as BusinessBrainReviewSlot,
      text,
    });

    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("[POST /api/business-brain/review] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
