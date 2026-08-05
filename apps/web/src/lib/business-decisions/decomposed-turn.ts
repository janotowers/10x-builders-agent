/**
 * Multiplexer de turno (Slice 4.1-2; Technical Plan §12): corre el
 * decomposer conservador ANTES de la cadena de gates, enruta cada intent por
 * la cadena existente de forma independiente y compone los resultados en UNA
 * respuesta. Envuelve — no reemplaza — el router determinístico (§12.1).
 *
 * Reglas de composición (escenarios B1/B2/D):
 *   - Ningún intent manejado ⇒ `{ handled: false }`: el turno COMPLETO cae
 *     al agente conversacional, como hoy (nada se pierde).
 *   - ≥1 manejado ⇒ una respuesta compuesta; los intents NO manejados van al
 *     residual con reason "unmatched_intent". Los adaptadores (Slice 4.1-5)
 *     re-despachan ese texto al agente tras el ack; "No actué sobre: …"
 *     queda para unparsed_remainder / fallback — nunca descarte silencioso
 *     (Escenario D / B1).
 *   - `ok` compuesto = todos los manejados ok (un mismatch de monto B2 deja
 *     ok=false y NO aprueba; los demás efectos sí persisten).
 *
 * Instrumentación (4.1-4): logs estructurados `[intent-decomposer]` con
 * conteos de intents/manejados/residuales para medir tasas de residual y
 * mis-split como criterio de upgrade de modelo.
 */

import type { DbClient } from "@agents/db";
import {
  resolvePendingDecisionTurn,
  type PendingDecisionTurn,
  type PendingDecisionTurnParams,
} from "./pending-decision-router";
import {
  decomposeTurnIntents,
  looksLikeMultiIntentTurn,
  shouldApplyDecomposition,
  type DecomposedIntent,
  type IntentDecomposerInput,
  type IntentDecomposition,
} from "./intent-decomposer";
import type { ResidualIntent } from "./residual-intent";

export interface DecomposedTurnDeps {
  /** Inyectable en selftests; default: decomposer OpenRouter fail-open. */
  decompose?: (
    input: IntentDecomposerInput
  ) => Promise<IntentDecomposition | null>;
  /** Inyectable en selftests; default: router compartido real. */
  routeTurn?: (
    db: DbClient,
    params: PendingDecisionTurnParams
  ) => Promise<PendingDecisionTurn>;
  /** Hook de instrumentación; default: console.info estructurado. */
  log?: (entry: Record<string, unknown>) => void;
}

export interface IntentOutcome {
  intent: DecomposedIntent;
  turn: PendingDecisionTurn;
}

function defaultLog(entry: Record<string, unknown>) {
  console.info("[intent-decomposer]", entry);
}

/**
 * Composición pura de resultados por intent en un `PendingDecisionTurn`
 * (testeable sin DB). Ver reglas en el header del módulo.
 */
export function composePendingDecisionTurns(
  outcomes: IntentOutcome[]
): PendingDecisionTurn {
  const handled = outcomes.filter(
    (
      outcome
    ): outcome is IntentOutcome & {
      turn: Extract<PendingDecisionTurn, { handled: true }>;
    } => outcome.turn.handled
  );
  if (handled.length === 0) return { handled: false };

  const unhandled = outcomes.filter((outcome) => !outcome.turn.handled);

  // Residual compuesto: residuales propios de los gates que manejaron + los
  // intents que ningún gate reclamó (deferral explícito, Escenario D).
  const residualParts: string[] = [];
  for (const outcome of handled) {
    const residual = outcome.turn.residual;
    if (residual?.text.trim()) residualParts.push(residual.text.trim());
  }
  for (const outcome of unhandled) {
    const text = outcome.intent.text.trim();
    if (text) residualParts.push(text);
  }
  const residual: ResidualIntent | null =
    residualParts.length > 0
      ? {
          text: residualParts.join(" · "),
          reason:
            unhandled.length > 0 ? "unmatched_intent" : "unparsed_remainder",
        }
      : null;

  const first = handled[0].turn;
  const afterReplyFns = handled
    .map((outcome) => outcome.turn.runAfterReply)
    .filter((fn): fn is () => Promise<void> => typeof fn === "function");

  if (handled.length === 1) {
    // Un solo gate manejó: conserva su forma (status/decision intactos) y
    // solo enriquece el residual con los intents no manejados.
    return { ...first, residual };
  }

  return {
    handled: true,
    routed: handled.map((outcome) => outcome.turn.routed).join("+"),
    ok: handled.every((outcome) => outcome.turn.ok),
    status: "composed",
    caseId: first.caseId ?? null,
    notificationId: first.notificationId ?? null,
    message: handled
      .map((outcome) => outcome.turn.message)
      .filter((message) => message.trim().length > 0)
      .join("\n\n"),
    artifact:
      handled.find((outcome) => outcome.turn.artifact)?.turn.artifact ?? null,
    residual,
    ...(afterReplyFns.length > 0
      ? {
          runAfterReply: async () => {
            for (const fn of afterReplyFns) {
              try {
                await fn();
              } catch (afterReplyError) {
                console.error(
                  "[intent-decomposer] composed runAfterReply step failed:",
                  afterReplyError
                );
              }
            }
          },
        }
      : {}),
  };
}

/**
 * Punto de entrada para los adaptadores de canal (webhook Telegram + chat
 * web). Mismo contrato que `resolvePendingDecisionTurn`; cuando el
 * decomposer no aplica (pre-filtro, piso de confianza o fallo del modelo) es
 * exactamente esa llamada — cero cambio de comportamiento.
 */
export async function resolveDecomposedPendingDecisionTurn(
  db: DbClient,
  params: PendingDecisionTurnParams,
  deps: DecomposedTurnDeps = {}
): Promise<PendingDecisionTurn> {
  const routeTurn = deps.routeTurn ?? resolvePendingDecisionTurn;
  const decompose = deps.decompose ?? decomposeTurnIntents;
  const log = deps.log ?? defaultLog;

  const text = params.text ?? "";
  const pendingKinds = (params.pendingNotifications ?? []).map(
    (notification) => notification.kind
  );
  const hasPendingDecisions = pendingKinds.length > 0;

  // Comandos y arranques explícitos de caso nunca se descomponen; y el
  // pre-filtro evita pagar una llamada de modelo en turnos simples.
  if (
    params.isCommand ||
    params.isExplicitNewCaseIntent ||
    !looksLikeMultiIntentTurn(text, { hasPendingDecisions })
  ) {
    return routeTurn(db, params);
  }

  const decomposition = await decompose({
    message: text,
    pendingKinds: hasPendingDecisions ? pendingKinds : null,
  });

  if (!shouldApplyDecomposition(text, decomposition)) {
    const turn = await routeTurn(db, params);
    // A1/A2: si el turno es una side question clasificada (aunque no haya
    // split) y ningún gate lo reclamó, deja registro explícito de la
    // liberación — no solo "ningún gate coincidió".
    if (
      !turn.handled &&
      hasPendingDecisions &&
      decomposition &&
      decomposition.intents.length > 0 &&
      decomposition.intents.every((intent) => intent.kind === "question")
    ) {
      log({
        event: "side_question_released",
        channel: params.channel,
        pending_kinds: pendingKinds,
        confidence: decomposition.confidence,
      });
    } else if (decomposition?.multi_intent) {
      // multi_intent=true pero no pasó el piso/guard: candidato a mis-split.
      log({
        event: "decomposition_rejected",
        channel: params.channel,
        confidence: decomposition.confidence,
        intents: decomposition.intents.length,
      });
    }
    return turn;
  }

  // Split aplicado: cada intent recorre la cadena completa por separado.
  // No se re-pasan `pendingNotifications`: manejar el intent N puede resolver
  // notificaciones y el intent N+1 debe ver el estado fresco.
  const outcomes: IntentOutcome[] = [];
  for (const intent of decomposition!.intents) {
    const turn = await routeTurn(db, {
      ...params,
      text: intent.text,
      pendingNotifications: undefined,
    });
    outcomes.push({ intent, turn });
  }

  const composed = composePendingDecisionTurns(outcomes);
  log({
    event: "decomposition_applied",
    channel: params.channel,
    intents: outcomes.length,
    handled: outcomes.filter((outcome) => outcome.turn.handled).length,
    unhandled_kinds: outcomes
      .filter((outcome) => !outcome.turn.handled)
      .map((outcome) => outcome.intent.kind),
    composed_handled: composed.handled,
    composed_ok: composed.handled ? composed.ok : null,
    residual: composed.handled ? (composed.residual?.text ?? null) : null,
  });
  return composed;
}
