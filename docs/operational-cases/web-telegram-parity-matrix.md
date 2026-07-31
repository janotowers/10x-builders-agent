# Matriz de paridad web ↔ Telegram (`property_optioning`)

Checklist manual / E2E para validar journeys equivalentes del **asesor interno**.
Diferencias permitidas: solo transporte/UI del canal.

| Paso / decisión | Web | Telegram | Handler / contrato |
|---|---|---|---|
| Intake + destino docs | chat + texto | webhook + texto | orchestrators compartidos |
| Upload docs/fotos + «listo» / Terminé de subir | attach + botón | media + botón | `upload-batch-completion` |
| `property_data_review` (asesor) | Confirmar / Ajustar | mismos botones | `property-data-review` |
| Comparables expansion | 1/2/3 chips | `comp_*` keyboard | `comparables-expansion-decision` |
| Precio | Aprobar / Ajustar | mismos | `price-approval` |
| Datos contractuales | Sí/No si 1 bool | mismos | `contract-data-review` |
| Contrato review | Email / Subir corregido | mismos + DOCX | `contract-review` |
| Titularidad (excepción) | Evidencia externa / Yo subo / Excepción+motivo | mismos | `titularidad-review` |
| Fotos request | Terminé de subir | mismo | `ensure-photos-upload-request` |
| Descripción | Aprobar / Pedir cambios | mismos + `.txt` | `listing-description-review` |
| Destino EB/Ungga | Publicar / Omitir / Pausar | mismos | `publish-destination-approval` |
| Publication review | Aprobar/Detener (variantes) | mismos | `publication-review` |
| Resumen final | mirror + portada | push + OG preview | `listing_published_summary` |
| Post-turno invariants | `web_chat_post_agent` | `telegram_webhook_post_agent` | `operational-case-post-turn` |
| Recovery `continua` en contrato/publicación | sí | sí | `maybeRecover*` |

**Fuera de scope de paridad interna:** chat del contacto externo (Telegram hoy).

Selftests de contrato: `npm run test:attachment-hitl --workspace @agents/web` (incluye `hitl-action-contract.selftest.ts`).
