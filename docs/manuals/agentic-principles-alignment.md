# Principios agenticos externos y alineacion con Gu OS

> **Estado:** referencia viva (no plan de implementacion)
> **Audiencia:** Janot (arquitecto/dueño), autores de skills, reviewers de roadmap
> **Fuentes:** ensayos de Garry Tan sobre GStack / G Brain (abril 2026), contrastados con el repo y docs actuales de Gu OS
> **Relacion:** complementa [`gu-os-understanding.md`](gu-os-understanding.md) (narrativa), [`business-brain-evolution-roadmap.md`](../business-brain-evolution-roadmap.md) (roadmap; Inspiration 2 = Karpathy LLM Wiki, Inspiration 3 = GStack), [`brain/gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md) (Brain Layer; §1.1 genealogía) y [`skills-tools-architecture.md`](../skills-tools-architecture.md) (skills vs tools)

---

## 1. Por que existe este documento

Los ensayos *Thin Harness, Fat Skills*, *Homebrew for Personal AI* y el ciclo
*Skill Development Cycle* (repo GBrain) articulan una tesis que Gu OS ya sigue en
gran parte: **el valor no esta en un modelo mas listo, sino en el contexto correcto,
en el momento correcto, con procedimientos reutilizables y ejecucion deterministica
donde importa la confianza**.

Este documento captura:

1. Las definiciones y capas de esos ensayos (resumen).
2. Como se mapean a Gu OS **hoy**, **planeado** o **rechazado a proposito**.
3. Una guia operativa **skill vs code** adaptada a nuestro stack.
4. Enlaces a donde profundizar sin duplicar el plan Brain de 2000 lineas.

---

## 2. Fuentes citables

| Fuente | Tesis central | Relevancia para Gu OS |
|--------|---------------|------------------------|
| **LLM Wiki** (Andrej Karpathy, [gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)) | Wiki persistente mantenido por LLM: raw inmutable, compilación, Ingest/Query/Lint; conocimiento que **compone** en lugar de redescubrirse cada query | Informa Brain Layer (compiled truth, timeline, dream cycle, ingestion). Mapping en [`business-brain-evolution-roadmap.md`](../business-brain-evolution-roadmap.md) Inspiration 2 y [`gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md) §1.1. Gu OS rechaza Obsidian-as-product y index-only-without-RAG. |
| **Thin Harness, Fat Skills** (Garry Tan, 2026-04-09) | Cinco definiciones (skill, harness, resolver, latent/deterministic, diarization); arquitectura de tres capas; loop de auto-mejora; guia skill vs code | Valida skills + tools + routing + separacion juicio/ejecucion. Brain Layer y Pattern→Skill son la frontera pendiente. |
| **Homebrew for Personal AI** (Garry Tan, 2026-04-11) | Markdown como codigo; recipes como paquetes distribuibles; el agente implementa capacidades nativas desde una spec | Valida `SKILL.md` + `references/` + `account_skills`. Capability packs (V3+) y recipe distribution quedan como direccion futura, no como producto hoy. |
| **Skill Development Cycle** (GBrain repo, `skill-development.md`) | Discovery → draft → quality bar → activation; MECE ownership; no promover sin evidencia | Mapea a Skill Lab + N0–N5 + rúbrica `skill-authoring`; quality bar instrumentable en [`testing-framework.md`](../operational-cases/testing-framework.md) §13. |

Lecturas profundas en el repo:

- Plan Brain Layer: [`docs/brain/gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md)
- Skills y tools: [`docs/skills-tools-architecture.md`](../skills-tools-architecture.md)
- Skill routing: [`docs/tools-design/skill-routing.md`](../tools-design/skill-routing.md)
- Roadmap agente: [`docs/business-brain-evolution-roadmap.md`](../business-brain-evolution-roadmap.md)

---

## 3. Las cinco definiciones (resumen) y su mapping

### 3.1 Skill file

**En los ensayos:** markdown reutilizable que ensena **como** hacer algo; el usuario o la invocacion aporta **que** y con que parametros. Funciona como method call: mismo procedimiento, distintos argumentos.

**En Gu OS hoy:**

- `skills/global/<slug>/SKILL.md` con frontmatter (`name`, `description`, `scope`, `allowed_tools`, `includes`, …).
- `account_skills` por cuenta (override por slug).
- Composicion via `includes` y progressive disclosure con `references/` + tool `read_skill_reference`.
- Inyeccion al prompt en `buildPlaybookInjection` (`packages/agent/src/skills/runtime.ts`).

**Brecha:** versionado completo de account skills, QA pre-publicacion, promocion automatica desde patrones observados (capa Pattern). MECE checks formales al crear skills vecinas.

**Estado:** **Alineado y fuerte.**

---

### 3.2 Harness

**En los ensayos:** el programa que corre el LLM en loop, lee/escribe archivos, gestiona contexto y aplica safety. Debe ser **delgado** (~200 lineas en el ideal de Garry).

**En Gu OS hoy:**

- `runAgent` + LangGraph (`memory_injection` → `compaction` → `agent` ↔ `tools`) en `packages/agent/src/graph.ts`.
- Canales: web, Telegram, cron, heartbeat, operational cases.
- HITL via `interrupt`, checkpointer Postgres, compaction, memory flush, tenant context, tool catalog con risk levels.

**Diferencia a proposito:** nuestro harness **no** es minimalista en lineas porque es **producto multi-tenant** con RLS, trazabilidad, aprobaciones y integraciones reales. La alineacion es de **responsabilidades**, no de tamano de archivo: el harness orquesta; no debe acumular logica de dominio ni juicio operacional.

**Estado:** **Alineado en principio; distinto en forma (mas robusto, menos thin).**

---

### 3.3 Resolver

**En los ensayos:** tabla de routing de contexto — cuando aparece la tarea X, cargar el documento Y primero. En Claude Code, la `description` de cada skill **es** el resolver.

**En Gu OS hoy:**

- Selector pre-graph (`selectSkillForTurn`) + metadata `description` de cada skill.
- Guards deterministicos (p. ej. property-optioning, follow-up de mes).
- `routingContext` para continuidad de turnos cortos.
- Binding forzado: operational cases (`default_skill_slug`), scheduled tasks, `forcedSkillId`.
- Filtro por `user_skill_settings.enabled`.

**Diferencia a proposito:** Gu OS usa un **modelo selector separado** (temperatura 0, auditable) en lugar de que el modelo principal cargue skills dentro del loop. Ver rationale en [`skill-routing.md`](../tools-design/skill-routing.md).

**Estado:** **Alineado con variante propia (pre-graph resolver).**

---

### 3.4 Latent vs deterministic

**En los ensayos:** juicio, sintesis y adaptacion en espacio latente (LLM); lookup, numeros, SQL y status en codigo deterministico (misma entrada → misma salida).

**En Gu OS hoy:**

- Skills = criterio y workflow (latent).
- Tools + adapters = ejecucion (`TOOL_CATALOG`, `adapters.ts`).
- Wrappers de negocio con SQL fijo parametrizado (p. ej. `bigquery_lookup_local_comparables`).
- Heartbeat prefetchers con `executor_kind=deterministic`.
- HITL en tools de riesgo medio/alto.

**Estado:** **Muy alineado.** Ver tambien §5 de este documento y [`skills-tools-architecture.md`](../skills-tools-architecture.md) §4.

---

### 3.5 Diarization

**En los ensayos:** leer muchas fuentes sobre un sujeto y producir un perfil estructurado de juicio (no un dump de RAG).

**En Gu OS hoy:**

- Parcial: `memories` (usuario), `business_brain` JSONB (cuenta), extraccion post-turno.
- **No implementado:** Brain Layer (`brain_pages`, compiled_truth + timeline, `brain_links`, `brain_signals`).

**Planeado:** Bloques 1–4 de [`gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md); Ingestion Layer y Pattern mining como forward-looking.

**Estado:** **Conceptualmente alineado; implementacion pendiente.**

---

## 4. Tres capas (ensayos) vs siete capas (Gu OS)

Los ensayos proponen:

```text
Fat skills (arriba) → Thin harness (medio) → Deterministic foundation (abajo)
```

Gu OS extiende esto al modelo **7 capas / 4 dominios** del plan Brain (sec 1.4 de `gbrain-evaluation-and-plan.md`):

| Capa Gu OS | Equivalente en ensayos | Estado v1 |
|------------|------------------------|-----------|
| 1. Ingestion | Evidencia cruda hacia el sistema | Hook / roadmap |
| 2. Memory | Diarization + compiled truth | Planeado (Bloque 1) |
| 3. Graph | Relaciones tipadas consultables | Planeado (Bloque 2) |
| 4. Signal | Observaciones debiles | Planeado (Bloque 4) |
| 5. Pattern | Candidatos mineables → skill | Hook / roadmap |
| 6. Skill | Fat skills | **Implementado** |
| 7. Workflow | Harness + canales + HITL | **Implementado** |

Regla rectora que Gu OS anade y los ensayos personal-agent no enfatizan igual: **dos flechas HITL obligatorias** — `Signal → Memory` y `Pattern → Skill`. La autonomia se gana con evidencia y revision humana, no se asume.

---

## 5. Guia de decision: skill o code/tool?

Adaptacion de la guia del ensayo *Thin Harness, Fat Skills* al stack Gu OS.

| Pregunta | Si la respuesta es SI | Si la respuesta es NO |
|----------|----------------------|------------------------|
| El agente necesita pensar, adaptarse o hacer preguntas? | **Skill** (`SKILL.md`) | Code / tool |
| Misma entrada → misma salida siempre? | **Code** (adapter, wrapper, prefetcher) | Skill |
| Requiere juicio sobre el entorno del usuario? | **Skill** | Code / tool |
| Es lookup, listado o status check? | **Code** / tool | Probablemente skill |
| Cambia segun contexto conversacional? | **Skill** | Code / tool |

### Ejemplos Gu OS

| Capacidad | Destino | Por que |
|-----------|---------|---------|
| Responder "cuantos leads en abril?" con criterio de negocio | **Skill** `company-data` | Juicio sobre que consultar, como filtrar tenant, como resumir |
| Ejecutar SQL read-only validado | **Tool** `bigquery_run_query` | Ejecucion; la skill decide cuando |
| Comparables con filtros de dominio | **Tool** `bigquery_lookup_local_comparables` | SQL deterministico en codigo |
| Prefetch de calendario antes del heartbeat | **Code** prefetcher deterministico | Misma ventana → misma lectura registrada |
| Intake conversacional de un caso operacional | **Skill** + tools de caso | Adaptacion al usuario; tools actualizan estado |
| Listar integraciones / health check | **Code** / tool de status | Lookup deterministico |
| Curar memoria personal del usuario | **Skill** `memory-curate` | Juicio sobre que conservar o descartar |
| Promover un patron observado a playbook | **Skill** (futuro) tras HITL en Pattern | Juicio humano; destino es `SKILL.md` o `account_skills` |

**Regla practica:** si es tabla de lookup o calculo repetible, va abajo (tool/adapter). Si el agente debe decidir **si**, **cuando** o **como** interpretar, va arriba (skill).

---

## 6. Markdown as package (Homebrew for Personal AI)

**Tesis del ensayo:** una recipe markdown es simultaneamente documentacion, especificacion, paquete y fuente de implementacion; `gbrain install voice-agent` distribuye capacidad sin dependency hell.

**Mapping Gu OS:**

| Idea del ensayo | Equivalente Gu OS | Estado |
|-----------------|-------------------|--------|
| Recipe markdown | `SKILL.md` + `references/` | Hoy |
| Fork trivial (editar markdown → cambia comportamiento) | Skills en Git + `account_skills` | Hoy (parcial) |
| Agent como package manager | Selector + registry + skill-authoring API | Hoy (parcial) |
| Sync diario "n nuevas recipes" | No existe | Futuro / optional V3+ |
| Capability packs internos | Roadmap V3+ en `business-brain-evolution-roadmap.md` | Planeado |
| Implementacion nativa por cuenta sin codigo upstream | Parcial via `account_skills`; no generacion automatica de integraciones | V2+ |

**Disciplina OpenClaw citada en el ensayo:** *"Si me pides algo dos veces, fallaste"* → codificar en skill o automatizar en cron/heartbeat. En Gu OS: usar [`skill-authoring`](../skills/global/skill-authoring/SKILL.md), operational cases y scheduled tasks; no dejar procedimientos repetibles solo en conversacion.

---

## 7. Matriz de alineacion ejecutiva

| Concepto | Alineacion | Accion recomendada |
|----------|------------|-------------------|
| Fat skills | Alta | Seguir escribiendo playbooks; usar `includes` y references antes de micro-skills |
| Thin harness | Media (forma distinta) | No inflar `graph.ts` con logica de dominio; empujar juicio a skills |
| Resolver | Alta | Mantener descriptions claras; mejorar routingContext; evaluar multi-skill solo con evidencia |
| Latent vs deterministic | Alta | Mas wrappers deterministicos para metricas repetibles |
| Diarization / Brain | Baja (hoy) | Ejecutar plan Brain Layer Bloques 1–4 |
| Self-learning loop | Baja (hoy) | Pattern → Skill con HITL; no auto-escribir skills sin revision |
| Quality bar / Skill Lab | Parcial | Rúbrica + N0–N5 casos + Skill Lab documentado; falta UI unificada «Describe tu proceso» |
| Recipe distribution | Emergente | Capability packs V3+; no marketplace abierto antes de sandbox |
| HITL / tenant safety | Gu OS **por delante** del ensayo personal-agent | Preservar como invariante; no sacrificar por "thinness" |

---

## 8. Que NO copiar literalmente

Decisiones conscientes documentadas en Gu OS (no regresiones):

1. **Harness de ~200 lineas** — incompatible con RLS, HITL multi-canal, audit trail y producto web.
2. **Obsidian / wiki-first** — principio *operacional, no Obsidian* en el plan Brain.
3. **`gbrain install` / recipes que generan integraciones sin gates** — requiere permisos, integraciones y sandbox.
4. **Scripts ejecutables en carpetas de skill** — rechazado en V1/V1.5 (`business-brain-evolution-roadmap.md`).
5. **Promover observaciones a verdad sin humano** — contradice Signal→Memory y Pattern→Skill con HITL.
6. **Fat harness con 40+ tool definitions en contexto** — anti-patron del ensayo; Gu OS ya acota tools por skill y disponibilidad.

---

## 9. Proximos pasos documentales y de producto

Este documento **no abre nuevos bloques de implementacion**. Refuerza prioridades ya en roadmap:

1. **Corto plazo:** mas skills operativas y wrappers deterministicos; no expandir el harness.
2. **Medio plazo:** Brain Layer (Memory, Graph, Signal) segun plan existente.
3. **Largo plazo:** Pattern mining → Skill con HITL; capability packs; distribucion interna de recipes.

Cuando cambie el estado de una fila de la matriz (§7), actualizar este documento y, si aplica, Inspiration 3 en `business-brain-evolution-roadmap.md`.

---

## 10. Skill Development Cycle — mapping operativo

Resumen del documento GBrain `skill-development.md` y como Gu OS lo instrumenta **sin** checklist aspiracional suelto.

| Fase GBrain | Gu OS hoy | Instrumentacion |
|-------------|-----------|-----------------|
| Observe / discover | Conversacion, operational cases en prod, Brain signals (planeado) | Autoría NL con preguntas de clarificacion; gap analysis vs `TOOL_CATALOG` |
| Draft skill | `skill-authoring`, `account_skills` | Propuesta + rúbrica PASS/WARN/FAIL |
| MECE / ownership | Convencion docs + §12.3 `skills-tools-architecture.md` | Near-miss evals; no dos skills con mismo trigger |
| Quality bar | «3–10 casos reales», «usuario aprobo» | **Casos:** N3/N4/N5 lab; **Skills:** Skill Lab + evals; ver testing-framework §13 |
| Activate | HITL siempre | Settings readiness; no auto-promote Pattern→Skill |

**Dos laboratorios, una filosofia:**

- **Preparacion operativa (N0–N5):** casos multi-dia con `current_step`. N5 = laboratorio E2E controlado implementado; bateria CI pendiente.
- **Skill Lab:** skills de un turno sin esperas — mas rapido; no exige N4/N5.

El sistema debe **inferir la forma** (caso vs skill) desde NL con clarificacion, no preguntar al usuario «¿quieres un flujo operacional?» como primera pantalla. Ver [`use-case-authoring-vision.md`](../operational-cases/use-case-authoring-vision.md).

---

## 11. Enlaces rapidos por rol

| Rol | Leer |
|-----|------|
| Producto / vision | §1–4 y §7 de este doc + [`gu-os-understanding.md`](gu-os-understanding.md) §3 |
| Autor de skills | §5, §10 + [`skills-tools-architecture.md`](../skills-tools-architecture.md) §12 |
| Casos operacionales / QA | [`testing-framework.md`](../operational-cases/testing-framework.md) §13 |
| Ingenieria runtime | §3.2–3.3 + [`skill-routing.md`](../tools-design/skill-routing.md) |
| Brain Layer | §3.5, §4 + [`gbrain-evaluation-and-plan.md`](../brain/gbrain-evaluation-and-plan.md) |
