import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  listOperationalCaseTypesForUser,
  upsertOperationalCaseTypeForUser,
} from "@agents/db";
import type {
  OperationalCaseActivationPolicy,
  OperationalCaseFlowSkill,
  OperationalCaseFlowStep,
  OperationalCaseFlowTool,
  OperationalCaseIntakeField,
  OperationalCaseIntakeFieldType,
  OperationalCaseReminderPolicy,
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

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
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

function normalizeReminderPolicy(value: unknown): OperationalCaseReminderPolicy {
  if (!isRecord(value)) return {};
  const remindAfter = Array.isArray(value.remind_after_h)
    ? value.remind_after_h
        .map((item) => (typeof item === "number" ? item : Number(item)))
        .filter((item) => Number.isFinite(item) && item > 0)
    : undefined;
  const escalateAfter =
    typeof value.escalate_after_h === "number"
      ? value.escalate_after_h
      : Number(value.escalate_after_h);

  return {
    ...(remindAfter && remindAfter.length > 0
      ? { remind_after_h: remindAfter }
      : {}),
    ...(Number.isFinite(escalateAfter) && escalateAfter > 0
      ? { escalate_after_h: escalateAfter }
      : {}),
  };
}

function normalizeFlowTool(value: unknown): OperationalCaseFlowTool | null {
  if (!isRecord(value)) return null;
  const toolId = cleanText(value.tool_id);
  if (!toolId) return null;
  return {
    tool_id: toolId,
    tool_label: cleanText(value.tool_label) || undefined,
    tool_description: cleanText(value.tool_description) || undefined,
  };
}

function normalizeFlowSkill(value: unknown): OperationalCaseFlowSkill | null {
  if (!isRecord(value)) return null;
  const skillSlug = cleanSlug(value.skill_slug);
  if (!skillSlug) return null;
  const skillTools = Array.isArray(value.skill_tools)
    ? value.skill_tools.map(normalizeFlowTool).filter(isPresent)
    : [];
  return {
    skill_slug: skillSlug,
    skill_label: cleanText(value.skill_label) || undefined,
    skill_description: cleanText(value.skill_description) || undefined,
    skill_tools: skillTools,
  };
}

function normalizeOperationalFlow(value: unknown): OperationalCaseFlowStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((step, index) => {
      const stepKey =
        cleanSlug(step.step_key).replace(/-/g, "_") || `step_${index + 1}`;
      const stepLabel = cleanText(step.step_label);
      const stepSkills = Array.isArray(step.step_skills)
        ? step.step_skills.map(normalizeFlowSkill).filter(isPresent)
        : [];
      const stepTools = Array.isArray(step.step_tools)
        ? step.step_tools.map(normalizeFlowTool).filter(isPresent)
        : [];
      return {
        step_key: stepKey,
        step_label: stepLabel,
        step_description: cleanText(step.step_description) || undefined,
        step_skills: stepSkills,
        step_tools: stepTools,
      } satisfies OperationalCaseFlowStep;
    })
    .filter((step) => step.step_key && step.step_label);
}

function normalizeActivationPolicy(value: unknown): OperationalCaseActivationPolicy {
  if (!isRecord(value)) return {};
  const safeTest = isRecord(value.safe_test) ? value.safe_test : {};
  const activationChecks = isRecord(value.activation_checks)
    ? value.activation_checks
    : {};
  return {
    safe_test: {
      description: cleanText(safeTest.description) || undefined,
      run_button_label: cleanText(safeTest.run_button_label) || undefined,
      synthetic_data_copy: cleanText(safeTest.synthetic_data_copy) || undefined,
      success_copy: cleanText(safeTest.success_copy) || undefined,
      timeline_note: cleanText(safeTest.timeline_note) || undefined,
      next_action: cleanText(safeTest.next_action) || undefined,
      start_step: cleanSlug(safeTest.start_step).replace(/-/g, "_") || undefined,
      success_step:
        cleanSlug(safeTest.success_step).replace(/-/g, "_") || undefined,
    },
    activation_checks: {
      skill_valid_copy: cleanText(activationChecks.skill_valid_copy) || undefined,
      readiness_ready_copy:
        cleanText(activationChecks.readiness_ready_copy) || undefined,
      readiness_blocked_copy:
        cleanText(activationChecks.readiness_blocked_copy) || undefined,
      safe_test_success_copy:
        cleanText(activationChecks.safe_test_success_copy) || undefined,
      conversational_safe_copy:
        cleanText(activationChecks.conversational_safe_copy) || undefined,
      real_operation_complete_copy:
        cleanText(activationChecks.real_operation_complete_copy) || undefined,
      real_operation_pending_copy:
        cleanText(activationChecks.real_operation_pending_copy) || undefined,
      real_operation_requires_no_stubs:
        activationChecks.real_operation_requires_no_stubs === false ? false : true,
    },
  };
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
    const operationalFlow = normalizeOperationalFlow(body.operational_flow_jsonb);
    const activationPolicy = normalizeActivationPolicy(body.activation_policy_jsonb);
    const reminderPolicy = normalizeReminderPolicy(
      body.default_reminder_policy_jsonb
    );

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
      operationalFlow,
      activationPolicy,
      reminderPolicy,
    });

    return NextResponse.json({ ok: true, caseType: caseTypeRow });
  } catch (err) {
    console.error("[POST /api/operational-case-types] failed:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
