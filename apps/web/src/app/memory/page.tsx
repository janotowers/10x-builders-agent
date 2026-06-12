import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, listMemories } from "@agents/db";
import { MemoryList } from "./memory-list";
import { AppShell } from "@/components/app-shell";

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
    <AppShell
      title="Memoria"
      description="Consulta, filtra y archiva recuerdos activos para controlar el contexto del agente."
    >
      <div className="mx-auto max-w-3xl">
        <MemoryList
          initialRows={initial.rows}
          initialTotal={initial.total}
        />
      </div>
    </AppShell>
  );
}
