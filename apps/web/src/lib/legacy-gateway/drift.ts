/**
 * Contract-fixture validation and the drift alarm (TD-5).
 *
 * The bootstrap adapters couple Gu OS to messy physical shapes in two
 * repositories that moved 13 and 32 commits in the three days before this Slice
 * started. The mitigation TD-5 sanctions is not "be careful": it is a recorded
 * contract per source document plus **an alarm that pages an operator when a
 * shape stops matching**, so the failure mode is a page rather than a
 * plausible-looking wrong answer.
 *
 * The rule that decides what counts as drift:
 *
 *   * a field the capability **depends on** disappearing or changing kind is
 *     drift - the normalizer would produce a wrong or empty value;
 *   * an **additional** field appearing is not. Both legacy repositories add
 *     fields continuously; alarming on that would train operators to ignore the
 *     alarm, which is worse than not having one.
 */
import type { LegacyGatewayCapability, LegacySourceStore } from "@agents/types";

// ============================================================
// Contract vocabulary
// ============================================================

/**
 * Value kinds as they actually arrive from the sources, not as TypeScript sees
 * them. `timestamp` and `reference` exist because Firestore returns driver
 * objects (`Timestamp`, `DocumentReference`) that are neither strings nor plain
 * objects, and because the same logical field is stored in more than one
 * representation in parts of the imported inventory.
 */
export type SourceFieldKind =
  | "string"
  | "number"
  | "boolean"
  | "timestamp"
  | "reference"
  | "array"
  | "object";

export interface SourceFieldSpec {
  kinds: readonly SourceFieldKind[];
  /**
   * Required fields are the ones the normalizer depends on. Everything else is
   * best-effort and its absence yields null, not an alarm.
   */
  required: boolean;
  /** Why the capability depends on it - kept next to the assertion. */
  note?: string;
}

export interface SourceContract {
  /** Stable id, e.g. `firestore.leads.v1`. Appears in the alarm. */
  id: string;
  store: LegacySourceStore;
  /** Allowlisted path template this contract describes. */
  path: string;
  fields: Record<string, SourceFieldSpec>;
}

export type ContractViolationKind = "missing" | "kind_mismatch";

export interface ContractViolation {
  field: string;
  kind: ContractViolationKind;
  expected: readonly SourceFieldKind[];
  /** Observed kind only - never the observed value. */
  observed: string;
}

// ============================================================
// Kind detection
// ============================================================

function looksLikeTimestamp(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !Number.isNaN(Date.parse(value));
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.toDate === "function") return true;
    // Firestore Timestamps survive JSON serialization as `_seconds`, which is
    // how they appear in recorded fixtures.
    if (
      typeof candidate._seconds === "number" ||
      typeof candidate.seconds === "number"
    ) {
      return true;
    }
  }
  return false;
}

function looksLikeReference(value: unknown): boolean {
  // A DocumentReference exposes `path`; part of the imported inventory stores
  // the same thing as a plain text path instead (Slice Plan 4).
  if (typeof value === "string") return value.includes("/");
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    return typeof candidate.path === "string" || typeof candidate.id === "string";
  }
  return false;
}

/** Reports the kind of an observed value for diagnostics. Never its content. */
export function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "timestamp(Date)";
  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.toDate === "function") return "timestamp(Timestamp)";
    if (typeof candidate._seconds === "number") return "timestamp(serialized)";
    if (typeof candidate.path === "string") return "reference";
    return "object";
  }
  return typeof value;
}

function matchesKind(value: unknown, kind: SourceFieldKind): boolean {
  switch (kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "timestamp":
      return looksLikeTimestamp(value);
    case "reference":
      return looksLikeReference(value);
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        value !== null && typeof value === "object" && !Array.isArray(value)
      );
  }
}

// ============================================================
// Validation
// ============================================================

/**
 * Compares a raw source document against its contract.
 *
 * A `null` value for an optional field is normal in these sources and is not a
 * violation; a `null` for a required field is, because the normalizer would
 * silently produce an empty result from it.
 */
export function validateAgainstContract(
  contract: SourceContract,
  document: Record<string, unknown>
): ContractViolation[] {
  const violations: ContractViolation[] = [];
  for (const [field, spec] of Object.entries(contract.fields)) {
    const present = Object.prototype.hasOwnProperty.call(document, field);
    const value = document[field];
    if (!present || value === undefined || value === null) {
      if (spec.required) {
        violations.push({
          field,
          kind: "missing",
          expected: spec.kinds,
          observed: describeKind(value),
        });
      }
      continue;
    }
    if (!spec.kinds.some((kind) => matchesKind(value, kind))) {
      violations.push({
        field,
        kind: "kind_mismatch",
        expected: spec.kinds,
        observed: describeKind(value),
      });
    }
  }
  return violations;
}

// ============================================================
// The alarm
// ============================================================

export interface DriftAlarm {
  /** Stable machine code an alerting rule can match on. */
  code: "LEGACY_GATEWAY_CONTRACT_DRIFT";
  contractId: string;
  store: LegacySourceStore;
  path: string;
  capability: LegacyGatewayCapability;
  organizationId: string;
  /** Opaque external identifier the read was performed with. */
  externalId: string;
  violations: ContractViolation[];
  raisedAt: string;
}

export type DriftAlarmSink = (alarm: DriftAlarm) => void;

const sinks = new Set<DriftAlarmSink>();

/**
 * Registers an additional destination for drift alarms (Sentry, an on-call
 * webhook). Returns an unregister function so tests can install a sink without
 * leaking it into the next test.
 */
export function registerDriftAlarmSink(sink: DriftAlarmSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/**
 * Raises the alarm. Always logs a single structured line first, so the signal
 * survives even when no sink is registered and even if a sink throws - an
 * alarm that can be swallowed by its own delivery path is not an alarm.
 */
export function raiseDriftAlarm(alarm: DriftAlarm): void {
  console.error(`[legacy-gateway] ${alarm.code} ${JSON.stringify(alarm)}`);
  for (const sink of sinks) {
    try {
      sink(alarm);
    } catch (error) {
      console.error("[legacy-gateway] drift alarm sink failed:", error);
    }
  }
}

export interface ContractCheckInput {
  contract: SourceContract;
  document: Record<string, unknown>;
  capability: LegacyGatewayCapability;
  organizationId: string;
  externalId: string;
}

/**
 * The check every adapter runs before normalizing. Returns the violations it
 * found (empty when the shape still matches) and raises the alarm as a side
 * effect, so a caller cannot accidentally check without alarming.
 *
 * It does not throw: whether drift refuses the read or degrades it is the
 * capability's decision, and SL-1's capabilities all refuse.
 */
export function checkSourceContract(input: ContractCheckInput): ContractViolation[] {
  const violations = validateAgainstContract(input.contract, input.document);
  if (violations.length > 0) {
    raiseDriftAlarm({
      code: "LEGACY_GATEWAY_CONTRACT_DRIFT",
      contractId: input.contract.id,
      store: input.contract.store,
      path: input.contract.path,
      capability: input.capability,
      organizationId: input.organizationId,
      externalId: input.externalId,
      violations,
      raisedAt: new Date().toISOString(),
    });
  }
  return violations;
}
