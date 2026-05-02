# File attachments and document skills

This document records the architecture needed before document-oriented skills
(`pdf`, `xlsx`, `docx`, `pptx`) can be exposed as reliable user-facing
capabilities.

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

For the web product, **Supabase Storage should be the source of truth** for
files the user uploads and files the assistant generates.

Recommended buckets:

| Bucket | Purpose | Visibility |
|--------|---------|------------|
| `user-files` | Original user uploads and connected external copies. | Private |
| `generated-files` | Files created or modified by the assistant. | Private |

Recommended path shape:

```text
users/<user_id>/uploads/<file_id>/<original_name>
users/<user_id>/generated/<file_id>/<filename>
```

Use short-lived signed URLs for downloads and previews. Avoid public buckets for
user documents.

---

## Metadata tables

The exact schema can evolve, but the product needs metadata separate from the
blob bytes.

### `user_files`

Tracks each stored file.

| Column | Purpose |
|--------|---------|
| `id` | Stable file ID used by tools and chat attachments. |
| `user_id` | Owner account. RLS key in V1. |
| `bucket` | Supabase Storage bucket. |
| `path` | Private storage path. |
| `original_name` | User-facing filename. |
| `mime_type` | Content type. |
| `size_bytes` | Quotas and UI. |
| `source` | `upload`, `generated`, `external_copy`, etc. |
| `status` | `ready`, `processing`, `failed`, `deleted`. |
| `created_at` / `updated_at` | Lifecycle tracking. |

### `message_attachments`

Associates files with chat messages and generated outputs.

| Column | Purpose |
|--------|---------|
| `id` | Attachment row ID. |
| `message_id` | Message owning/displaying the attachment. |
| `session_id` | Chat/session context. |
| `user_id` | Owner account for RLS and query speed. |
| `file_id` | Reference to `user_files.id`. |
| `role` | `input` or `output`. |
| `created_at` | UI ordering. |

If the app already stores chat upload metadata elsewhere, keep one source of
truth and map tools to that table instead of duplicating state.

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

Document skills should call purpose-built attachment tools. These tools should
be registered in the existing tool catalog/adapters, just like current calendar,
file, GitHub, and BigQuery tools.

### Read/inspect tools

| Tool | Risk | Purpose |
|------|------|---------|
| `list_attachments` | low | List files attached to the current message/session, with filenames, MIME types, sizes, and IDs. |
| `read_attachment_text` | low | Return extracted text/preview for a supported attachment. |
| `extract_pdf_text` | low/medium | Extract text from PDFs; OCR can be a separate later capability because it is slower and costlier. |
| `inspect_spreadsheet` | low | Return workbook sheets, headers, row counts, sample rows, and basic schema. |

### Create/save tools

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
mostly `shared` capabilities used by those skills.

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

Use closed backend tools or workers for file operations. Examples:

- XLSX: `exceljs`, `xlsx`, or a controlled Python worker with `openpyxl`.
- PDF: `pdf-parse`, `pdf-lib`, `poppler`, or OCR service for scanned docs.
- DOCX: `docx`, `mammoth`, or controlled Python `python-docx`.
- PPTX: `pptxgenjs` or controlled Python `python-pptx`.

Do not let a `SKILL.md` introduce arbitrary scripts that run inside the product
server. If a sandbox is later introduced, treat it as a separate V2+ project
with strict limits, ephemeral filesystem, network policy, CPU/memory/time caps,
and malware/PII considerations.

---

## Suggested build sequence

1. Confirm the existing web upload flow and where upload metadata currently
   lands.
2. Add or normalize `user_files` / `message_attachments` with RLS.
3. Store uploads in private Supabase Storage and render message attachment cards.
4. Add `list_attachments` and `read_attachment_text`.
5. Add `extract_pdf_text` and `inspect_spreadsheet`.
6. Introduce `pdf` and `xlsx` skills in read/analysis mode.
7. Add `save_generated_file`.
8. Add `create_spreadsheet`, then `create_document`, then
   `create_presentation`.
9. Introduce `docx`, `pptx`, and `brand-kit` workflows.
10. Add Settings UI indicators: available, staged, disabled, missing tool, or
    missing storage.

This sequence lets the product ship useful reading/analysis workflows before
more complex generation/editing workflows.
