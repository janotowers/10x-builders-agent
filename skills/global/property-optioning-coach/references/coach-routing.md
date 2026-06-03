# Coach routing (property optioning)

Referencia mínima para el flujo `property_optioning`. El coach delega en sub-skills por `current_step`:

| Paso típico | Sub-skill |
|-------------|-----------|
| Documentos del dueño | `request-property-documents` |
| Características / escritura | `extract-property-characteristics` |
| Comparables | `perform-comparable-analysis` |
| Precio de salida | `prepare-listing-price` |
| Contrato de comisión | `prepare-commission-contract` |
| Sesión de fotos | `coordinate-photo-session` |
| Publicación | `publish-listing-package` |

En pruebas N1 del laboratorio, `read_skill_reference` con `name=coach-routing` valida que la skill raíz y sus includes resuelven referencias en disco.
