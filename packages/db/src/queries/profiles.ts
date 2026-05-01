import type { DbClient } from "../client";
import type { BusinessBrain, Profile } from "@agents/types";

export async function getProfile(db: DbClient, userId: string) {
  const { data, error } = await db
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data as Profile;
}

export async function upsertProfile(
  db: DbClient,
  userId: string,
  fields: Partial<Omit<Profile, "id" | "created_at" | "updated_at">>
) {
  const { data, error } = await db
    .from("profiles")
    .upsert({ id: userId, ...fields, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data as Profile;
}

// ─────────────────────────────────────────────────────────────────────
// Business Brain (V1-C-α)
//
// El Business Brain vive como columna JSONB en `profiles.business_brain`.
// Estos helpers normalizan la lectura (siempre devuelven un objeto, nunca
// `null`) y la escritura (deep-merge para que `updateBusinessBrain` con
// solo `{ identity: { org_name: "X" } }` no borre `bigquery`).
//
// Mantenemos los helpers en este archivo (no en uno nuevo) porque la
// columna pertenece a `profiles` y casi siempre se cargan juntas.
// ─────────────────────────────────────────────────────────────────────

/**
 * Lee el Business Brain del perfil. Siempre devuelve un objeto válido:
 * si la fila no existe (no debería: el perfil ya estaría creado por el
 * trigger de signup) o si el JSONB es NULL/inválido, devuelve `{}`.
 */
export async function getBusinessBrain(
  db: DbClient,
  userId: string
): Promise<BusinessBrain> {
  const { data, error } = await db
    .from("profiles")
    .select("business_brain")
    .eq("id", userId)
    .single();
  if (error) {
    // No queremos romper el turno por un perfil sin la columna creada
    // (p.ej. si el usuario no aplicó la migración todavía). Devolvemos
    // un BB vacío y dejamos que el caller decida.
    return {};
  }
  const raw = (data as { business_brain?: unknown } | null)?.business_brain;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as BusinessBrain;
}

/**
 * Aplica un parche al Business Brain con deep-merge. Solo merge nivel-1
 * (cada slot top-level) + nivel-2 (claves dentro del slot). No tocamos
 * arrays — si el caller pasa `dataset_allowlist`, **reemplaza** el array
 * existente (semántica esperada por la UI: el usuario marca las cajas
 * y eso ES la lista nueva).
 */
export async function updateBusinessBrain(
  db: DbClient,
  userId: string,
  patch: Partial<BusinessBrain>
): Promise<BusinessBrain> {
  const current = await getBusinessBrain(db, userId);
  const next: BusinessBrain = { ...current };

  for (const [slotKey, slotValue] of Object.entries(patch)) {
    if (slotValue === undefined) continue;
    const currentSlot = (current as Record<string, unknown>)[slotKey];
    if (
      slotValue === null ||
      Array.isArray(slotValue) ||
      typeof slotValue !== "object" ||
      currentSlot === undefined ||
      currentSlot === null ||
      Array.isArray(currentSlot) ||
      typeof currentSlot !== "object"
    ) {
      // Reemplazo directo: primitivo, array, o slot que no existía aún.
      (next as Record<string, unknown>)[slotKey] = slotValue;
      continue;
    }
    // Deep-merge nivel-2.
    (next as Record<string, unknown>)[slotKey] = {
      ...(currentSlot as Record<string, unknown>),
      ...(slotValue as Record<string, unknown>),
    };
  }

  const { data, error } = await db
    .from("profiles")
    .update({
      business_brain: next,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId)
    .select("business_brain")
    .single();
  if (error) throw error;

  const saved = (data as { business_brain?: unknown } | null)?.business_brain;
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return next;
  return saved as BusinessBrain;
}
