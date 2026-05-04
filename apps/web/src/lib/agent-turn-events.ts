import type { AgentTurnEvent } from "@agents/agent";

type Subscriber = (event: AgentTurnEvent) => void;

const subscribersByTurn = new Map<string, Set<Subscriber>>();
const recentByTurn = new Map<string, AgentTurnEvent[]>();
const MAX_RECENT_EVENTS = 50;

function normalizeEvent(turnId: string, event: AgentTurnEvent): AgentTurnEvent {
  return {
    ...event,
    turnId: event.turnId ?? turnId,
    at: event.at ?? new Date().toISOString(),
  };
}

export function publishTurnEvent(turnId: string, event: AgentTurnEvent): void {
  const normalized = normalizeEvent(turnId, event);
  const recent = recentByTurn.get(turnId) ?? [];
  recent.push(normalized);
  recentByTurn.set(turnId, recent.slice(-MAX_RECENT_EVENTS));

  const subscribers = subscribersByTurn.get(turnId);
  if (!subscribers) return;
  for (const subscriber of subscribers) {
    subscriber(normalized);
  }
}

export function subscribeToTurnEvents(
  turnId: string,
  subscriber: Subscriber
): () => void {
  const subscribers = subscribersByTurn.get(turnId) ?? new Set<Subscriber>();
  subscribers.add(subscriber);
  subscribersByTurn.set(turnId, subscribers);

  for (const event of recentByTurn.get(turnId) ?? []) {
    subscriber(event);
  }

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      subscribersByTurn.delete(turnId);
    }
  };
}

