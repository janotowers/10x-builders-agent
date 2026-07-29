/**
 * Internal AI usage dashboard (flexible-workflows plan, Slice 0.4 / 0.4.1).
 *
 * Admin-only (`profiles.is_ungga_admin`): server loads the ledger window and
 * label maps; interactive exploration (filters, sorts, pagination, nested
 * account/execution views) lives in the client. Observability, not billing.
 *
 * Lives under /settings (not /operational-cases): metering covers all model
 * calls (chat, classifiers, cron, heartbeat…), not only operational cases.
 */
import { Suspense } from "react";
import { redirect } from "next/navigation";
import {
  createServerClient,
  listAiUsageEvents,
} from "@agents/db";
import { getDroppedAiUsageMeterCount } from "@agents/agent";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { AiUsageDashboardClient } from "./ai-usage-dashboard-client";

export const dynamic = "force-dynamic";

const EVENT_LIMIT = 10_000;
const DEFAULT_WINDOW_DAYS = 30;
const WINDOW_OPTIONS = new Set([7, 30, 90]);

type Search = { days?: string };

function shortId(id: string, head = 8): string {
  return id.length <= head ? id : `${id.slice(0, head)}…`;
}

function parseWindowDays(raw: string | undefined): number {
  const n = Number(raw);
  if (WINDOW_OPTIONS.has(n)) return n;
  return DEFAULT_WINDOW_DAYS;
}

function usageWindowSinceIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export default async function AiUsageAdminPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const windowDays = parseWindowDays(sp.days);

  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await auth
    .from("profiles")
    .select("is_ungga_admin, timezone")
    .eq("id", user.id)
    .single();
  if (profile?.is_ungga_admin !== true) {
    return (
      <AppShell
        title="Uso de IA (interno)"
        description="Observabilidad interna de llamadas a modelos."
      >
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <p className="font-semibold">Sin acceso de admin Ungga</p>
          <p className="mt-2">
            Esta página requiere <code>profiles.is_ungga_admin = true</code> en
            tu cuenta. Ahora mismo el flag está en{" "}
            <code>{String(profile?.is_ungga_admin ?? "null")}</code>.
          </p>
        </div>
      </AppShell>
    );
  }

  const adminTimeZone =
    typeof profile.timezone === "string" && profile.timezone.trim()
      ? profile.timezone.trim()
      : "UTC";

  const db = createServerClient();
  const sinceIso = usageWindowSinceIso(windowDays);
  const events = await listAiUsageEvents(db, {
    userId: user.id,
    adminWide: true,
    sinceIso,
    limit: EVENT_LIMIT,
  });

  const droppedThisProcess = getDroppedAiUsageMeterCount();
  const truncated = events.length >= EVENT_LIMIT;

  const tenantIds = [...new Set(events.map((event) => event.user_id))];
  const emailByUserId: Record<string, string> = {};
  if (tenantIds.length > 0) {
    const { data: profiles } = await db
      .from("profiles")
      .select("id, email")
      .in("id", tenantIds);
    for (const row of profiles ?? []) {
      if (typeof row.id === "string" && typeof row.email === "string") {
        emailByUserId[row.id] = row.email;
      }
    }
  }

  const caseIds = [
    ...new Set(
      events
        .map((event) => event.operational_case_id)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const caseLabelById: Record<string, string> = {};
  if (caseIds.length > 0) {
    const { data: cases } = await db
      .from("operational_cases")
      .select("id, case_type, current_step, status")
      .in("id", caseIds);
    for (const row of cases ?? []) {
      if (typeof row.id !== "string") continue;
      const caseType =
        typeof row.case_type === "string" ? row.case_type : "caso";
      const step =
        typeof row.current_step === "string" && row.current_step
          ? ` · ${row.current_step}`
          : "";
      const status =
        typeof row.status === "string" && row.status
          ? ` · ${row.status}`
          : "";
      caseLabelById[row.id] =
        `${caseType}${step}${status} · ${shortId(row.id)}`;
    }
  }

  return (
    <AppShell
      title="Uso de IA (interno)"
      description={`Ledger append-only de llamadas a modelos — últimos ${windowDays} días, todas las cuentas. Observabilidad interna, no facturación. Horas en ${adminTimeZone} (perfil del admin).`}
    >
      <Suspense
        fallback={
          <p className="text-xs text-neutral-500">Cargando exploración…</p>
        }
      >
        <AiUsageDashboardClient
          events={events}
          windowDays={windowDays}
          adminTimeZone={adminTimeZone}
          emailByUserId={emailByUserId}
          caseLabelById={caseLabelById}
          droppedThisProcess={droppedThisProcess}
          truncated={truncated}
          eventLimit={EVENT_LIMIT}
        />
      </Suspense>
    </AppShell>
  );
}
