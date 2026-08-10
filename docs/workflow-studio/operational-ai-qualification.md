# Studio: calificación con IA operativa

> Estado: foundation implementado para `reusable_skill` (2026-08-09);
> `case_workflow`, `durable_task` y `schedule` conservan el contrato objetivo.
> La implementación reutiliza `runAgent`, resolución de modelos, metering y
> políticas de tools; no mantiene un segundo agente exclusivo del laboratorio.

## 1. Tres etapas diferentes

Studio separa deliberadamente:

1. **Simulación estructural**: replay determinista de estados, guards,
   proposers, HITL y terminales. No invoca un LLM.
2. **Prueba con IA operativa**: ejecuta el artefacto con el mismo modelo y
   política que usará en producción, dentro de un sandbox.
3. **Publicación o activación**: acto humano que vuelve a comprobar gates,
   evidencia y vigencia de la calificación.

Un modelo fuerte durante discovery o compilación no demuestra que el modelo
operativo económico ejecutará correctamente el artefacto.

## 2. Ejecutor y juez

- El **ejecutor** resuelve `MAIN_AGENT_MODEL_ID`, aliases de workers y modelos
  especializados exactamente como producción.
- El **juez** usa el rol independiente
  `WORKFLOW_OPERATIONAL_JUDGE_MODEL_ID`. Recibe output, tool calls, evidencia,
  rúbrica y criterios de aceptación; no recibe razonamiento privado ni una
  respuesta canónica del compilador.
- Assertions deterministas tienen precedencia sobre el juez. Un judge pass no
  puede aprobar un write prohibido, una tool faltante, una transición inválida
  o evidencia ausente.
- Toda llamada se mide y se atribuye a la corrida de calificación.

## 3. Fingerprint y vigencia

Cada corrida persiste una huella compuesta por:

- hash y versión del artefacto;
- modelos ejecutores resueltos y parámetros materiales;
- hashes/versiones de skills, tools y prompts aplicables;
- suite y versión de escenarios;
- versión de política sandbox;
- rúbrica y modelo juez.

Si cambia cualquier componente, `passed` se convierte en `stale`, no en
`failed`. Una prueba sandbox barata puede reencolarse automáticamente; una
prueba con datos o preparación humana debe notificar y ofrecer
**Recalificar**. Una calificación stale bloquea nuevas activaciones, pero no
despublica automáticamente trabajo vigente.

Los proveedores pueden cambiar comportamiento detrás del mismo slug. Por eso
el fingerprint se complementa con canaries periódicos y métricas de regresión;
no pretende detectar drift invisible únicamente comparando strings.

## 4. Sandbox

- Para `reusable_skill`, tools desconocidas y de riesgo medio/alto se deniegan.
  Sin fixture documental no se permite ninguna tool. Con fixture privado solo
  se autoejecutan `list_runtime_attachments`, `read_runtime_attachment` y
  `search_runtime_attachments`.
- Gmail, Telegram, publicación, scheduling y cualquier otro write externo se
  deniegan. Un intento denegado hace fallar el gate mecánico; no basta con que
  el efecto no se haya completado.
- Para la cobertura futura de casos/tareas, Gmail, Telegram, publicación y otros
  efectos se evaluarán por intención, argumentos, evidencia y preview HITL sin
  realizar el efecto; no es una capacidad ya completa.
- Casos/work runs de pruebas futuras deberán quedar marcados y fuera de cron
  normal.
- La política tiene ID/versión/hash deterministas y forma parte del fingerprint.

## 5. Cobertura proporcional

- **Skill reusable**: skill forzado, input sintético y modelo operativo;
  contrato de output, tools y HITL. Si el draft declara tools de
  `runtime_input`/`chat_attachment`, la corrida inyecta fixtures privados
  deterministas (TXT/DOCX) como `runtime_input` con provenance
  `studio_qualification_fixture`, habilita solo lecturas de adjunto y deniega
  envíos externos (Gmail/Telegram/publicación). El gate exige markers de
  fixtures en la respuesta y que no exista confirmación pendiente. El
  fingerprint incluye el contrato del pipeline de adjuntos.
- **Flujo de caso** (objetivo): reutiliza N3/N4/N5 y definición pineada.
- **Tarea durable** (objetivo): work run aislado, work-plane real y
  `exit_criteria`.
- **Programación** (objetivo): policy check y dry-run de un tick sobre el
  trabajo subyacente.
- Artefactos completamente deterministas no requieren LLM-as-judge.

Un solo resultado afortunado no basta para trabajo variable: el plan de prueba
declara muestras, umbral y escenarios holdout.

## 6. Reparación gobernada

```text
ejecutar -> evaluar -> clasificar dueño del fallo -> proponer nueva versión
-> gates -> recalificar -> revisión humana
```

El fallo se atribuye primero a spec, artefacto, capacidad/integración,
fixture/datos o modelo insuficiente. El loop es acotado y solo crea borradores
versionados. Nunca muta ni publica silenciosamente un artefacto vigente.
`non_convergent` conserva evidencia y escala a una persona.

Para `reusable_skill`, la reparación es un `POST` humano explícito sobre la
última corrida fallida y exige que versión y fingerprint sigan vigentes. El
límite operativo es tres iteraciones. Como `account_skills` V1 mantiene una
sola fila mutable por slug, el resultado se guarda aparte como propuesta
idempotente enlazada a skill, corrida, fingerprint e iteración. Revisar/aplicar,
recalificar y publicar/activar son actos posteriores independientes; generar la
propuesta no ejecuta ninguno.

Esta autoridad sigue
[`ADR-104`](../adr/ADR-104-governed-improvement.md): propuesta, eval,
aprobación, canary, medición y rollback.

## 7. Persistencia, observabilidad y límites

- `00077_studio_qualification_runs.sql` persiste runs tenant-scoped y correlación
  con `ai_usage_events`; `00078_studio_skill_repair_proposals.sql` persiste
  propuestas; `00079_generic_attachments.sql` habilita la base documental
  tenant-owned usada por Web/Telegram.
- El resultado guarda fingerprint, modelos, suite/rúbrica/sandbox, evidencia
  mecánica, juicio, latencia, tokens y costo. No guarda razonamiento privado.
- Métricas y alertas de rollout —incluido write externo objetivo cero, fixture
  gate failures, staleness y no convergencia— viven en
  [`rollout-and-observability.md`](rollout-and-observability.md).
- Los selftests prueban determinismo, fixtures, policy fail-closed, fingerprints,
  staleness y reparación. Eso no demuestra todavía cobertura operacional para
  los otros tres tipos de artefacto ni sustituye un canary real.
