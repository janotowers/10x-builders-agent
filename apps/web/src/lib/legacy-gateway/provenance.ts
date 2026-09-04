/**
 * Provenance and freshness construction (TD-5: "provenance on every result";
 * AC-1 6.5).
 *
 * There is one builder and every capability goes through it, so a result
 * without provenance is not something a contributor can produce by forgetting -
 * they would have to construct the envelope by hand.
 *
 * On freshness: these reads are fresh operational reads by architecture. What
 * this module records is *how fresh*, taken from the source's own timestamp
 * where it has one, with the field name kept so the number is auditable. Where
 * the source carries no usable timestamp, `sourceUpdatedAt` and `ageSeconds`
 * are null rather than filled in with `readAt` - which would report every read
 * as perfectly fresh and quietly destroy the signal.
 */
import type {
  LegacyBindingState,
  LegacyGatewayCapability,
  LegacyReadAdapter,
  LegacyReadFreshness,
  LegacyReadProvenance,
  LegacyReadResult,
  LegacySourceStore,
} from "@agents/types";
import { ageSecondsBetween, normalizeTimestamp } from "./normalize";

export interface FreshnessSource {
  /** Candidate source fields, in priority order (most recent write first). */
  candidates: Array<{ field: string; value: unknown }>;
}

export function buildFreshness(
  readAt: string,
  source: FreshnessSource
): LegacyReadFreshness {
  for (const candidate of source.candidates) {
    const normalized = normalizeTimestamp(candidate.value);
    if (normalized) {
      return {
        readAt,
        sourceUpdatedAt: normalized,
        ageSeconds: ageSecondsBetween(readAt, normalized),
        sourceUpdatedAtField: candidate.field,
      };
    }
  }
  return {
    readAt,
    sourceUpdatedAt: null,
    ageSeconds: null,
    sourceUpdatedAtField: null,
  };
}

export interface ProvenanceInput {
  store: LegacySourceStore;
  sourcePath: string;
  externalId: string;
  capability: LegacyGatewayCapability;
  organizationId: string;
  bindingState: LegacyBindingState;
  freshness: LegacyReadFreshness;
  /** Defaults to the sanctioned shadow-stage adapter. */
  adapter?: LegacyReadAdapter;
}

export function buildProvenance(input: ProvenanceInput): LegacyReadProvenance {
  return {
    sourceSystem: "traditional_gu",
    store: input.store,
    sourcePath: input.sourcePath,
    externalId: input.externalId,
    capability: input.capability,
    adapter: input.adapter ?? "bootstrap_direct",
    organizationId: input.organizationId,
    bindingState: input.bindingState,
    freshness: input.freshness,
  };
}

export function withProvenance<T>(
  value: T,
  provenance: LegacyReadProvenance
): LegacyReadResult<T> {
  return { value, provenance };
}
