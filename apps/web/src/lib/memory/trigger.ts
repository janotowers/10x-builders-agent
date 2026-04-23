import {
  getFlushState,
  findStaleSiblingSession,
  type DbClient,
} from "@agents/db";
import {
  flushSessionMemory,
  logMemoryTrigger,
  type FlushReason,
} from "@agents/agent";

/**
 * Helpers compartidos entre `apps/web/src/app/api/chat/route.ts` y
 * `apps/web/src/app/api/telegram/webhook/route.ts` para disparar el flush de
 * memoria larga. Ver `docs/memory/long_term_memory_plan.md` (sección
 * "Triggers de extracción (flushSessionMemory)").
 *
 * Dos funciones:
 *   - `maybeCatchUpFlush(...)`: PRE-await, síncrono. Corre ANTES de
 *     `runAgent` si detecta sesión fría (idle ≥ CATCHUP_IDLE_MIN) o cambio
 *     de canal con otra sesión del mismo usuario con mensajes sin flushear.
 *     Se paga la latencia solo UNA vez (primer turno tras el hueco).
 *   - `fireAndForgetFlush(...)`: POST, no bloquea la respuesta. Se llama
 *     tras `runAgent` si el turno cerró limpio (sin pendingConfirmation) y
 *     alguna señal (shift / count / idle) se cumple.
 *
 * El gate final `FLUSH_MIN_NEW_MESSAGES` lo aplica `flushSessionMemory`
 * internamente; aquí solo evaluamos triggers.
 */

const CATCHUP_IDLE_MIN_DEFAULT = 20;
const BACKSTOP_IDLE_MIN_DEFAULT = 30;
const BACKSTOP_MAX_UNFLUSHED_DEFAULT = 15;

function resolveMinutes(env: string | undefined, fallback: number): number {
  if (!env) return fallback;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveCatchupIdleMin(): number {
  return resolveMinutes(
    process.env.MEMORY_CATCHUP_IDLE_MIN,
    CATCHUP_IDLE_MIN_DEFAULT
  );
}
function resolveBackstopIdleMin(): number {
  return resolveMinutes(
    process.env.MEMORY_BACKSTOP_IDLE_MIN,
    BACKSTOP_IDLE_MIN_DEFAULT
  );
}
function resolveBackstopMaxUnflushed(): number {
  const raw = process.env.MEMORY_BACKSTOP_MAX_UNFLUSHED;
  if (!raw) return BACKSTOP_MAX_UNFLUSHED_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : BACKSTOP_MAX_UNFLUSHED_DEFAULT;
}

function minutesBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 60000;
}

export interface CatchUpDeps {
  db: DbClient;
  userId: string;
  sessionId: string;
  /** Canal del turno entrante. Usado para detectar cross-channel. */
  channel: "web" | "telegram";
}

/**
 * Catch-up PRE-await. Decide si **antes** de ejecutar `runAgent` hay que
 * awaitear un flush para que la inyección del turno vea memoria fresca.
 *
 * Dos casos:
 *   1. Sesión fría: `last_message_at - last_flushed_at ≥ CATCHUP_IDLE_MIN`.
 *      El usuario volvió tras un hueco largo; queremos consolidar lo que
 *      quedó sin flushear antes de inyectar.
 *   2. Cambio de canal: existe otra sesión (Web/Telegram) del mismo user
 *      con `last_message_at > last_flushed_at`. El usuario se movió y la
 *      otra sesión tenía watermark atrasado.
 *
 * Errores NO se propagan — si el catch-up falla, el turno sigue sin memoria
 * fresca (degradación aceptable). El log sale por `console.error`.
 */
export async function maybeCatchUpFlush(deps: CatchUpDeps): Promise<void> {
  const { db, userId, sessionId, channel } = deps;
  const catchupIdleMin = resolveCatchupIdleMin();
  try {
    const state = await getFlushState(db, sessionId);
    // Caso 1: sesión actual está "fría".
    let firedSelf = false;
    if (state?.lastMessageAt) {
      const since = state.lastFlushedAt
        ? minutesBetween(state.lastMessageAt, state.lastFlushedAt)
        : Infinity;
      if (since >= catchupIdleMin) {
        void logMemoryTrigger({
          sessionId,
          phase: "PRE",
          decision: "fire",
          reason: "cold_session",
          signals: { sinceLastFlushMin: since },
          thresholds: { catchupIdleMin },
        }).catch(() => {});
        firedSelf = true;
        await flushSessionMemory({
          db,
          userId,
          sessionId,
          reason: "catchup",
        });
      } else {
        void logMemoryTrigger({
          sessionId,
          phase: "PRE",
          decision: "skip",
          reason: "below_catchup_idle",
          signals: { sinceLastFlushMin: since },
          thresholds: { catchupIdleMin },
        }).catch(() => {});
      }
    } else if (!state) {
      void logMemoryTrigger({
        sessionId,
        phase: "PRE",
        decision: "skip",
        reason: "session_not_found",
      }).catch(() => {});
    }
    // Caso 2: hay una sesión hermana (otro canal) con watermark atrasado.
    const sibling = await findStaleSiblingSession(db, userId, sessionId);
    if (sibling && sibling.channel !== channel) {
      void logMemoryTrigger({
        sessionId,
        phase: "PRE",
        decision: "sibling_flush",
        reason: "cross_channel_stale",
        sibling: {
          found: true,
          siblingSessionId: sibling.id,
          siblingChannel: sibling.channel,
        },
      }).catch(() => {});
      await flushSessionMemory({
        db,
        userId,
        sessionId: sibling.id,
        reason: "catchup",
      });
    } else if (!firedSelf) {
      void logMemoryTrigger({
        sessionId,
        phase: "PRE",
        decision: "skip",
        reason: "no_sibling_action",
        sibling: { found: !!sibling },
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[memory:trigger] maybeCatchUpFlush failed:", err);
  }
}

export interface FireAndForgetDeps {
  db: DbClient;
  userId: string;
  sessionId: string;
  /** `true` si `memory_injection_node` detectó topic-shift en este turno. */
  memoryFlushPending: boolean;
}

/**
 * Evalúa las señales POST-turno y dispara `flushSessionMemory` en background
 * si corresponde. Señales (cualquiera basta):
 *   - shift: `memoryFlushPending === true` (viene de AgentOutput).
 *   - count: `agent_messages` sin flushear ≥ BACKSTOP_MAX_UNFLUSHED.
 *   - idle : `now() - lastFlushedAt ≥ BACKSTOP_IDLE_MIN`.
 *
 * La función NO es async: intencional. El caller la invoca sin `await`; la
 * promesa interna se maneja con `.catch()` para no dejar "zombie promises"
 * no manejadas. En entornos serverless ideales se debería envolver con
 * `waitUntil(...)` (ver nota de despliegue en el plan).
 */
export function fireAndForgetFlush(deps: FireAndForgetDeps): void {
  const { db, userId, sessionId, memoryFlushPending } = deps;
  const backstopIdleMin = resolveBackstopIdleMin();
  const backstopMaxUnflushed = resolveBackstopMaxUnflushed();
  void (async () => {
    try {
      const state = await getFlushState(db, sessionId);
      if (!state) {
        void logMemoryTrigger({
          sessionId,
          phase: "POST",
          decision: "skip",
          reason: "session_not_found",
          signals: { memoryFlushPending },
        }).catch(() => {});
        return;
      }

      // Contar mensajes sin flushear (solo para señales count/idle; el gate
      // "≥ FLUSH_MIN_NEW_MESSAGES" vuelve a aplicarse DENTRO de flush).
      let unflushedCount = 0;
      {
        let q = db
          .from("agent_messages")
          .select("id", { count: "exact", head: true })
          .eq("session_id", sessionId);
        if (state.lastFlushedAt) q = q.gt("created_at", state.lastFlushedAt);
        const { count, error } = await q;
        if (error) {
          console.error("[memory:trigger] count failed:", error);
          return;
        }
        unflushedCount = count ?? 0;
      }

      const idleMin =
        state.lastFlushedAt && state.lastMessageAt
          ? minutesBetween(state.lastMessageAt, state.lastFlushedAt)
          : state.lastMessageAt
            ? Infinity
            : 0;

      let reason: FlushReason | null = null;
      if (memoryFlushPending) reason = "shift";
      else if (unflushedCount >= backstopMaxUnflushed) reason = "count";
      else if (idleMin >= backstopIdleMin) reason = "idle";

      if (!reason) {
        void logMemoryTrigger({
          sessionId,
          phase: "POST",
          decision: "skip",
          reason: "no_signal_met",
          signals: {
            memoryFlushPending,
            unflushedCount,
            idleMin: Number.isFinite(idleMin) ? idleMin : null,
          },
          thresholds: { backstopIdleMin, backstopMaxUnflushed },
        }).catch(() => {});
        return;
      }

      void logMemoryTrigger({
        sessionId,
        phase: "POST",
        decision: "fire",
        reason,
        signals: {
          memoryFlushPending,
          unflushedCount,
          idleMin: Number.isFinite(idleMin) ? idleMin : null,
        },
        thresholds: { backstopIdleMin, backstopMaxUnflushed },
      }).catch(() => {});
      await flushSessionMemory({ db, userId, sessionId, reason });
    } catch (err) {
      console.error("[memory:trigger] fireAndForgetFlush failed:", err);
    }
  })();
}
