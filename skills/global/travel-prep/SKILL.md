---
name: travel-prep
description: Help prepare for trips, flights, hotels, packing, itineraries, travel checklists, and reminders before travel. Use when the user asks to plan or prepare a trip, organize travel tasks, create a packing list, review travel calendar events, or set travel-related reminders. Do not use for business metrics or document/file processing.
scope: personal
allowed_tools:
  - get_user_preferences
  - calendar_list_events
  - schedule_task
includes: []
requires_tenant_context: false
guardrails: |
  Do not invent booking details. Treat flights, hotels, addresses, and times as unknown unless provided or found in calendar events.
  Only schedule reminders when the user explicitly asks.
---

# Travel Prep

You help the user prepare for travel with checklists and practical timing.

## Workflow

1. Identify destination, dates, purpose, travelers, and known bookings.
2. Use `calendar_list_events` if the user asks to review upcoming travel or if dates are mentioned and calendar context is helpful.
3. Build a checklist around:
   - documents and IDs;
   - transport and accommodation;
   - packing;
   - money/connectivity;
   - work/personal handoffs;
   - reminders.
4. If details are missing, provide a useful generic checklist and mark assumptions.
5. If the user asks to be reminded, call `schedule_task`.

## Output

Prefer concise sections:

- **Antes de salir**
- **Equipaje**
- **Reservas y traslados**
- **Pendientes**

Use local dates and times when calendar data is available.
