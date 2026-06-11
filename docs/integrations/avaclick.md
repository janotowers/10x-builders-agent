# Avaclick Integration Notes (Minimums and Runtime Behavior)

Este documento resume el contrato observado de Avaclick para `get_avaclick_valuation`
con pruebas directas de payload (no solo desde schema local).

## Hallazgos Operativos

- Avaclick puede responder `HTTP 200` con `retornar.Success=false`.
- En algunos errores de validación, `retornarerror.Mensaje` llega vacío.
- Si `Latitud/Longitud` vienen como `0` o faltan, hay fallos lentos o timeout.
- El resultado `ok=true` incluye valores de venta/renta y `pdf_url`; no es avalúo legal/fiscal.

## Mínimo Funcional Observado (condo_house, fixture Metepec)

Para una ejecución consistente se observaron como mínimos:

- `Cliente` completo (`NombreCliente`, `Correo`, `Telefono`).
- `Inmueble.Latitud` y `Inmueble.Longitud` válidos (no `0`).
- `Inmueble.Calle`.
- `Inmueble.TipoInmueble`.
- `Inmueble.Terreno` para `house` / `condo_house`.
- `Inmueble.Construccion`.
- `Caracteristicas` con al menos un campo (por ejemplo `Edad` o `Conservacion`).

## Campos Observados como Opcionales (fixture probado)

- `Inmueble.CP`
- `Inmueble.NumeroExterior`
- `Amenidades` (objeto ausente o arrays vacíos)

## Decisiones de Implementación

1. No pedir `latitude`/`longitude` al usuario como requisito UX.
2. Resolver coordenadas server-side con `geocode_property_address`.
3. `get_avaclick_valuation` debe devolver error estructurado con
   `missing_required_fields` cuando no se cumplan mínimos, en vez de
   enviar payload incompleto al proveedor.
4. En `perform-comparable-analysis`, Avaclick es fuente complementaria:
   si faltan mínimos, se registra warning y se continúa con EasyBroker/BigQuery.

## Credenciales y Config

- Preferir credenciales por cuenta (`provider=avaclick`) en Ajustes.
- Fallback por entorno (local/dev):
  - `AVACLICK_API_URL`
  - `AVACLICK_COMPANY_NAME`
  - `AVACLICK_EMAIL`
  - `AVACLICK_PASSWORD`
- Catálogos: `AVACLICK_CATALOGS_DIR` (default: `pocs/avaclick`).

## Nota de Riesgo Comercial

La valuación es opinión digital; no sustituye avalúo legal, fiscal, bancario o judicial.
