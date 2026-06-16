import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  getProfile,
  getUserNotificationPreferences,
  getRecentOperationalCaseEvents,
  listOperationalCasesForUser,
  listOperationalCaseTypesForUser,
} from "@agents/db";
import { getSkillRegistryForUser } from "@agents/agent";
import { OperationalCaseTypesClient } from "./operational-case-types-client";
import { BfcacheRecoveryBoundary } from "./bfcache-recovery-boundary";
import { AppShell } from "@/components/app-shell";
import { EngagementPolicySettingsCard } from "./engagement-policy-settings-card";

export const dynamic = "force-dynamic";

export default async function OperationalCaseTypesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const db = createServerClient();
  const [caseTypes, operationalCases, registry, profile, notificationPreferences] =
    await Promise.all([
    listOperationalCaseTypesForUser(db, user.id, {
      includeArchived: true,
    }),
    listOperationalCasesForUser(db, user.id, {
      statuses: [
        "active",
        "waiting_internal",
        "waiting_external",
        "paused",
        "completed",
        "failed",
      ],
      limit: 500,
    }),
    getSkillRegistryForUser(db, user.id).catch((err) => {
      console.warn(
        "[operational-case-types] failed to load skill registry:",
        err
      );
      return null;
    }),
    getProfile(db, user.id).catch((err) => {
      console.warn("[operational-case-types] failed to load profile:", err);
      return null;
    }),
    getUserNotificationPreferences(db, user.id).catch((err) => {
      console.warn(
        "[operational-case-types] failed to load notification prefs:",
        err
      );
      return null;
    }),
  ]);
  const skillSummaries =
    registry?.list().map((skill) => ({
      slug: skill.name,
      description: skill.description,
      scope: skill.scope,
      allowedTools: [...skill.allowedTools],
      includes: [...skill.includes],
      kind: skill.includes.length > 0 ? "composite" : "atomic",
    })) ?? [];
  const latestEventsByCaseId = Object.fromEntries(
    (
      await Promise.all(
        operationalCases.map((opCase) =>
          getRecentOperationalCaseEvents(db, opCase.id, 1)
        )
      )
    )
      .flat()
      .map((event) => [event.case_id, event] as const)
  );

  return (
    <AppShell
      title="Plantillas de flujos"
      description="Diseña, prueba y activa plantillas operativas que generan flujos en curso."
      actions={
        <a
          href="/operational-cases"
          title="Bandeja global con todas las instancias, sin filtrar por plantilla"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Ver flujos en curso
        </a>
      }
    >
      <div className="space-y-6">
        <EngagementPolicySettingsCard
          initialTimezone={profile?.timezone ?? "UTC"}
          initialOverrides={notificationPreferences?.engagement_policy_overrides_jsonb ?? {}}
        />
        <BfcacheRecoveryBoundary>
          <OperationalCaseTypesClient
            initialCaseTypes={caseTypes}
            initialOperationalCases={operationalCases}
            initialLatestEventsByCaseId={latestEventsByCaseId}
            initialSkillSummaries={skillSummaries}
          />
        </BfcacheRecoveryBoundary>
      </div>
    </AppShell>
  );
}
