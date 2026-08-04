/**
 * Queries de worker profiles (Slice 3.4-1; Technical Plan §9).
 *
 * Regla 3 del plan: TODA query exige `userId`. Los perfiles globales
 * (user_id null) son catálogo compartido, pero la resolución siempre ocurre
 * en nombre de un tenant: una fila propia del tenant sombrea el slug global.
 * Los perfiles jamás contienen credenciales (§21) — aquí no hay campos de
 * secretos que leer ni escribir.
 */
import type { DbClient } from "../client";
import type { WorkerProfile } from "@agents/types";

/**
 * Perfiles visibles para el tenant: globales + propios. Si un slug existe en
 * ambos, gana la fila del tenant (sombreado).
 */
export async function listWorkerProfilesForUser(
  db: DbClient,
  userId: string
): Promise<WorkerProfile[]> {
  const { data, error } = await db
    .from("worker_profiles")
    .select("*")
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .order("slug", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as WorkerProfile[];
  const bySlug = new Map<string, WorkerProfile>();
  for (const row of rows) {
    const existing = bySlug.get(row.slug);
    // Tenant-scoped shadows global for the same slug.
    if (!existing || (existing.user_id === null && row.user_id !== null)) {
      bySlug.set(row.slug, row);
    }
  }
  return [...bySlug.values()];
}

export async function getWorkerProfileBySlug(
  db: DbClient,
  userId: string,
  slug: string
): Promise<WorkerProfile | null> {
  const { data, error } = await db
    .from("worker_profiles")
    .select("*")
    .eq("slug", slug)
    .or(`user_id.is.null,user_id.eq.${userId}`);
  if (error) throw error;
  const rows = (data ?? []) as WorkerProfile[];
  return (
    rows.find((row) => row.user_id === userId) ??
    rows.find((row) => row.user_id === null) ??
    null
  );
}

/**
 * Resuelve una `required_capability` de work item al perfil que la declara.
 * Preferencia: perfil del tenant > perfil global. Null ⇒ el dispatcher
 * bloquea el item explícitamente (nunca se adivina un ejecutor).
 */
export async function resolveWorkerProfileForCapability(
  db: DbClient,
  userId: string,
  capability: string
): Promise<WorkerProfile | null> {
  const profiles = await listWorkerProfilesForUser(db, userId);
  const matches = profiles.filter((profile) =>
    profile.capabilities.includes(capability)
  );
  if (matches.length === 0) return null;
  return matches.find((profile) => profile.user_id === userId) ?? matches[0];
}
