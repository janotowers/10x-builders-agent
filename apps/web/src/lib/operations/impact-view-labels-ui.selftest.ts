/**
 * UI selftest de la vista de impacto (Slice 3.5-3).
 *
 * Verifica el mapeo estado/etiqueta de la superficie del operador, el ratio
 * de sobre-invalidación del exit check de Phase 3 y — crítico — que los
 * indicadores broker-safe de la case view jamás rendericen vocabulario del
 * plano de impacto (stale, artifact, hash, "plano de impacto"): regla 6 del
 * plan, el vocabulario técnico no se filtra a la superficie del broker.
 */
import assert from "node:assert/strict";
import {
  artifactTypeLabel,
  caseImpactIndicators,
  changedInputLabel,
  impactStatusLabel,
  overInvalidationRatio,
  overInvalidationRatioLabel,
} from "./impact-view-labels";

// ---- Tipos de artefacto: diccionario + fallback humanizado -----------------
assert.equal(artifactTypeLabel("comparable_set"), "Análisis de comparables");
assert.equal(artifactTypeLabel("valuation"), "Valuación");
assert.equal(
  artifactTypeLabel("price_recommendation"),
  "Recomendación de precio"
);
assert.equal(artifactTypeLabel("contract_draft"), "Borrador de contrato");
assert.equal(artifactTypeLabel("some_future_type"), "Some future type");

// ---- Estados de impacto: los cinco del enum --------------------------------
assert.equal(impactStatusLabel("current"), "Vigente");
assert.equal(impactStatusLabel("stale"), "Desactualizado");
assert.equal(impactStatusLabel("suspended"), "En pausa");
assert.equal(impactStatusLabel("invalid"), "Invalidado");
assert.equal(impactStatusLabel("superseded"), "Reemplazado");

// ---- Entradas cambiadas: fact / artifact / account_asset -------------------
assert.equal(changedInputLabel("property.bedrooms"), "Recámaras");
assert.equal(
  changedInputLabel("artifact:comparable_set"),
  "Artefacto: Análisis de comparables"
);
assert.equal(
  changedInputLabel("account_asset:commission_contract_template"),
  "Recurso de la cuenta: Plantilla de contrato de comisión"
);
// Fact key desconocida: fallback legible con el namespace recortado.
assert.equal(changedInputLabel("property.pool_size_m2"), "Pool size m2");

// ---- Ratio de sobre-invalidación (exit check Phase 3) ----------------------
assert.equal(overInvalidationRatio([]), null);
assert.equal(
  overInvalidationRatioLabel(null),
  "Sin reparaciones generadas todavía"
);
{
  const ratio = overInvalidationRatio([
    { status: "done" },
    { status: "cancelled" },
    { status: "ready" },
    { status: "cancelled" },
  ]);
  assert.ok(ratio);
  assert.equal(ratio.total, 4);
  assert.equal(ratio.cancelled, 2);
  assert.equal(ratio.ratio, 0.5);
  assert.equal(
    overInvalidationRatioLabel(ratio),
    "2 de 4 reparaciones canceladas (50% sobre-invalidación)"
  );
}

// ---- Indicadores broker-safe de la case view (3.5-2) ------------------------
assert.deepEqual(
  caseImpactIndicators({
    staleArtifacts: 0,
    invalidArtifacts: 0,
    suspendedApprovals: 0,
  }),
  []
);
assert.deepEqual(
  caseImpactIndicators({
    staleArtifacts: 1,
    invalidArtifacts: 0,
    suspendedApprovals: 0,
  }),
  ["Hay 1 resultado por actualizar tras un cambio de datos"]
);
assert.deepEqual(
  caseImpactIndicators({
    staleArtifacts: 2,
    invalidArtifacts: 1,
    suspendedApprovals: 1,
  }),
  [
    "Hay 3 resultados por actualizar tras un cambio de datos",
    "Una aprobación espera tu confirmación porque cambió la información",
  ]
);
assert.deepEqual(
  caseImpactIndicators({
    staleArtifacts: 0,
    invalidArtifacts: 0,
    suspendedApprovals: 2,
  }),
  ["2 aprobaciones esperan tu confirmación porque cambió la información"]
);

// Regla de no-fuga: en NINGUNA combinación de conteos aparecen las palabras
// del plano de impacto en la superficie del broker.
const FORBIDDEN_ON_BROKER_SURFACE =
  /stale|artifact|artefacto|hash|impact|invalidaci|suspend/i;
for (const staleArtifacts of [0, 1, 5]) {
  for (const invalidArtifacts of [0, 1, 3]) {
    for (const suspendedApprovals of [0, 1, 4]) {
      const rendered = caseImpactIndicators({
        staleArtifacts,
        invalidArtifacts,
        suspendedApprovals,
      }).join(" | ");
      assert.ok(
        !FORBIDDEN_ON_BROKER_SURFACE.test(rendered),
        `vocabulario del plano de impacto filtrado a la superficie del broker: ${rendered}`
      );
    }
  }
}

console.log("impact-view-labels-ui.selftest: ok");
