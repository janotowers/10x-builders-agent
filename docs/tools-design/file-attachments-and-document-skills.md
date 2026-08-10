# File attachments and document skills

> Status: generic read/inspection foundation implemented (2026-08-09);
> generation/editing tools remain future work.

This document records the current generic attachment architecture and the
remaining path for document-oriented skills (`pdf`, `xlsx`, `docx`, `pptx`).

The key principle is simple: **skills are playbooks; tools perform bounded file
operations**. Do not let skill folders run arbitrary scripts in V1/V1.5.

---

## Goals

- Support multi-tenant upload, inspection, transformation, and generation of
  business/personal documents.
- Keep uploaded and generated files private by default.
- Let document skills compose with business/personal/shared workflows without
  confusing them with the server workspace file tools.
- Provide a clear path for high-value skills such as `pdf`, `xlsx`, `docx`,
  `pptx`, and `brand-kit`.

---

## Non-goals for V1/V1.5

- No arbitrary code execution from `skills/*/scripts`.
- No direct access to arbitrary files on the user's local computer from the web
  app.
- No public permanent URLs for private user documents.
- No dynamic multi-skill routing just because files are involved; keep one
  dominant skill or explicit composites.

---

## Storage model

For the web product, **private Supabase Storage is the source of truth** for
bytes. Migration `00079_generic_attachments.sql` creates the private
`user-files` bucket (25 MB object limit), tenant-scoped metadata and
message/turn associations.

Current bucket:

| Bucket | Purpose | Visibility |
|--------|---------|------------|
| `user-files` | Uploads, external copies and future generated files. | Private; path/RLS scoped to tenant |

Current path shape:

```text
users/<user_id>/uploads/<file_id>/<original_name>
```

Use short-lived signed URLs for downloads and previews. Avoid public buckets for
user documents.

`scan_status=not_scanned` is an explicit “no scanner result” state, not a claim
that the object is malware-safe. Migration `00079` does not install scanning.

---

## Metadata tables

Metadata remains separate from blob bytes.

### `user_files`

Tracks each stored file.

| Column | Purpose |
|--------|---------|
| `id` | Stable file ID used by tools and chat attachments. |
| `user_id` | Owner account and RLS/path key. |
| `bucket` | Supabase Storage bucket. |
| `path` | Private storage path. |
| `original_name` | User-facing filename. |
| `mime_type` | Content type. |
| `size_bytes` | Quotas and UI. |
| `source` | `upload`, `generated`, `external_copy`, etc. |
| `status` | `pending_upload`, `uploaded`, `processing`, `ready`, `failed`, `deleted`. |
| `validation_status` | `pending`, `accepted`, `rejected`, `failed`. |
| `scan_status` | `not_scanned`, `pending`, `clean`, `flagged`, `failed`. |
| `sha256` | Integrity/envelope binding; not a public identifier. |
| `retention` / `expires_at` | Lifecycle and expiration policy. |
| `created_at` / `updated_at` | Lifecycle tracking. |

### `message_attachments`

Associates files with chat messages and generated outputs.

| Column | Purpose |
|--------|---------|
| `id` | Attachment row ID. |
| `message_id` | Optional message owning/displaying the attachment. |
| `session_id` | Chat/session context. |
| `user_id` | Owner account for RLS and query speed. |
| `file_id` | Reference to `user_files.id`. |
| `turn_id` | Optional runtime turn; at least message or turn is required. |
| `channel` | `web`, `telegram`, `email`, `api` or `system`. |
| `role` | `input` or `output`. |
| `ordinal` | Stable ordering within the message/turn. |
| `created_at` | UI ordering. |

Legacy case-document metadata remains the canonical evidence model for cases.
The generic turn attachment is promoted/copied into that pipeline only after
routing resolves a case; it is not silently converted into an `account_asset`.

---

## Local and external files

A browser-based web app cannot freely read files from a user's computer. The
assistant can only work with local files after one of these happens:

- the user uploads the file to the chat;
- the user connects a future local desktop connector;
- the user connects cloud storage such as Google Drive, OneDrive, or Dropbox;
- the assistant creates the file and stores it in `generated-files`.

The existing `read_file`, `write_file`, and `edit_file` tools are for the
server's configured workspace (`FILE_TOOLS_ROOT`). They are useful for dev/admin
tasks, but they are **not** the user-facing document layer for a multi-tenant
web product.

---

## Tool set

Document skills call purpose-built runtime attachment tools registered in the
existing tool catalog/adapters. They are read-only and bounded to the current
turn's resolved `runtime_input`.

### Implemented read/inspect tools

| Tool | Risk | Purpose |
|------|------|---------|
| `list_runtime_attachments` | low | List attachments resolved for the current execution. |
| `read_runtime_attachment` | low | Return a bounded slice of extracted text by attachment ID. |
| `search_runtime_attachments` | low | Search bounded extracted text across current attachments. |

The resolver verifies tenant ownership, `ready` + accepted validation state,
expiry, bucket/path, envelope fields and SHA-256 before exposing an attachment.
Unknown, cross-tenant, expired, non-ready or mismatched envelopes fail closed.

### Future create/save tools

| Tool | Risk | Purpose |
|------|------|---------|
| `save_generated_file` | medium | Store bytes/text output in `generated-files`, create metadata, return `file_id` and download metadata. |
| `create_spreadsheet` | medium | Generate `.xlsx` from structured rows/tables and save it. |
| `create_document` | medium | Generate `.docx` from structured sections and optional brand config. |
| `create_presentation` | medium/high | Generate `.pptx` from slide JSON and optional brand/theme config. |

### Tool metadata

Add metadata beyond business/personal/shared. Tools are lower-level capabilities,
so they need operational attributes:

- `risk`: low / medium / high.
- `requires_storage`: true for tools needing Supabase Storage.
- `requires_attachment`: true for tools needing an input file.
- `produces_attachment`: true for generated outputs.
- `category`: e.g. `files`, `documents`, `data`, `calendar`.
- `capability`: e.g. `read`, `extract`, `generate`, `modify`.

Skills still carry `scope: business | personal | shared`; document tools are
mostly `shared` capabilities used by those skills. A Web/Telegram invocation
channel is not an execution tool, and attaching a file does not imply an
outbound Telegram or Gmail effect.

---

## Skill activation rules

Document skills should be global skills, but staged until tools exist.

| Skill | Scope | Activate when |
|-------|-------|---------------|
| `pdf` | shared | User references a PDF upload or asks to extract/summarize/fill/split/merge PDFs and PDF tools exist. |
| `xlsx` | shared | User references spreadsheets/CSVs or asks for a generated spreadsheet and spreadsheet tools exist. |
| `docx` | shared | User asks to create/read/edit a Word document and document tools exist. |
| `pptx` | shared | User asks to create/read/edit slides/decks and presentation tools exist. |
| `brand-kit` | shared | User asks for branded output, visual consistency, tone/style application, or document/presentation styling. |

If a user references a local path from their own computer, the assistant should
ask for an upload or connected storage integration. It should not call
server-workspace file tools unless the path clearly refers to the server
workspace/admin context.

---

## Brand kit

`brand-kit` should be a **configured global skill**, not a custom skill body per
tenant in V1.5.

Suggested config source:

- `business_brain.brand.name`
- `business_brain.brand.colors`
- `business_brain.brand.fonts`
- `business_brain.brand.logo_file_id` or `logo_url`
- `business_brain.brand.voice`
- `business_brain.brand.dos`
- `business_brain.brand.donts`
- `business_brain.brand.examples`

Early implementation can store text values and optional logo URLs. Later UI can
upload logo/assets into Supabase Storage and reference the resulting `file_id`.

---

## Processing and sandbox policy

Current extraction uses closed backend libraries:

- XLSX: `exceljs`.
- PDF: `pdf-parse` (text PDFs; no OCR claim).
- DOCX: `mammoth`.
- PPTX: guarded ZIP/XML text extraction.
- TXT/Markdown/CSV/JSON/XML/HTML/YAML/log: bounded text extraction.

Do not let a `SKILL.md` introduce arbitrary scripts that run inside the product
server. ZIP-based Office files are inspected before inflation: path traversal,
entry count, per-entry size, total uncompressed size and compression ratio are
bounded. Extracted text is truncated to the runtime limit.

Web and Telegram now share the generic ingestion/resolution path for
conversational files. The current allowlist includes PDF, DOCX, PPTX, XLSX,
text/structured-text extensions and supported images. Images can be carried as
runtime attachments but this foundation does not claim OCR.

Studio qualification adds a narrower fail-closed sandbox: documentary
qualification injects private deterministic TXT/DOCX fixtures and autoexecutes
only the three runtime attachment read tools. External messages, Gmail,
publication, scheduling and other writes are denied.

Legacy `.xls` is intentionally rejected. The previously installed
`xlsx@0.18.5` parser has unresolved security advisories, and this repository
does not currently include a maintained, auditable `.xls` converter. Users
must convert `.xls` to `.xlsx`; `.xlsx` extraction uses `exceljs` after the
shared ZIP-container guards run.

---

## Rollout and remaining build sequence

1. Verify qualification migrations `00077`/`00078`, then apply
   **`00079_generic_attachments.sql`** before enabling generic uploads.
2. Validate private bucket/RLS/path ownership and lifecycle transitions; do not
   advertise malware scanning.
3. Run `test:attachments`, Studio foundation/selftests and migration validation.
4. Canary Web ingestion, then Telegram, across the supported matrix and all
   rejection paths. Explicitly test `.xls` → `legacy_xls_parser_unsafe`.
5. Canary documentary Studio qualification and assert only the three read tools
   execute.
6. Wire tenant flags and structured events before external expansion. Canonical
   metrics, alert conditions and rollback:
   [`../workflow-studio/rollout-and-observability.md`](../workflow-studio/rollout-and-observability.md).
7. After the read foundation is stable, add `save_generated_file`,
   `create_spreadsheet`, `create_document` and `create_presentation` as separate
   reviewed capabilities; generation is not implied by current read support.
8. Add Settings indicators and later OCR/scanning only with explicit contracts,
   limits and observability.

Rollback disables the canary surface or reverts the deployment while retaining
`00079` metadata/objects for audit. Do not down-migrate, delete tenant files or
re-enable `.xls` as a fallback.
