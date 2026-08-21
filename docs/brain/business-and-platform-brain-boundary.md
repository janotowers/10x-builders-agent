# Business Brain y conocimiento de mejora de plataforma

> **Estado:** dirección aceptada para diseño futuro cercano (2026-08-08).
> Aclaración de no-duplicación operativa (2026-08-21): Brain no es cola de
> acción; ver §2.
>
> **Propósito:** aclarar la expresión informal «dos Brains» sin crear dos
> arquitecturas cognitivas incompatibles. Este documento complementa
> [`gbrain-evaluation-and-plan.md`](gbrain-evaluation-and-plan.md), la semántica
> de scopes de
> [`../manuals/knowledge-scope-and-ownership.md`](../manuals/knowledge-scope-and-ownership.md)
> y la autoridad de mejora de
> [`../manuals/ai-native-loops.md`](../manuals/ai-native-loops.md).

## 1. Decisión conceptual

Gu OS no tendrá dos stacks Brain independientes.

Tendrá:

1. una arquitectura común de **7 capas y 4 dominios**;
2. una dimensión de ownership
   `platform | industry | organization | team | user`;
3. dos vistas lógicas con fuentes, destinos y autoridad diferentes:
   - **Business Brain:** qué sabe y cómo opera una inmobiliaria;
   - **Platform Knowledge and Improvement Plane:** qué aprende Gu OS sobre su
     propio producto, arquitectura y mecanismos.

«System Brain» puede usarse como nombre conversacional, pero el nombre técnico
preferido es **Platform Knowledge and Improvement Plane**. Evita sugerir otra
base de datos Brain, otro grafo o un runtime que se auto-reescribe.

## 2. Business Brain

El Business Brain sirve a scopes `organization`, `team` y `user`, con
conocimiento `industry` y `platform` aplicable como contexto gobernado.

Incluye:

- compiled truth y timeline de entidades como lead, propiedad, deal y zona;
- relaciones verificables;
- señales débiles con lifecycle y promoción;
- conocimiento operacional de la organización;
- candidatos a procedimientos propios;
- artefactos de conocimiento reutilizables entre casos.

No reemplaza:

- `operational_cases` como expediente multi-día;
- `case_facts` como verdad comercial trazable del caso;
- CRM/BigQuery como SOR transaccional;
- `SKILL.md` o `account_skills` como procedimiento ejecutable;
- memoria personal del operador.

La promoción preferida sigue siendo selectiva:

```text
case_facts / evidencia autorizada
  -> candidato con provenance
  -> revisión cuando corresponda
  -> brain timeline / compiled truth / link / signal
```

Ownership, sin segunda copia del estado operativo (2026-08-21):

- **Cases** poseen responsabilidad operativa: expediente, paso, esperas, HITL,
  `next_action_at`.
- **`case_facts`** posee verdad comercial *del caso*, con provenance y
  supersession.
- **CRM / BigQuery** siguen siendo SOR transaccional. No son lo mismo que
  `case_facts`.
- **Business Brain** posee conocimiento compilado, reutilizable y cross-caso
  (entidades, relaciones, señales, playbooks candidatos).

`brain_pages` no es cola de acción ni segunda copia de `status` /
`next_action` / commitments del Case. Sin auto-copy. El leftover v1.1 de
columnas operacionales en pages quedó fuera del schema MVP; ver
[`gbrain-evaluation-and-plan.md`](gbrain-evaluation-and-plan.md) §1.4.8,
§1.5.1, Bloque 1 y §12.1.

## 3. Platform Knowledge and Improvement Plane

Esta vista pertenece al scope `platform`. Su finalidad es mejorar Gu OS sin
mezclar conocimiento interno del producto con datos privados de una
inmobiliaria.

Sus entradas incluyen:

- incidentes y fallos de producción;
- evals, replays, simulaciones y regresiones;
- resultados de herramientas e integraciones;
- correcciones humanas y excepciones recurrentes;
- métricas de calidad, costo, latencia, rework y aprobación;
- decisiones arquitectónicas;
- gaps de documentación y contradicciones;
- aprendizajes de construcción y operación.

Sus destinos posibles incluyen:

- `SolutionPattern` versionado;
- skill global o referencia curada;
- regla de discovery o compilación;
- validator/gate determinístico;
- eval fixture o contrato de prueba;
- especificación de tool/provider;
- ADR o documentación canónica;
- propuesta de cambio de código mediante PR.

Un aprendizaje interno no se convierte automáticamente en una page textual ni
en una skill. Primero se clasifica por el artefacto que realmente lo debe
poseer.

## 4. Mapeo al modelo de 7 capas

La misma arquitectura aplica a ambas vistas:

1. **Ingestion:** evidencia empresarial autorizada para Business Brain;
   incidentes, telemetría y evals para plataforma.
2. **Memory:** compiled truth de entidades del negocio; decisiones y
   conocimiento semántico del producto cuando sea útil para consulta.
3. **Graph:** relaciones de negocio verificables; dependencias entre patrones,
   componentes, incidentes y garantías de plataforma.
4. **Signal:** observaciones débiles de clientes/mercado; señales de regresión,
   fricción, costo o repetición interna.
5. **Pattern:** candidatos de playbook de la organización; candidatos de patrón
   de solución o mejora del producto.
6. **Skill/procedural:** `account_skills`/skills de negocio; patrones, skills
   globales, validators y contratos ejecutables de plataforma.
7. **Workflow/execution:** casos y automatizaciones de la inmobiliaria;
   pipelines de CI, release, canary, mantenimiento y rollback de Gu OS.

No todo artefacto de plataforma debe almacenarse en `brain_pages`. El modelo de
capas clasifica responsabilidades; no obliga a una única tabla.

## 5. Pattern Composition Kernel

El kernel de Studio es la primera pieza concreta de conocimiento procedural
compilado de plataforma:

- `packages/workflows/src/compiler/solution-patterns.ts` es el registro
  machine-readable y ejecutable;
- [`../workflow-studio/pattern-coverage-matrix.md`](../workflow-studio/pattern-coverage-matrix.md)
  conserva provenance y destino de aprendizajes;
- [`../workflow-studio/capabilities-and-solution-patterns.md`](../workflow-studio/capabilities-and-solution-patterns.md)
  documenta cómo Studio consume capacidades y composiciones;
- tests y validadores demuestran que el conocimiento sigue vigente.

La matriz no es el kernel y el Markdown no es la garantía. Son superficies
humanas y de auditoría sobre contratos tipados, código y evidencia.

## 6. Loop de aprendizaje interno

Contrato objetivo:

```text
Observe
  -> incidentes, resultados, feedback, evals
Classify
  -> identificar el artefacto dueño
Extract
  -> candidato con evidencia y alcance
Deduplicate
  -> unir con patrón/issue existente o marcar contradicción
Propose
  -> diff versionado
Evaluate
  -> tests, replay, simulación, seguridad
Approve
  -> autoridad humana correspondiente
Publish
  -> release/canary
Measure
  -> outcome, costo, rework, aprobación
Retain_or_rollback
  -> conservar o revertir
```

El sistema puede automatizar detección, clasificación, dedupe, lint y creación
de propuestas. No puede publicar silenciosamente cambios de política,
permisos, patrones obligatorios, workflows, integraciones críticas o código de
producción.

## 7. Fuentes de verdad

- Evidencia raw: logs/eventos, sistemas externos, Object Storage o almacén
  autorizado; inmutable cuando sea posible.
- Resultados y telemetría: tablas operacionales/analytics con correlación a
  versión, caso, tool y outcome.
- Conocimiento empresarial compilado: Postgres Brain con RLS y provenance.
- Patrones/skills globales, ADRs y reglas de plataforma: Git con revisión.
- Contratos ejecutables: TypeScript, schemas, migrations y validadores.
- Evidencia de calidad: selftests, evals, replay, N0–N5 y CI.
- Markdown: representación legible, navegación, portabilidad y auditoría; no
  SOR universal.

## 8. Aislamiento y no contaminación

1. Datos tenant-owned nunca entrenan ni alimentan patrones globales sin una
   política explícita de minimización, anonimización, agregación y autorización.
2. Un comportamiento frecuente no demuestra una best practice.
3. Conocimiento `platform` no puede sobrescribir silenciosamente políticas de
   una organización; se aplica solo donde sea obligatorio o configurable según
   autoridad.
4. Una organización no puede ver evidencia, candidatos o aprendizajes de otra.
5. Evals sintéticos son preferibles para regresiones globales cuando reproducen
   suficientemente el fallo.
6. Promociones cross-scope siempre conservan provenance y justificación.

## 9. UX interna futura

La primera UI debería ser una consola interna, no una wiki genérica:

- **Learning inbox:** candidatos, evidencia, frecuencia e impacto.
- **Pattern registry:** versión, triggers, consumidores, dependencias, tests y
  estado.
- **Knowledge health:** contradicciones, docs stale, comportamiento no
  nominalizado, links rotos y cobertura.
- **Proposal review:** diff, evals, riesgo, aprobador y rollback.
- **Outcome comparison:** versión anterior vs candidata, costo y rework.

Las páginas wiki, backlinks e índices generados son útiles para navegación y
consulta. No sustituyen colas de revisión, permisos, publicación ni rollback.

## 10. Secuencia recomendada

### Ahora

- Mantener Pattern Kernel, cobertura documental y selftests sincronizados.
- Registrar incidentes/aprendizajes con evidencia suficiente.
- Hacer explícito el artefacto dueño de cada mejora.
- Conservar cambios de producción en PRs normales.

### Con Brain Layer

- Reutilizar scopes, provenance, signals, proposals y mantenimiento mecánico.
- Mantener colas separadas para conocimiento empresarial y mejora de plataforma.
- Permitir retrieval unificado solo después de filtrar autorización y scope.

### Después de acumular evidencia

- Miner de candidatos de patrones.
- Clustering y dedupe asistidos.
- Propuestas automáticas de eval/patrón/skill.
- Canary y métricas por tipo de mejora.
- Relajar HITL únicamente por operación, con evidencia sostenida y rollback.

## 11. No objetivos

- Crear un segundo Brain físico por conveniencia terminológica.
- Convertir todos los logs o chats en memoria.
- Usar datos privados de clientes como corpus global implícito.
- Permitir auto-modificación de código en runtime.
- Tratar documentación narrativa como garantía ejecutable.
- Construir una UI tipo Obsidian antes de tener loops operacionales y
  gobernanza.
