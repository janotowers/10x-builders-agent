# Skills y Tools: Guía de Arquitectura

Esta guía explica cómo pensar en **skills**, **tools**, wrappers de negocio y
adapters internos en Gu OS. Está escrita para quien necesita entender el diseño
sin ser experto en la arquitectura del repo.

La idea central es:

> Una skill describe **qué trabajo debe hacerse y con qué criterio**. Una tool
> ejecuta **una capacidad concreta**. Un adapter interno es código reusable que
> varias tools pueden usar por debajo.

---

## 1. Qué es una skill en el sistema Gu OS

Una skill es una instrucción estructurada para el agente. Vive normalmente en
`skills/global/<slug>/SKILL.md` o como skill privada por cuenta.

Una skill puede:

- reconocer cuándo aplica (`description`);
- declarar qué tools puede usar (`allowed_tools`);
- incluir otras skills (`includes`);
- explicar un workflow;
- definir guardrails;
- decir cuándo pedir aprobación humana (HITL);
- orientar cómo interpretar resultados.

Una skill **no debería** ser el lugar principal para lógica numérica o SQL
crítico si esa lógica debe ser repetible. Para eso conviene usar tools o
funciones determinísticas.

### Skill final o user-facing

Es una skill que puede resolver una intención del usuario.

Ejemplo: `company-data`.

`company-data` responde preguntas de negocio contra BigQuery: conteos, KPIs,
tendencias, funnels, inventario, etc. El usuario puede pedir:

> "Cuántas propiedades publicadas tiene esta inmobiliaria?"

La skill decide qué consulta necesita, usa referencias, llama la tool adecuada y
resume el resultado.

### Skill compuesta

Es una skill que incluye otras skills para cubrir un workflow mayor.

Ejemplo: `property-optioning-coach`.

Incluye sub-skills como:

- `request-property-documents`;
- `extract-property-characteristics`;
- `perform-comparable-analysis`;
- `prepare-listing-price`;
- `prepare-commission-contract`;
- `request-property-photos`;
- `publish-listing-package`.

La skill compuesta no hace todo en una sola instrucción. Orquesta etapas.

### Skill de referencia o core

Es una skill reusable que no está pensada para responder directamente al usuario,
sino para compartir conocimiento común.

Ejemplo: `business-data-core`.

`business-data-core` documenta:

- tablas del warehouse;
- joins canónicos;
- convenciones de fechas;
- filtros por tenant;
- glossary;
- few-shots SQL.

`company-data` la incluye:

```yaml
includes:
  - business-data-core
```

No son redundantes:

- `business-data-core` = biblioteca/canon de warehouse.
- `company-data` = skill user-facing que usa ese canon para responder preguntas.

---

## 2. Qué es una tool

Una tool es una capacidad ejecutable registrada en `TOOL_CATALOG` y respaldada
por un adapter runtime.

Ejemplos:

- `bigquery_run_query`;
- `easybroker_search_listings`;
- `easybroker_create_listing`;
- `image_watermark`;
- `telegram_send_message_to_contact`;
- `gmail_send_email`.

Las tools tienen:

- `id` / `name`;
- descripción;
- riesgo (`low`, `medium`, `high`);
- integración requerida;
- schema de parámetros;
- implementación runtime.

La skill decide **cuándo** usar una tool. La tool define **cómo** se ejecuta la
capacidad.

`gmail_send_email` ilustra el contrato completo de una escritura externa:
catálogo `risk=high`, integración OAuth `gmail`, preview HITL con destinatario,
asunto, cuerpo, evidencia y adjuntos, validación tenant/caso en el adapter y
auditoría del resultado. El scope actual es únicamente `gmail.send`; no implica
lectura de bandeja ni detección de respuestas. Ver
[`workflow-studio/capabilities-and-solution-patterns.md`](workflow-studio/capabilities-and-solution-patterns.md).

---

## 3. Tool técnica vs wrapper de negocio

No todas las tools están al mismo nivel.

### Tool técnica

Una tool técnica expone una capacidad genérica.

Ejemplo: `bigquery_run_query`.

Esta tool no sabe qué es un comparable inmobiliario. Sólo sabe ejecutar una
consulta SQL read-only contra BigQuery.

### Ejemplo aplicado: Avaclick + geocoding

Para opinión de valor inmobiliaria conviene separar capas:

- `get_avaclick_valuation` = tool técnica de valuación externa.
- `geocode_property_address` = tool técnica de enriquecimiento de ubicación.
- `prepare-property-value-opinion` = skill user-facing que conversa, pide faltantes,
  geocodifica y luego llama Avaclick.
- `perform-comparable-analysis` = skill operativa de caso que no abre conversación
  para faltantes; si Avaclick no está disponible, continúa con otras fuentes.

Recibe algo como:

```json
{
  "sql": "SELECT COUNT(*) FROM ... WHERE u.organization_id = @organization_id",
  "params": {
    "organization_id": "org_123"
  }
}
```

Su responsabilidad es:

1. validar que el SQL sea read-only;
2. rechazar DDL/DML, múltiples statements o scripting;
3. aplicar hardening de tenant cuando corresponde;
4. llamar BigQuery;
5. devolver filas o errores.

Flujo:

```text
LLM escribe SQL -> bigquery_run_query valida/ejecuta -> BigQuery
```

Sirve para preguntas analíticas variadas. Por eso encaja bien con `company-data`.

### Wrapper de negocio

Un wrapper de negocio recibe argumentos de dominio y oculta la complejidad
técnica.

Ejemplo: `bigquery_lookup_local_comparables`.

En vez de pedir SQL, recibe filtros inmobiliarios:

```json
{
  "zona": "Colomos Providencia",
  "operation": "rent",
  "property_type": "Departamento",
  "limit": 25
}
```

La tool wrapper debería:

1. construir una consulta determinística en código;
2. usar parámetros seguros;
3. aplicar filtros de tenant;
4. ejecutar BigQuery por debajo;
5. normalizar resultados;
6. devolver un shape estable para la skill.

Flujo:

```text
LLM manda filtros -> wrapper crea SQL fijo parametrizado -> BigQuery -> resultado normalizado
```

La diferencia clave:

```text
bigquery_run_query
= "ejecuta este SQL que ya te paso"

bigquery_lookup_local_comparables
= "dame comparables internos para estos filtros"
```

---

## 4. Qué significa "SQL determinístico"

Cuando decimos que un wrapper "arma SQL", no significa que el LLM inventa SQL
cada vez.

Significa:

```text
código fijo + filtros variables = SQL final parametrizado
```

Ejemplo conceptual:

```ts
const sql = `
  WITH user_ids AS (
    SELECT u.document_id AS user_id
    FROM \`ungga-full.firestore_users.users_light\` u
    WHERE u.organization_id = @organization_id
      AND (u.is_test IS NULL OR u.is_test = FALSE)
  )
  SELECT ...
  FROM \`ungga-full.firestore_properties.properties_light\` p
  JOIN user_ids u ON REPLACE(p.user_owner, 'users/', '') = u.user_id
  WHERE p.ad_status = 'Publicado'
    AND p.house_type = @property_type
    AND p.monetization_type_display = @operation
`;

const params = {
  organization_id,
  property_type,
  operation,
  zona,
  limit
};
```

La estructura del SQL vive en código. El LLM no la redacta. Sólo manda filtros
de negocio.

Esto reduce errores como:

- olvidar el filtro por tenant;
- consultar una tabla equivocada;
- mezclar venta y renta;
- devolver columnas inconsistentes;
- calcular métricas de forma distinta en cada corrida.

---

## 4.1 Cuándo es skill y cuándo es code/tool

Los ensayos *Thin Harness, Fat Skills* (Garry Tan, GStack) resumen la frontera
así: **skills enseñan procedimiento y juicio; code/tools ejecutan capacidades
repetibles**. Gu OS ya opera con esa separación; esta sección la hace explícita
para autores de skills. Matriz ampliada y mapping a capas del sistema:
[`docs/manuals/agentic-principles-alignment.md`](manuals/agentic-principles-alignment.md).

| Pregunta | Si SÍ | Si NO |
|----------|-------|-------|
| ¿El agente debe pensar, adaptarse o preguntar? | **Skill** | Code / tool |
| ¿Misma entrada → misma salida? | **Code** / tool | Skill |
| ¿Requiere juicio sobre el entorno del usuario? | **Skill** | Code / tool |
| ¿Es lookup, listado o status? | **Code** / tool | Probablemente skill |
| ¿Depende del contexto conversacional? | **Skill** | Code / tool |

Ejemplos en este repo:

| Caso | Destino | Referencia |
|------|---------|------------|
| Pregunta analítica de negocio con tenant safety | Skill `company-data` | `skills/global/company-data/` |
| Ejecutar SQL read-only validado | Tool `bigquery_run_query` | `packages/agent/src/tools/catalog.ts` |
| Comparables con filtros inmobiliarios fijos | Tool wrapper `bigquery_lookup_local_comparables` | §3 de este doc |
| Señal de calendario antes del heartbeat | Prefetcher deterministico | `docs/heartbeat/deterministic-prefetchers.md` |
| Intake conversacional de caso operacional | Skill + tools `operational_case_*` | `docs/operational-cases/architecture.md` |

**Regla práctica:** si puedes escribir una función con tests unitarios y parámetros
estables, probablemente es tool o adapter. Si necesitas criterio, tono, secuencia
condicional o HITL de negocio, es skill.

---

## 5. Tool pública vs función interna

Otra distinción importante:

```text
bigquery_run_query = tool pública para el agente
executeBigQueryQuery = función interna de código
```

`bigquery_run_query` usa internamente `executeBigQueryQuery`.

Un wrapper como `bigquery_lookup_local_comparables` también puede usar
`executeBigQueryQuery` directamente sin exponer `bigquery_run_query` a la skill
que lo consume.

Eso permite:

```text
perform-comparable-analysis
  -> bigquery_lookup_local_comparables(filtros)
    -> executeBigQueryQuery(sql, params)
```

En este diseño, la skill no necesita permiso directo para `bigquery_run_query`.
El SQL se ejecuta, pero no lo escribe el LLM.

---

## 6. Ejemplo completo: BigQuery y comparables

### `company-data`

Uso: preguntas de negocio flexibles.

Ejemplos:

- "Cuántos leads llegaron este mes?"
- "Qué propiedades publicadas tienen más leads?"
- "Cuántas citas se agendaron por Gu?"

Arquitectura:

```text
company-data
  includes business-data-core
  uses bigquery_run_query
```

Por qué usa `bigquery_run_query`: las preguntas son variadas y requieren SQL
flexible.

### `perform-comparable-analysis`

Uso: paso específico dentro del caso operacional de opcionar una propiedad.

Objetivo: producir un análisis de comparables para una propiedad capturada.

Arquitectura recomendada:

```text
perform-comparable-analysis
  uses easybroker_search_listings
  uses easybroker_search_closed_deals
  uses bigquery_lookup_local_comparables
```

No debería usar SQL libre si ya existe un wrapper de comparables. El flujo
operacional necesita repetibilidad.

Contrato de filtros (runtime en `comparable-search-contract.ts`):

- Base: zona/colonia, operación, tipo EasyBroker canónico, banda de área.
- Residencial `strict` es asimétrica (−15% / +85%; ej. 146 m² → 124–270).
- Ladder automático: `expanded` → `wide` → `location_only` antes de HITL de
  expansión.
- Recámaras/baños/estacionamientos no son filtros duros de valuación.
- `easybroker_search_closed_deals` verifica `Estatus=Solo cerradas`; si no,
  falla con `filter_not_applied` y resultados vacíos.
- HITL comercial posterior: `price_approval` (no selección fila a fila).
- Spec ejecutable: `comparable-search-contract.selftest.ts`.

### `bigquery_lookup_local_comparables`

Uso: traer inventario/comparables internos desde BigQuery.

Versión actual recomendada:

- fuente: `firestore_properties.properties_light`;
- base de precio: `asking_price` / precio publicado;
- no asumir cierre real;
- usar tenant filter vía `users_light.organization_id`;
- parsear `price_display` best-effort mientras no exista precio numérico;
- no calcular precio/m² si no existe área confiable.

Output honesto:

```json
{
  "source": "bigquery_internal_inventory",
  "price_basis": "asking_price",
  "is_closed_price": false,
  "rows": [],
  "stats": {
    "count": 0,
    "p25_price": 0,
    "p50_price": 0,
    "p75_price": 0,
    "price_per_m2_available": false
  },
  "notes": "Inventario interno publicado; no representa cierres reales."
}
```

Cuando existan datos confiables de cierres reales, puede ampliarse con:

```json
{
  "price_basis": "closed_price",
  "is_closed_price": true
}
```

---

## 7. Dónde hacer cálculos

Regla general:

> Los cálculos repetibles deben vivir en código determinístico. El LLM debe
> interpretar, explicar y pedir decisión humana, no calcular percentiles a mano.

Ejemplos de cálculos que conviene hacer en tool/código:

- `price_per_m2 = price / area_m2`;
- conteos;
- mediana;
- percentiles P25/P50/P75;
- filtrado simple de outliers;
- límites de resultados;
- normalización de moneda, tipo de propiedad y operación.

La skill puede hacer la síntesis:

- explicar si hay pocos datos;
- comparar fuentes;
- señalar limitaciones;
- pedir decisión humana;
- preparar un rango recomendado sujeto a aprobación.

### Qué son P25, P50 y P75

Son percentiles:

- **P25**: el 25% de los comparables está por debajo de ese valor.
- **P50**: percentil 50, también llamado mediana.
- **P75**: el 75% de los comparables está por debajo de ese valor.

Ejemplo:

```text
P25 = $42,000/m²
P50 = $47,000/m²
P75 = $53,000/m²
```

Interpretación:

- P25: rango conservador.
- P50: punto medio del mercado comparable.
- P75: rango alto.

No son descuentos. Son posiciones dentro de la distribución.

---

## 8. Por qué no exponer tools técnicas en todos los skills

Puede parecer más flexible permitir siempre `bigquery_run_query`, pero en un
workflow operacional repetible eso puede ser contraproducente.

Si una skill como `perform-comparable-analysis` puede llamar tanto:

- `bigquery_lookup_local_comparables`, y
- `bigquery_run_query`,

el agente tiene dos caminos para lo mismo. Puede elegir el camino libre y saltar
el contrato de negocio.

Por eso la regla recomendada es:

- Skills analíticas flexibles (`company-data`) pueden usar tools técnicas.
- Skills operacionales repetibles (`perform-comparable-analysis`) deberían usar
  wrappers de negocio.
- Los wrappers de negocio pueden usar funciones internas compartidas.

---

## 9. Checklist para crear un wrapper de negocio

Antes de implementar una tool wrapper, responder:

1. **Qué problema de negocio resuelve?**
   - Ej. buscar comparables internos.
2. **Qué input de negocio recibe?**
   - Ej. zona, operación, tipo, rango de precio, rango de m².
3. **Qué fuente técnica encapsula?**
   - Ej. BigQuery, EasyBroker API, Supabase Storage.
4. **Qué reglas aplica siempre?**
   - Tenant filter, read-only, status publicado, operación venta/renta.
5. **Qué SQL/API usa internamente?**
   - Debe vivir en código o configuración controlada, no depender del LLM.
6. **Qué output estable devuelve?**
   - Rows normalizadas, stats, notas, `price_basis`, warnings.
7. **Qué limitaciones debe declarar?**
   - Ej. precio publicado no es precio de cierre.
8. **Qué tool técnica o adapter interno reutiliza?**
   - Ej. `executeBigQueryQuery`.
9. **Debe estar disponible al LLM directamente la tool técnica subyacente?**
   - Sólo si la skill necesita flexibilidad ad-hoc.

---

## 10. Regla práctica

Usar esta regla para decidir:

```text
Si la pregunta cambia cada vez -> skill + tool técnica.
Si el workflow debe ser repetible -> wrapper de negocio.
Si es conocimiento compartido -> skill core/reference.
Si es cálculo crítico -> código determinístico.
Si es juicio comercial -> LLM prepara, humano aprueba.
```

---

## 11. Patrón de prueba UI para readiness operacional

> Detalle completo: [`operational-cases/testing-framework.md`](operational-cases/testing-framework.md) (N0–N5).
> Catálogo de patrones: [`operational-cases/operational-case-reusable-patterns.md`](operational-cases/operational-case-reusable-patterns.md) + `apps/web/src/lib/operational-cases/test-patterns-catalog.ts`.
> Modelo paso / habilidad raíz: [`operational-cases/authoring-playbook.md`](operational-cases/authoring-playbook.md).
> Visión NL → propuesta implementable: [`operational-cases/use-case-authoring-vision.md`](operational-cases/use-case-authoring-vision.md).

La UI de Preparación operativa debe distinguir estos niveles de prueba (resumen):

1. **Tool individual (N1)**
   - Úsala para capacidades atómicas: búsquedas, dry-runs, validaciones o una
     integración sin dependencias de orden.
   - La acción vive en un bloque violeta y el resultado se muestra junto a la
     acción con color semántico.
   - Verde significa contrato cumplido; ámbar significa parcial, bloqueado,
     HITL pendiente o warning no fatal; rojo significa fallo o estado
     incompatible con el contrato.

2. **Escenario guiado A/B/C**
   - Úsalo cuando hay una secuencia causal: validar payload, ejecutar escritura
     controlada, simular respuesta externa o verificar el artefacto del caso.
   - Re-ejecutar un sub-paso debe invalidar sólo los resultados posteriores.
   - Los botones posteriores deben quedar deshabilitados hasta cumplir el
     prerequisito visible.
   - Ejemplos:
     - `request-property-documents` + `telegram_send_message_to_contact`: A
       valida mensaje, B envía solicitud controlada.
     - `extract-property-characteristics` + `telegram_send_message_to_contact`:
       A valida mensaje, B envía, C simula respuesta del propietario y verifica
       `property_data`.
     - `publish-listing-package` + EasyBroker: A crea borrador, B sube fotos al
       `listing_id` creado.

3. **Habilidad — N3**
   - Un tick con habilidad atómica forzada; contrato del escenario (`test_contract`).
   - Una prueba por habilidad declarada en el paso.
   - No reemplaza N2 ni el cierre del hito (N4).

4. **Paso — N4** *(v1 implementado)*
   - `POST /api/tool-readiness/run-step`; habilidad raíz; escenarios en `step-test-scenarios.ts`.
   - Valida cierre del `step_key` / ramas críticas; no es «encadenar todos los N3».
   - **Prerequisito:** todas las tools *readiness-visible* del paso probadas en N1 (misma regla que N3; UI índigo atenuada si bloqueado). Pills de paso/habilidad = último N3/N4; pills de tool = N1.
   - Runtime compartido con N3: dedup Telegram, notify interno, detalle en `skill-test-call-details.tsx` (ver catálogo `PATTERN_*`).

5. **Caso — N5** *(laboratorio controlado implementado)*
   - E2E del `case_type` en fixture aislado o caso conversacional con `mode: "agent_e2e"`, sesión E2E lab y panel **Prueba con agente**.
   - Pendiente: batería automatizada multi-tick en CI.
   - Ver [`testing-framework.md`](operational-cases/testing-framework.md) §8 y §13.

Reglas visuales:

- Violeta: acción, configuración, preview o estado interactivo.
- Verde: éxito confirmado.
- Ámbar: parcial, warning, política/HITL o prerequisito faltante.
- Rojo: fallo, excepción o contrato incumplido.
- Gris/neutro: metadata, pendiente o detalle técnico.

---

## 12. Skill Lab — readiness para skills sin caso operacional

Muchas capacidades **no** son casos operacionales: responden en un turno (o pocos
tool loops), no tienen `current_step`, cron ni esperas multi-día. Ejemplos:
`company-data`, borradores de follow-up, consultas puntuales, skills de referencia
usadas bajo demanda.

**No** deben pasar por Preparación operativa N0–N5. Usan un laboratorio más
ligero alineado al *Skill Development Cycle* (GStack/GBrain):

### 12.1 Cuándo aplica Skill Lab

| Señal | Skill Lab | Caso operacional (N0–N5) |
|-------|-----------|---------------------------|
| Sin `operational_cases` / `current_step` | ✓ | |
| Sin espera de humano externo multi-día | ✓ | |
| Estado persiste entre semanas | | ✓ |
| Cron / case_runner debe retomar solo | | ✓ |
| HITL inline en el turno | ambos | ambos |

### 12.2 Checklist Skill Lab (antes de activar)

1. **Discovery:** ¿existe skill global que ya cubre el 80%? ¿Es delta de `account_skills`?
2. **Rúbrica `skill-authoring`:** ningún ítem FAIL; WARN documentados.
3. **Evals:** ≥3 prompts positivos + ≥3 near-miss que el selector debe rechazar;
   las ejecuciones usan el modelo operativo resuelto, no el compilador fuerte.
4. **Tools:** N1 en integraciones de riesgo medio/alto si la skill las usa en producción.
5. **MECE:** ver §12.3 — sin solapamiento con skills vecinas.
6. **Evidencia:** 3–10 corridas reales o supervisadas documentadas (no solo
   teoría), ligadas a hash del skill y fingerprint del runtime.
7. **Activación:** humano explícito; nunca auto-activar desde Pattern Layer sin HITL.

La **Prueba con IA operativa** de Studio instrumenta este checklist: corre el
skill forzado con el modelo de producción dentro de un sandbox y puede usar un
juez independiente detrás de assertions deterministas. Un cambio de modelo,
rúbrica o skill vuelve la evidencia `stale`. Contrato:
[`workflow-studio/operational-ai-qualification.md`](workflow-studio/operational-ai-qualification.md).

### 12.3 MECE — ownership de skills

Principio del *Skill Development Cycle*: cada entidad, señal o procedimiento debe
tener **un dueño claro** en el registry — Mutually Exclusive, Collectively Exhaustive.

| Regla | Acción |
|-------|--------|
| Dos skills con el mismo «use when» | Fusionar, dividir dominio o marcar una como `reference` |
| Skill user-facing vs skill core | Core (`business-data-core`) no compite con user-facing (`company-data`) |
| Operational root vs atomic | La **raíz** orquesta por `current_step`; las **atómicas** no compiten con el selector global salvo N3 forzado |
| Pattern → Skill candidato | Revisión HITL antes de merge; ver Brain plan § Pattern Layer |
| Señales Brain (futuro) | Una entidad → una página compilada; señales no duplicadas entre skills |

Antes de crear una skill nueva, responder:

1. ¿Qué skill **deja de hacer** este trabajo si activo la nueva?
2. ¿El selector puede distinguirlas solo con `description`?
3. ¿Hay near-miss evals que prueben la frontera?

Detalle operacional de pasos vs atómicas: [`operational-cases/authoring-playbook.md`](operational-cases/authoring-playbook.md) §1.

### 12.4 Relación con quality bar

El quality bar instrumentable por forma de capacidad está en
[`operational-cases/testing-framework.md`](operational-cases/testing-framework.md) §13.
Skill Lab cubre la columna «skill sin esperas»; N0–N5 cubre casos operacionales.

