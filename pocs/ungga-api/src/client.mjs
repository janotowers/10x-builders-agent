/**
 * Cliente minimal para validar el endpoint propuesto en `openapi.yaml`.
 *
 * UNGGA_INTERNAL_API_BASE = host solo, ej. https://app.ungga.com
 */
import "dotenv/config";
import { promises as fs } from "node:fs";

const base = (process.env.UNGGA_INTERNAL_API_BASE ?? "").trim();
const token = (process.env.UNGGA_INTERNAL_API_TOKEN ?? "").trim();
const fixturePath = process.argv[2];

if (!base || !token) {
  console.error(
    "Missing env: set UNGGA_INTERNAL_API_BASE and UNGGA_INTERNAL_API_TOKEN."
  );
  process.exit(1);
}
if (!fixturePath) {
  console.error("Usage: node src/client.mjs <path-to-fixture.json>");
  process.exit(1);
}

const raw = await fs.readFile(fixturePath, "utf8");
const body = JSON.parse(raw);

const t0 = Date.now();
let res;
try {
  res = await fetch(`${base.replace(/\/$/, "")}/v1/internal/listings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
  process.exit(2);
}
const duration_ms = Date.now() - t0;
const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = { raw: text };
}
console.log(
  JSON.stringify(
    { status: res.status, ok: res.ok, duration_ms, body: parsed },
    null,
    2
  )
);
