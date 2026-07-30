// Triage de la ventana advisory (S1.7-1): agrupa los eventos
// transition_divergence / transition_rejected por proposer+site+from→to+causa
// y los clasifica para decidir el flip a enforcing.
//
// Uso: npm run triage:divergences --workspace @agents/web [-- --days 7]
// Lee credenciales de apps/web/.env.local.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, "..", ".env.local");

function loadEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type Bucket = {
  kind: string;
  proposer: string;
  site: string;
  fromStep: string;
  toStep: string;
  cause: string;
  count: number;
  caseIds: Set<string>;
  firstSeen: string;
  lastSeen: string;
  classification: string;
};

/**
 * Clasificación automática preliminar (a/b/c/d del plan). Es una guía: la
 * decisión final del triage es humana.
 */
function classify(cause: string, fromStep: string, toStep: string): string {
  if (cause.includes("external_response_exists")) {
    return "(b) mismatch conocido D4 — rama internal_user vs guard external_response";
  }
  if (cause === "undeclared_transition") {
    return `(c) transición no declarada en el grafo v1 (${fromStep}→${toStep}) — evaluar si declararla en v2 o si es un salto indebido`;
  }
  if (cause.includes("defensible_comparables_sample")) {
    return "(b) avance de comparables con muestra <3 — revisar si el caso era legítimo";
  }
  if (cause.includes("publication_keys_protected")) {
    return "(b) intento de escribir claves de publicación protegidas";
  }
  if (cause.includes("step_order_no_regression")) {
    return "(b) regresión de paso propuesta";
  }
  if (cause.includes("completion_pairing")) {
    return "(b) published/completed sin parear";
  }
  return "(a?) causa no mapeada — revisar transformer/grafo";
}

async function main() {
  const env = loadEnv(ENV_PATH);
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("triage-divergences: sin credenciales Supabase (.env.local).");
    return;
  }
  const args = process.argv.slice(2);
  const daysArg = args.indexOf("--days");
  const days = daysArg >= 0 ? Number(args[daysArg + 1]) || 7 : 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const db = createClient(url, key);
  const { data, error } = await db
    .from("operational_case_events")
    .select("case_id, created_at, payload_jsonb")
    .eq("event_type", "state_changed")
    .filter(
      "payload_jsonb->>kind",
      "in",
      '("transition_divergence","transition_rejected")'
    )
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(5000);
  if (error) throw error;

  const events = data ?? [];
  console.log(
    `Ventana advisory — últimos ${days} día(s) (desde ${since}): ${events.length} evento(s).`
  );
  if (events.length === 0) {
    console.log(
      "Sin divergencias registradas. Si hubo transiciones reales en la ventana, es señal verde para el flip; si no hubo tráfico, la ventana aún no es representativa."
    );
    return;
  }

  const buckets = new Map<string, Bucket>();
  for (const event of events) {
    const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : {};
    const failedGuards = Array.isArray(payload.failed_guards)
      ? payload.failed_guards
          .map((g) => (isRecord(g) ? String(g.guard ?? "?") : String(g)))
          .join("+")
      : "";
    const cause = failedGuards || String(payload.reason ?? "sin_causa");
    const kind = String(payload.kind ?? "?");
    const proposer = String(payload.proposer ?? "?");
    const site = String(payload.site ?? "?");
    const fromStep = String(payload.from_step ?? "(none)");
    const toStep = String(payload.to_step ?? "(sin cambio de paso)");
    const bucketKey = [kind, proposer, site, fromStep, toStep, cause].join("|");
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.count += 1;
      existing.caseIds.add(event.case_id as string);
      existing.lastSeen = event.created_at as string;
    } else {
      buckets.set(bucketKey, {
        kind,
        proposer,
        site,
        fromStep,
        toStep,
        cause,
        count: 1,
        caseIds: new Set([event.case_id as string]),
        firstSeen: event.created_at as string,
        lastSeen: event.created_at as string,
        classification: classify(cause, fromStep, toStep),
      });
    }
  }

  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  for (const bucket of sorted) {
    // Los sites lab_* provienen de corridas del laboratorio: cuentan para la
    // paridad lab/prod pero no bloquean el flip de producción por sí solos.
    const labTag = bucket.site.startsWith("lab_") ? " · LAB" : "";
    console.log(
      `\n[${bucket.count}x, ${bucket.caseIds.size} caso(s)] ${bucket.kind} · proposer=${bucket.proposer} · site=${bucket.site}${labTag}`
    );
    console.log(`  ${bucket.fromStep} → ${bucket.toStep} · causa: ${bucket.cause}`);
    console.log(`  triage: ${bucket.classification}`);
    console.log(
      `  visto: ${bucket.firstSeen} … ${bucket.lastSeen} · casos: ${[...bucket.caseIds].slice(0, 3).join(", ")}${bucket.caseIds.size > 3 ? ", …" : ""}`
    );
  }

  console.log(
    `\nCriterio de flip (S1.7): cada grupo debe quedar en cero o explicado — (a) bug del transformer/grafo → corregir y republicar v2; (b) mismatch real prose/guard → decidir la regla; (c) transición faltante → declararla; (d) ruido de instrumentación → verificar que el wrapper ya lo graba.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
