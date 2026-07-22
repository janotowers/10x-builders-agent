# Pending-decision routing (HITL de negocio por texto libre)

> Código: [`apps/web/src/lib/business-decisions/pending-decision-router.ts`](../../apps/web/src/lib/business-decisions/pending-decision-router.ts).  
> Entradas: webhook Telegram y `POST /api/chat` (web).  
> Contexto arquitectónico: [architecture.md §7.1](architecture.md#71-hitl-de-negocio-vs-hitl-de-ejecución-de-tools).

## Principio

**Determinístico para lo que cambia estado** (aprobar / ajustar / registrar datos).  
**Agente para conversación abierta** (preguntas laterales, paráfrasis, temas nuevos).  
El router de pendientes reclama un mensaje **solo** cuando hay un HITL de negocio dueño de ese turno; si no, el mensaje sigue al routing conversacional y al agente.

## Orden de gates

```text
mensaje libre
  → Gate 0  consultas de solo lectura (precio / estado del caso)
  → Gate 1  listing_description_review  (+ read_artifact; 2ª opinión LLM si unclear)
  → Gate 2  price_approval               (solo si el parse no es unclear)
  → Gate 3  contract_data_review           (escape de preguntas; 2ª opinión LLM si unclear)
  → Gate 4  contract_review
  → Gate 5  titularidad_review
  → Gate 6  comparables_search_expansion_decision
  → handled:false → routing conversacional / agente
```

| Gate | Qué hace | ¿Mutan estado? |
|------|----------|----------------|
| **0** `case-query` | Responde precio o estatus desde contexto del caso | No (solo lectura) |
| **1–6** | Handlers de business decision | Sí, cuando la decisión es clara |
| Fallthrough | Agente genérico con caso vinculado (si aplica) | Según tools del agente |

`property_data_review` (contacto externo en Telegram) **no** pasa por este router compartido.

## Gate 0 — consultas determinísticas

Patrones interrogativos estrictos (`case-query.ts`): «¿cuál fue el precio ideal?», «¿cómo va el caso?», etc.

- Responde desde `pricing_proposal` o paso/estado + pendientes abiertos.
- **No** resuelve notificaciones ni cambia `operational_cases`.
- Decisiones («APROBAR PRECIO», «AJUSTAR PRECIO salida=…») **nunca** matchean.
- Si hay ambigüedad (varios casos / sin datos) → fallthrough al agente.

**Señal de escala:** si este gate empieza a acumular muchos patrones nuevos, no engordar regex: valorar un clasificador de *consultas* (capa distinta a la 3.3).

## Escape en `contract_data_review`

Mientras faltan datos contractuales, el gate es “codicioso” (cualquier texto).  
Un detector conservador (`looksLikeSideQuestionNotData`) deja pasar preguntas sin señales de datos (email, dígitos, sí/no contractual) al agente. La notificación sigue unread.

## Fase 3.3 — 2ª opinión LLM solo en callejones (`unclear`)

Módulo: `pending-decision-unclear-classifier.ts`.

**Cuándo corre:** solo si Gate 1 o Gate 3 ya reclamó el turno y el handler devolvió `status: "unclear"`.

**Qué decide:** `release_to_agent` vs `keep_clarifying` (con confidence).  
Solo `release_to_agent` + confidence `high|medium` suelta el turno (`handled: false`).  
Fallo de API / schema / confidence `low` → **fail-open a aclarar** (comportamiento anterior).

**Qué no hace:**

- No clasifica cada mensaje.
- No aprueba, ajusta ni registra datos.
- No toca gates keyword-only (precio/contrato/titularidad/comparables): ahí el parse `unclear` ya implica no reclamar → el agente responde.

Reutiliza el modelo configurado por `OPERATIONAL_CONVERSATION_CLASSIFIER_MODEL_ID` (mismo stack OpenRouter que el clasificador de intake), con **schema propio** para HITL.

## Relación con el clasificador de intake

`classifyOperationalConversationMessage` (intake / start_case / deliver_documents) es **otra capa**, anterior o paralela al flujo conversacional. No es el árbitro de “decisión vs consulta” dentro de los gates HITL de negocio.
