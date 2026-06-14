import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { loadPendingInboxSnapshot } from "@/lib/notifications/load-pending-inbox";
import { PendingInboxClient } from "./pending-inbox-client";

export const dynamic = "force-dynamic";

export default async function ChatPendingPage({
  searchParams,
}: {
  searchParams: Promise<{
    case?: string;
    focus?: string;
  }>;
}) {
  const sp = await searchParams;
  const initialCaseFilter = sp.case?.trim() || null;
  const initialFocusId = sp.focus?.trim() || null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("onboarding_completed")
    .eq("id", user.id)
    .single();

  if (!profile?.onboarding_completed) redirect("/onboarding");

  const pendingInbox = await loadPendingInboxSnapshot(user.id, initialCaseFilter);

  return (
    <AppShell
      title="Pendientes"
      description="Decisiones de negocio, avisos del agente y aprobaciones humanas (HITL) antes de ejecutar acciones sensibles."
    >
      <PendingInboxClient
        initialNotifications={pendingInbox.notifications}
        initialPendingToolConfirmations={pendingInbox.pendingToolConfirmations}
        initialCounts={pendingInbox.counts}
        initialCaseFilter={initialCaseFilter}
        initialFocusId={initialFocusId}
      />
    </AppShell>
  );
}
