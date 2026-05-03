# Glossary — Ungga Business Data

## Core Terms

- Inmobiliaria: organization identified by `users_light.organization_id`.
- Asesor: user/account inside an organization.
- Gu: AI coworker WhatsApp number; state is in `gu_numbers_light`.
- Lead: interested buyer/renter/seller in `mongo_data.leads_light`.
- Propiedad: inventory record in `properties_light`.

## Messages

- Mensaje del lead / humano: `LOWER(TRIM(author)) = 'user'`.
- Mensaje de Gu: `LOWER(TRIM(author)) = 'gu'`.
- Lead atendido: lead/conversation with at least one `author = 'user'` message in the relevant period.
- Lead que interactuó: lead/conversation with more than one `author = 'user'` message in the relevant period.

## Funnel

Canonical funnel order:

1. Lead created.
2. Attended by Gu / conversation received.
3. Interacted.
4. Appointment / visit request.
5. Deal / opportunity.

## Property Terms

- Publicada: `ad_status = 'Publicado'`.
- Monetización: `monetization_type_display` such as `Venta`, `Renta`, `Preventa`.
- Tipo: `house_type` such as `Casa`, `Departamento`, `Oficina`, `Terreno`.

## Drafting Context

For personalized follow-up drafts, useful context includes:

- Lead: name, portal, last_interaction, dialog_state, last_message.
- Property: address/city, house_type, monetization_type_display, price_display, public_url.
- Messages: recent `author`, `message_time`, `message` entries.

If only identity fields are available, the data is not sufficient to claim a personalized draft.
