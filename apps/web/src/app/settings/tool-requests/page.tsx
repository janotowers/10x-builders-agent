import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, listGlobalToolRequests } from "@agents/db";
import { ToolRequestsClient } from "./tool-requests-client";

export default async function ToolRequestsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const db = createServerClient();
  const requests = await listGlobalToolRequests(db, { userId: user.id });

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <h1 className="text-lg font-semibold">Solicitudes</h1>
          <div className="flex gap-2">
            <a
              href="/settings/operational-case-types"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Casos de uso
            </a>
            <a
              href="/settings"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Ajustes
            </a>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">
        <ToolRequestsClient initialRequests={requests} />
      </main>
    </div>
  );
}
