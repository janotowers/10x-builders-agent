import type { createServerClient } from "@agents/db";

/** Tools con al menos una ejecución exitosa en sesiones recientes del usuario (readiness N1). */
export async function testedToolsForUser(
  db: ReturnType<typeof createServerClient>,
  userId: string,
  toolIds: string[]
): Promise<Set<string>> {
  const tested = new Set<string>();
  if (toolIds.length === 0) return tested;
  const { data: sessions } = await db
    .from("agent_sessions")
    .select("id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  const sessionIds = (sessions ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
  if (sessionIds.length === 0) return tested;
  const { data: calls } = await db
    .from("tool_calls")
    .select("tool_name")
    .in("session_id", sessionIds)
    .in("tool_name", toolIds)
    .eq("status", "executed")
    .order("created_at", { ascending: false })
    .limit(200);
  for (const call of calls ?? []) {
    const toolName = (call as { tool_name?: unknown }).tool_name;
    if (typeof toolName === "string") tested.add(toolName);
  }
  return tested;
}

export function missingTestedTools(
  toolIds: string[],
  tested: Set<string>
): string[] {
  return toolIds.filter((toolId) => !tested.has(toolId));
}
