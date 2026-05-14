import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, listMemories } from "@agents/db";
import { MemoryList } from "./memory-list";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const db = createServerClient();
  const initial = await listMemories(db, {
    userId: user.id,
    status: "active",
    limit: 50,
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between">
          <h1 className="text-lg font-semibold">Mis recuerdos</h1>
          <div className="flex gap-2">
            <a
              href="/operational-cases"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Casos
            </a>
            <a
              href="/settings"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Ajustes
            </a>
            <a
              href="/chat"
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Volver al chat
            </a>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <MemoryList
          initialRows={initial.rows}
          initialTotal={initial.total}
        />
      </main>
    </div>
  );
}
