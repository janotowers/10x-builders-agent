---
name: prepare-listing-price
description: Prepara una propuesta de tres precios (salida, ideal, mínimo) para una propiedad, sustentada en el análisis de comparables. Pide aprobación HITL al inmobiliario antes de fijar nada. Usado como sub-skill de property-optioning-coach durante el step `price_proposal_pending`.
scope: business
allowed_tools:
  - notify_user
  - operational_case_update_state
  - operational_case_add_event
requires_tenant_context: false
memory_extraction: ephemeral
heartbeat: blocked
guardrails: |
  Esta skill NO ejecuta acciones de venta (no manda mensajes al dueño con
  el precio, no publica). Su único output efectivo es una propuesta para
  el inmobiliario y registrar su decisión.
  El precio FINAL siempre lo decide el inmobiliario. Si el agente recibe
  una nota tipo "súbele 5%", aplícalo y vuelve a pedir confirmación, no
  asumas que es OK final.
  No fijes nunca un precio mínimo por debajo del p25 del análisis de
  comparables sin nota explícita del inmobiliario justificándolo.
---

# Prepare listing price

## Objetivo

Producir y persistir en `context_jsonb.pricing_proposal`:

```json
{
  "salida": 0,
  "ideal": 0,
  "minimo": 0,
  "currency": "MXN",
  "rationale": "...",
  "comparables_used": ["id1", "id2", "id3"],
  "approval_status": "pending" | "approved" | "rejected",
  "approved_at": "...",
  "approved_by": "..."
}
```

## Workflow

1. Lee `context_jsonb.comparables_analysis.stats`:
   - `p25`, `p50`, `p75` de `price_per_m2`.
   - `area_total_m2` desde `property_data`.
2. Calcula propuesta inicial:
   - `ideal = round(p50 * area_total_m2)` (precio "razonable").
   - `salida = round(ideal * 1.05)` (anclaje al alza, margen para
     negociación).
   - `minimo = round(p25 * area_total_m2)` (piso defensible).
   - Redondea a múltiplos sensatos: si > 5M MXN, redondea a 50,000;
     si 1-5M, a 10,000; si < 1M, a 5,000.
3. Compón `rationale` corto con:
   - mediana del mercado (p50),
   - cuántas activas vs cerradas se usaron,
   - factores conocidos (ubicación, m², estado).
4. Guarda en `context_jsonb.pricing_proposal` con `approval_status=pending`.
5. Pide HITL al inmobiliario via `notify_user(urgency=normal, kind=price_approval)`:

   ```
   📊 Propuesta de precio para [propiedad]
   - Salida: $X
   - Ideal: $Y
   - Mínimo: $Z
   - Base: N comparables (p25=$A, p50=$B, p75=$C por m²)
   - Razón: [rationale]

   ¿Apruebas? Si quieres ajustar, dime cuál y a cuánto.
   ```

6. Inserta evento `operational_case_add_event(human_decision, payload={kind: price_proposed})`.
7. Mueve `current_step` se queda en `price_proposal_pending`,
   `status=waiting_external` (sí, esperamos respuesta humana del
   inmobiliario; aunque sea interno, espera input).

8. Cuando el inmobiliario apruebe (vía respuesta de chat normal, no por
   webhook):
   - Actualiza `pricing_proposal.approval_status=approved`,
     `approved_at=now()`.
   - Inserta `operational_case_add_event(human_decision, payload={kind: price_approved, salida, ideal, minimo})`.
   - Mueve `current_step=contract_pending`.

9. Si el inmobiliario rechaza/ajusta:
   - Aplica el ajuste, vuelve a paso 4 con la nueva propuesta.

## Antipatrones

- Marcar `approved` antes de tener confirmación explícita del humano
  ("ok", "va", "apruebo", "publícalo a ese precio").
- Permitir `minimo > ideal` o `salida < ideal` (validar siempre
  `salida >= ideal >= minimo`).
- Olvidar persistir `comparables_used` (sin auditoría no se puede
  defender el precio si el dueño pregunta).
