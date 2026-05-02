import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SettingsForm } from "./settings-form";
import { getGlobalSkillRegistry } from "@agents/agent";

type Search = { google_calendar?: string; reason?: string };

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

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <h1 className="text-lg font-semibold">Ajustes</h1>
          <a
            href="/chat"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Volver al chat
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-8">
        <SettingsForm
          userId={user.id}
          profile={profile}
          toolSettings={toolSettings ?? []}
          skillSettings={skillSettings ?? []}
          skillCatalog={skillCatalog}
          telegramLinked={!!telegramAccount}
          githubConnected={!!githubIntegration}
          googleCalendarConnected={!!googleCalendarIntegration}
          googleOAuthStatus={sp.google_calendar}
          googleOAuthReason={sp.reason}
        />
      </main>
    </div>
  );
}
