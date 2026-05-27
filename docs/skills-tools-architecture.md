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
- `coordinate-photo-session`;
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
- `telegram_send_message_to_contact`.

Las tools tienen:

- `id` / `name`;
- descripción;
- riesgo (`low`, `medium`, `high`);
- integración requerida;
- schema de parámetros;
- implementación runtime.

La skill decide **cuándo** usar una tool. La tool define **cómo** se ejecuta la
capacidad.

---

## 3. Tool técnica vs wrapper de negocio

No todas las tools están al mismo nivel.

### Tool técnica

Una tool técnica expone una capacidad genérica.

Ejemplo: `bigquery_run_query`.

Esta tool no sabe qué es un comparable inmobiliario. Sólo sabe ejecutar una
consulta SQL read-only contra BigQuery.

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

4. **Paso — N4** *(pendiente de producto)*
   - Habilidad raíz; valida cierre del `step_key` / orquestación entre varias habilidades.
   - No es «encadenar todos los N3».

5. **Caso — N5** *(parcial / futuro)*
   - E2E del `case_type` completo en caso de prueba aislado.

Reglas visuales:

- Violeta: acción, configuración, preview o estado interactivo.
- Verde: éxito confirmado.
- Ámbar: parcial, warning, política/HITL o prerequisito faltante.
- Rojo: fallo, excepción o contrato incumplido.
- Gris/neutro: metadata, pendiente o detalle técnico.

