import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./settings-form";
import { getGlobalSkillRegistry } from "@agents/agent";
import { createServerClient, listGlobalToolRequests, listHeartbeatChecklistTemplates, getUserNotificationPreferences } from "@agents/db";
import { AppShell } from "@/components/app-shell";
import { getSettingsPageMeta } from "./settings-page-meta";

type Search = {
  view?: string;
  section?: string;
  google_calendar?: string;
  gmail?: string;
  reason?: string;
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  const { data: toolSettings } = await supabase
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", user.id);

  const { data: skillSettings } = await supabase
    .from("user_skill_settings")
    .select("*")
    .eq("user_id", user.id);

  let skillCatalog: Array<{
    name: string;
    description: string;
    scope: "business" | "personal" | "shared";
    allowedTools: string[];
    requiresTenantContext: boolean;
  }> = [];
  try {
    const registry = await getGlobalSkillRegistry();
    skillCatalog = registry.list().map((s) => ({
      name: s.name,
      description: s.description,
      scope: s.scope,
      allowedTools: [...s.allowedTools],
      requiresTenantContext: s.requiresTenantContext,
    }));
  } catch (err) {
    console.warn("[settings] failed to load skill registry:", err);
  }

  const { data: telegramAccount } = await supabase
    .from("telegram_accounts")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: githubIntegration } = await supabase
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("provider", "github")
    .eq("status", "active")
    .maybeSingle();

  const { data: googleCalendarIntegration } = await supabase
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("provider", "google_calendar")
    .eq("status", "active")
    .maybeSingle();

  const { data: gmailIntegration } = await supabase
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("provider", "gmail")
    .eq("status", "active")
    .maybeSingle();

  const { data: heartbeatRuns } = await supabase
    .from("heartbeat_runs")
    .select("*")
    .eq("user_id", user.id)
    .order("started_at", { ascending: false })
    .limit(5);

  const { data: scheduledTasks } = await supabase
    .from("scheduled_tasks")
    .select("*")
    .eq("user_id", user.id)
    .in("status", ["active", "paused"])
    .order("next_run_at", { ascending: true, nullsFirst: false });

  const heartbeatChecklistTemplates = await listHeartbeatChecklistTemplates(
    supabase,
    user.id
  ).catch((err) => {
    console.warn("[settings] failed to load heartbeat checklist templates:", err);
    return [];
  });

  const db = createServerClient();
  const [toolRequests, notificationPreferences] = await Promise.all([
    listGlobalToolRequests(db, { userId: user.id }),
    getUserNotificationPreferences(db, user.id).catch((err) => {
      console.warn("[settings] failed to load notification prefs:", err);
      return null;
    }),
  ]);

  const { title, description } = getSettingsPageMeta(sp.view, sp.section);
  const contentMaxWidth =
    sp.view === "capabilities" && sp.section === "requests"
      ? "max-w-4xl"
      : "max-w-2xl";

  return (
    <AppShell title={title} description={description}>
      <div className={`mx-auto ${contentMaxWidth}`}>
        <SettingsForm
          userId={user.id}
          authEmail={user.email ?? ""}
          profile={profile}
          toolSettings={toolSettings ?? []}
          skillSettings={skillSettings ?? []}
          skillCatalog={skillCatalog}
          toolRequests={toolRequests}
          telegramLinked={!!telegramAccount}
          githubConnected={!!githubIntegration}
          googleCalendarConnected={!!googleCalendarIntegration}
          gmailConnected={!!gmailIntegration}
          heartbeatRuns={heartbeatRuns ?? []}
          scheduledTasks={scheduledTasks ?? []}
          heartbeatChecklistTemplates={heartbeatChecklistTemplates}
          googleOAuthStatus={sp.google_calendar}
          gmailOAuthStatus={sp.gmail}
          googleOAuthReason={sp.reason}
          engagementPolicyTimezone={
            typeof profile?.timezone === "string" && profile.timezone.trim()
              ? profile.timezone.trim()
              : "UTC"
          }
          engagementPolicyOverrides={
            notificationPreferences?.engagement_policy_overrides_jsonb ?? {}
          }
        />
      </div>
    </AppShell>
  );
}
