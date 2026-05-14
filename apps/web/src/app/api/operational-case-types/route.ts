import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  listOperationalCaseTypesForUser,
  upsertOperationalCaseTypeForUser,
} from "@agents/db";
import type {
  OperationalCaseIntakeField,
  OperationalCaseIntakeFieldType,
  OperationalCaseTypeStatus,
  OperationalCaseTypeVisibility,
} from "@agents/types";

const STATUS_VALUES: OperationalCaseTypeStatus[] = [
  "draft",
  "active",
  "archived",
];
const FIELD_TYPES: OperationalCaseIntakeFieldType[] = [
  "text",
  "textarea",
  "number",
  "select",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanSlug(value: unknown): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isFieldType(value: string): value is OperationalCaseIntakeFieldType {
  return FIELD_TYPES.includes(value as OperationalCaseIntakeFieldType);
}

function normalizeCaseType(value: unknown): string {
  return cleanSlug(value).replace(/-/g, "_");
}

function normalizeIntakeSchema(value: unknown): OperationalCaseIntakeField[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((field) => {
      const name = cleanSlug(field.name).replace(/-/g, "_");
      const label = cleanText(field.label);
      const type = cleanText(field.type);
      const options = Array.isArray(field.options)
        ? field.options.map(cleanText).filter(Boolean)
        : [];
      return {
        name,
        label,
        type: isFieldType(type) ? type : "text",
        required: field.required === true,
        placeholder: cleanText(field.placeholder) || undefined,
        help_text: cleanText(field.help_text) || undefined,
        options,
      } satisfies OperationalCaseIntakeField;
    })
    .filter((field) => field.name && field.label);
}

export async function GET() {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = createServerClient();
    const caseTypes = await listOperationalCaseTypesForUser(db, user.id, {
      includeArchived: true,
    });
    return NextResponse.json({ ok: true, caseTypes });
  } catch (err) {
    console.error("[GET /api/operational-case-types] failed:", err);
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

    const caseType = normalizeCaseType(body.case_type);
    const displayName = cleanText(body.display_name);
    const defaultSkillSlug = cleanSlug(body.default_skill_slug);
    const statusRaw = cleanText(body.status);
    const visibilityRaw = cleanText(body.visibility);
    const status = STATUS_VALUES.includes(statusRaw as OperationalCaseTypeStatus)
      ? (statusRaw as OperationalCaseTypeStatus)
      : "draft";
    const visibility: Exclude<OperationalCaseTypeVisibility, "global"> =
      "private";
    const intakeSchema = normalizeIntakeSchema(body.intake_schema_jsonb);

    if (!caseType || !/^[a-z0-9][a-z0-9_]*$/.test(caseType)) {
      return NextResponse.json(
        { error: "case_type must use lowercase letters, numbers or _" },
        { status: 400 }
      );
    }
    if (!displayName) {
      return NextResponse.json(
        { error: "display_name required" },
        { status: 400 }
      );
    }
    if (!defaultSkillSlug) {
      return NextResponse.json(
        { error: "default_skill_slug required" },
        { status: 400 }
      );
    }
    if (visibilityRaw && visibilityRaw !== "private") {
      return NextResponse.json(
        { error: "sharing/publishing is not enabled from this UI yet" },
        { status: 403 }
      );
    }

    const db = createServerClient();
    const caseTypeRow = await upsertOperationalCaseTypeForUser(db, {
      userId: user.id,
      caseType,
      displayName,
      defaultSkillSlug,
      description: cleanText(body.description) || null,
      status,
      visibility,
      intakeSchema,
    });

    return NextResponse.json({ ok: true, caseType: caseTypeRow });
  } catch (err) {
    console.error("[POST /api/operational-case-types] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
