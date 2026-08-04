/**
 * Selftests del plano de impacto (Slice 3.1).
 *
 * Corren contra un fake in-memory del cliente supabase que reproduce la
 * semántica que los módulos necesitan: filtros (eq/in/is), unique
 * constraints (account_asset_versions(account_asset_id, version_number),
 * artifact_inputs PK, account_assets(user_id, asset_key) vía upsert) y los
 * triggers de inmutabilidad: case_facts solo permite superseded_by
 * null→valor; account_asset_versions solo content_hash null→valor.
 *
 * Cobertura exigida por el plan: el insert de un hecho reemplaza al vigente
 * vía superseded_by y NUNCA actualiza en sitio; artefactos con aristas
 * declaradas (incl. account_asset) y lookup inverso; supersesión y CAS de
 * estado de artefactos; cadena de aprobaciones grant → suspend → re-approve;
 * reemplazo de asset crea versión nueva sin reescribir la anterior.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { DbClient } from "../client";
import type {
  AccountAsset,
  AccountAssetVersion,
  CaseApproval,
  CaseArtifact,
  CaseFact,
} from "@agents/types";
import {
  getCurrentCaseFacts,
  insertCaseFact,
  listCaseFacts,
} from "./case-facts";
import {
  createCaseArtifact,
  getCaseArtifactById,
  listArtifactInputs,
  listArtifactsDependingOnInput,
  listCaseArtifactsForCase,
  updateCaseArtifactStatus,
} from "./case-artifacts";
import {
  getLatestCaseApproval,
  insertCaseApproval,
  listCaseApprovalsForCase,
  suspendCaseApproval,
} from "./case-approvals";
import {
  fillAccountAssetVersionContentHash,
  getLatestAccountAssetVersion,
  listAccountAssetVersions,
  upsertAccountAsset,
} from "./account-assets";

// ============================================================
// Fake in-memory
// ============================================================

type Row = Record<string, unknown>;

interface FakeStore {
  case_facts: Row[];
  case_artifacts: Row[];
  artifact_inputs: Row[];
  case_approvals: Row[];
  account_assets: Row[];
  account_asset_versions: Row[];
}

// Timestamps monotónicos: dos inserts en el mismo ms conservan orden total.
let tick = Date.parse("2026-08-04T12:00:00.000Z");
function nextIso(): string {
  tick += 1;
  return new Date(tick).toISOString();
}

const TABLE_DEFAULTS: Record<keyof FakeStore, () => Row> = {
  case_facts: () => ({
    source_ref: null,
    confidence: null,
    superseded_by: null,
    recorded_at: nextIso(),
  }),
  case_artifacts: () => ({
    status: "current",
    produced_by_work_item_id: null,
    version: 1,
    updated_at: nextIso(),
  }),
  artifact_inputs: () => ({}),
  case_approvals: () => ({
    decided_by: null,
    decided_at: nextIso(),
    superseded_by: null,
    rationale: null,
  }),
  account_assets: () => ({
    description: null,
    content_type: null,
    file_size_bytes: null,
    source_tool_id: null,
    case_type_id: null,
    metadata_jsonb: {},
    content_hash: null,
    updated_at: nextIso(),
  }),
  account_asset_versions: () => ({
    content_hash: null,
    content_type: null,
    file_size_bytes: null,
  }),
};

function uniqueViolation(store: FakeStore, table: keyof FakeStore, row: Row): boolean {
  if (table === "account_asset_versions") {
    return store.account_asset_versions.some(
      (r) =>
        r.account_asset_id === row.account_asset_id &&
        r.version_number === row.version_number
    );
  }
  if (table === "artifact_inputs") {
    return store.artifact_inputs.some(
      (r) =>
        r.artifact_id === row.artifact_id &&
        r.input_kind === row.input_kind &&
        r.input_id === row.input_id
    );
  }
  return false;
}

/** Emula los triggers de inmutabilidad de 00070. Lanza si la mutación es ilegal. */
function enforceImmutability(table: keyof FakeStore, oldRow: Row, patch: Row): void {
  if (table === "case_facts") {
    for (const [col, val] of Object.entries(patch)) {
      if (col === "superseded_by") {
        if (oldRow.superseded_by !== null || val == null) {
          throw new Error("case_facts: superseded_by only null→value");
        }
        continue;
      }
      if (oldRow[col] !== val) {
        throw new Error(`case_facts rows are immutable (attempted ${col})`);
      }
    }
  }
  if (table === "account_asset_versions") {
    for (const [col, val] of Object.entries(patch)) {
      if (col === "content_hash") {
        if (oldRow.content_hash !== null || val == null) {
          throw new Error("account_asset_versions: content_hash only null→value");
        }
        continue;
      }
      if (oldRow[col] !== val) {
        throw new Error(`account_asset_versions rows are immutable (attempted ${col})`);
      }
    }
  }
}

interface FakeDb {
  client: DbClient;
  store: FakeStore;
}

function makeFakeDb(): FakeDb {
  const store: FakeStore = {
    case_facts: [],
    case_artifacts: [],
    artifact_inputs: [],
    case_approvals: [],
    account_assets: [],
    account_asset_versions: [],
  };

  function from(table: keyof FakeStore) {
    type Filter =
      | { kind: "eq"; col: string; val: unknown }
      | { kind: "in"; col: string; vals: unknown[] }
      | { kind: "is"; col: string; val: unknown };
    const state = {
      op: "select" as "select" | "insert" | "update" | "upsert",
      rows: [] as Row[],
      patch: {} as Row,
      onConflict: null as string[] | null,
      filters: [] as Filter[],
      orders: [] as Array<{ col: string; ascending: boolean }>,
      limitN: null as number | null,
      mode: "many" as "many" | "single" | "maybeSingle",
    };

    function matches(row: Row): boolean {
      return state.filters.every((f) => {
        if (f.kind === "eq") return row[f.col] === f.val;
        if (f.kind === "in") return f.vals.includes(row[f.col]);
        return row[f.col] === f.val; // is: igualdad estricta (null incluido)
      });
    }

    function execute(): {
      data: unknown;
      error: { code?: string; message: string } | null;
    } {
      if (state.op === "insert" || state.op === "upsert") {
        const results: Row[] = [];
        for (const raw of state.rows) {
          if (state.op === "upsert" && state.onConflict) {
            const existing = store[table].find((r) =>
              state.onConflict!.every((col) => r[col] === raw[col])
            );
            if (existing) {
              enforceImmutability(table, existing, raw);
              Object.assign(existing, raw);
              results.push(existing);
              continue;
            }
          }
          if (uniqueViolation(store, table, raw)) {
            return {
              data: null,
              error: { code: "23505", message: `duplicate key on ${table}` },
            };
          }
          const row: Row = {
            id: randomUUID(),
            created_at: nextIso(),
            ...TABLE_DEFAULTS[table](),
            ...raw,
          };
          store[table].push(row);
          results.push(row);
        }
        return finish(results);
      }
      if (state.op === "update") {
        const affected = store[table].filter(matches);
        for (const row of affected) {
          enforceImmutability(table, row, state.patch);
          Object.assign(row, state.patch);
        }
        return finish(affected);
      }
      let rows = store[table].filter(matches);
      if (state.orders.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const o of state.orders) {
            const av = a[o.col] as string | number | null;
            const bv = b[o.col] as string | number | null;
            if (av === bv) continue;
            if (av == null) return o.ascending ? -1 : 1;
            if (bv == null) return o.ascending ? 1 : -1;
            const cmp = av < bv ? -1 : 1;
            return o.ascending ? cmp : -cmp;
          }
          return 0;
        });
      }
      if (state.limitN != null) rows = rows.slice(0, state.limitN);
      return finish(rows);
    }

    function finish(rows: Row[]): {
      data: unknown;
      error: { code?: string; message: string } | null;
    } {
      const copies = rows.map((r) => ({ ...r }));
      if (state.mode === "single") {
        if (copies.length !== 1) {
          return {
            data: null,
            error: { message: `expected 1 row, got ${copies.length}` },
          };
        }
        return { data: copies[0], error: null };
      }
      if (state.mode === "maybeSingle") {
        if (copies.length > 1) {
          return {
            data: null,
            error: { message: `expected <=1 row, got ${copies.length}` },
          };
        }
        return { data: copies[0] ?? null, error: null };
      }
      return { data: copies, error: null };
    }

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (rows: Row | Row[]) => {
        state.op = "insert";
        state.rows = Array.isArray(rows) ? rows : [rows];
        return builder;
      },
      upsert: (rows: Row | Row[], opts?: { onConflict?: string }) => {
        state.op = "upsert";
        state.rows = Array.isArray(rows) ? rows : [rows];
        state.onConflict = opts?.onConflict
          ? opts.onConflict.split(",").map((c) => c.trim())
          : null;
        return builder;
      },
      update: (patch: Row) => {
        state.op = "update";
        state.patch = patch;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        state.filters.push({ kind: "eq", col, val });
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        state.filters.push({ kind: "in", col, vals });
        return builder;
      },
      is: (col: string, val: unknown) => {
        state.filters.push({ kind: "is", col, val });
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        state.orders.push({ col, ascending: opts?.ascending ?? true });
        return builder;
      },
      limit: (n: number) => {
        state.limitN = n;
        return builder;
      },
      single: () => {
        state.mode = "single";
        return builder;
      },
      maybeSingle: () => {
        state.mode = "maybeSingle";
        return builder;
      },
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown
      ) => {
        try {
          return Promise.resolve(execute()).then(resolve, reject);
        } catch (err) {
          return Promise.reject(err).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  return { client: { from } as unknown as DbClient, store };
}

const USER = "user-1";
const CASE = "case-1";

// ============================================================
// Tests: case_facts
// ============================================================

async function testFactInsertSupersedesPrior(): Promise<void> {
  const fake = makeFakeDb();
  const first = await insertCaseFact(fake.client, {
    userId: USER,
    caseId: CASE,
    factKey: "property.bedrooms",
    value: 2,
    sourceKind: "user",
  });
  assert.equal(first.superseded, null, "first fact supersedes nothing");
  assert.equal(first.fact.superseded_by, null);

  const second = await insertCaseFact(fake.client, {
    userId: USER,
    caseId: CASE,
    factKey: "property.bedrooms",
    value: 3,
    sourceKind: "external_contact",
    sourceRef: "msg-42",
  });
  assert.ok(second.superseded, "second insert must supersede the first");
  assert.equal(second.superseded!.id, first.fact.id);
  assert.equal(second.superseded!.superseded_by, second.fact.id);

  // La fila vieja conserva su valor: historia estructural, no convención.
  const oldRow = fake.store.case_facts.find((r) => r.id === first.fact.id)!;
  assert.equal(oldRow.value_jsonb, 2, "old value must remain intact");
  assert.equal(oldRow.superseded_by, second.fact.id);

  // Hecho de otra clave no se ve afectado.
  await insertCaseFact(fake.client, {
    userId: USER,
    caseId: CASE,
    factKey: "property.area_construida_m2",
    value: 165,
    sourceKind: "document",
  });
  const current = await getCurrentCaseFacts(fake.client, USER, CASE);
  assert.equal(current.size, 2);
  assert.equal(current.get("property.bedrooms")!.value_jsonb, 3);
  assert.equal(current.get("property.area_construida_m2")!.value_jsonb, 165);

  const history = await listCaseFacts(fake.client, USER, CASE, {
    factKey: "property.bedrooms",
    includeSuperseded: true,
  });
  assert.equal(history.length, 2, "full correction history preserved");
  console.log("ok - fact insert supersedes prior, history intact");
}

async function testFactRowsAreImmutable(): Promise<void> {
  const fake = makeFakeDb();
  const { fact } = await insertCaseFact(fake.client, {
    userId: USER,
    caseId: CASE,
    factKey: "property.location",
    value: "Col. Roma",
    sourceKind: "user",
  });
  // Un update de valor en sitio debe rebotar contra el trigger.
  await assert.rejects(
    async () => {
      const { error } = await fake.client
        .from("case_facts")
        .update({ value_jsonb: "Col. Condesa" })
        .eq("id", fact.id)
        .select("*");
      if (error) throw error;
    },
    /immutable/,
    "in-place value update must be rejected"
  );
  console.log("ok - fact rows immutable except superseded_by");
}

// ============================================================
// Tests: case_artifacts + artifact_inputs
// ============================================================

async function testArtifactEdgesAndReverseLookup(): Promise<void> {
  const fake = makeFakeDb();
  const { fact: bedrooms } = await insertCaseFact(fake.client, {
    userId: USER,
    caseId: CASE,
    factKey: "property.bedrooms",
    value: 3,
    sourceKind: "user",
  });
  const templateVersionId = randomUUID(); // account_asset_versions.id consumido

  const listing = await createCaseArtifact(fake.client, {
    userId: USER,
    caseId: CASE,
    artifactType: "listing_description",
    content: { text: "Amplia casa de 3 recámaras…" },
    inputHash: "hash-listing-1",
    inputs: [
      { kind: "fact", id: bedrooms.id },
      { kind: "account_asset", id: templateVersionId },
    ],
  });
  // Artefacto SIN aristas: jamás debe aparecer en el lookup inverso
  // (guardia contra sobre-invalidación, exit check de 3.2-5).
  const valuation = await createCaseArtifact(fake.client, {
    userId: USER,
    caseId: CASE,
    artifactType: "valuation",
    content: { amount: 5_200_000 },
    inputHash: "hash-valuation-1",
    inputs: [],
  });

  const edges = await listArtifactInputs(fake.client, USER, listing.id);
  assert.equal(edges.length, 2);
  assert.ok(edges.some((e) => e.input_kind === "account_asset"));

  const dependents = await listArtifactsDependingOnInput(
    fake.client,
    USER,
    bedrooms.id
  );
  assert.equal(dependents.length, 1);
  assert.equal(dependents[0].id, listing.id);
  assert.ok(
    !dependents.some((a) => a.id === valuation.id),
    "edge-less artifact never appears as dependent"
  );

  const byAsset = await listArtifactsDependingOnInput(
    fake.client,
    USER,
    templateVersionId,
    { inputKind: "account_asset" }
  );
  assert.equal(byAsset.length, 1);
  console.log("ok - artifact edges (incl. account_asset) + reverse lookup");
}

async function testArtifactStatusCasAndSupersede(): Promise<void> {
  const fake = makeFakeDb();
  const artifact = await createCaseArtifact(fake.client, {
    userId: USER,
    caseId: CASE,
    artifactType: "listing_description",
    content: { text: "v1" },
    inputHash: "hash-1",
    inputs: [],
  });

  const staled = await updateCaseArtifactStatus(fake.client, {
    userId: USER,
    artifactId: artifact.id,
    status: "stale",
    expectedVersion: artifact.version,
  });
  assert.ok(staled);
  assert.equal(staled!.status, "stale");
  assert.equal(staled!.version, artifact.version + 1);

  // CAS con versión vieja pierde y devuelve null.
  const lost = await updateCaseArtifactStatus(fake.client, {
    userId: USER,
    artifactId: artifact.id,
    status: "invalid",
    expectedVersion: artifact.version,
  });
  assert.equal(lost, null, "stale CAS must lose");

  const replacement = await createCaseArtifact(fake.client, {
    userId: USER,
    caseId: CASE,
    artifactType: "listing_description",
    content: { text: "v2" },
    inputHash: "hash-2",
    inputs: [],
    supersedesArtifactId: artifact.id,
  });
  const old = await getCaseArtifactById(fake.client, USER, artifact.id);
  assert.equal(old!.status, "superseded");
  const currentOnly = await listCaseArtifactsForCase(fake.client, USER, CASE, {
    statuses: ["current"],
  });
  assert.equal(currentOnly.length, 1);
  assert.equal(currentOnly[0].id, replacement.id);
  console.log("ok - artifact status CAS + supersede");
}

// ============================================================
// Tests: case_approvals
// ============================================================

async function testApprovalGrantSuspendReapprove(): Promise<void> {
  const fake = makeFakeDb();
  const { approval: granted } = await insertCaseApproval(fake.client, {
    userId: USER,
    caseId: CASE,
    approvalKind: "price",
    decision: "approved",
    evidenceHash: "evidence-1",
    evidenceSnapshot: { salida: 5_200_000 },
    decidedBy: USER,
  });
  assert.equal(granted.decision, "approved");

  // Suspensión mecánica (3.2): approved → suspended; idempotente.
  const suspended = await suspendCaseApproval(fake.client, {
    userId: USER,
    approvalId: granted.id,
  });
  assert.equal(suspended.suspended, true);
  assert.equal(suspended.approval!.decision, "suspended");
  const again = await suspendCaseApproval(fake.client, {
    userId: USER,
    approvalId: granted.id,
  });
  assert.equal(again.suspended, false, "second suspension is a no-op");
  assert.equal(again.approval!.decision, "suspended");

  // Re-aprobación humana (3.3): fila NUEVA que reemplaza, nunca update.
  const { approval: regrant, superseded } = await insertCaseApproval(fake.client, {
    userId: USER,
    caseId: CASE,
    approvalKind: "price",
    decision: "approved",
    evidenceHash: "evidence-2",
    evidenceSnapshot: { salida: 5_400_000 },
    decidedBy: USER,
    supersedesApprovalId: granted.id,
  });
  assert.ok(superseded);
  assert.equal(superseded!.id, granted.id);
  assert.equal(superseded!.superseded_by, regrant.id);

  const latest = await getLatestCaseApproval(fake.client, USER, CASE, "price");
  assert.equal(latest!.id, regrant.id);
  assert.equal(latest!.evidence_hash, "evidence-2");

  const fullChain = await listCaseApprovalsForCase(fake.client, USER, CASE, {
    approvalKind: "price",
    includeSuperseded: true,
  });
  assert.equal(fullChain.length, 2, "decision chain preserved");
  console.log("ok - approval grant → suspend → re-approve chain");
}

// ============================================================
// Tests: account_assets versioning
// ============================================================

async function testAssetReplacementCreatesVersions(): Promise<void> {
  const fake = makeFakeDb();
  const v1 = await upsertAccountAsset(fake.client, {
    userId: USER,
    assetKey: "commission_contract_template",
    displayName: "Plantilla de contrato",
    storageBucket: "account-assets",
    storagePath: `${USER}/commission_contract_template/1-plantilla.docx`,
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileSizeBytes: 1000,
    contentHash: "hash-v1",
  });
  assert.equal(v1.content_hash, "hash-v1");
  let versions = await listAccountAssetVersions(fake.client, USER, v1.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version_number, 1);
  assert.equal(versions[0].content_hash, "hash-v1");

  // Upsert sin cambio de contenido: no versiona y preserva el hash.
  const same = await upsertAccountAsset(fake.client, {
    userId: USER,
    assetKey: "commission_contract_template",
    displayName: "Plantilla de contrato (renombrada)",
    storageBucket: "account-assets",
    storagePath: `${USER}/commission_contract_template/1-plantilla.docx`,
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileSizeBytes: 1000,
  });
  assert.equal(same.content_hash, "hash-v1", "hash preserved without new bytes");
  versions = await listAccountAssetVersions(fake.client, USER, v1.id);
  assert.equal(versions.length, 1, "no content change ⇒ no new version");

  // Reemplazo real: versión 2; la versión 1 queda intacta.
  const v2 = await upsertAccountAsset(fake.client, {
    userId: USER,
    assetKey: "commission_contract_template",
    displayName: "Plantilla de contrato",
    storageBucket: "account-assets",
    storagePath: `${USER}/commission_contract_template/2-plantilla.docx`,
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    fileSizeBytes: 1200,
    contentHash: "hash-v2",
  });
  assert.equal(v2.id, v1.id, "same asset row (upsert by user+key)");
  versions = await listAccountAssetVersions(fake.client, USER, v1.id);
  assert.equal(versions.length, 2);
  const latest = await getLatestAccountAssetVersion(fake.client, USER, v1.id);
  assert.equal(latest!.version_number, 2);
  assert.equal(latest!.content_hash, "hash-v2");
  const first = versions.find((v) => v.version_number === 1)!;
  assert.equal(first.content_hash, "hash-v1", "version 1 never rewritten");
  assert.ok(
    first.storage_path.endsWith("1-plantilla.docx"),
    "version 1 keeps its storage path"
  );
  console.log("ok - asset replacement creates immutable versions");
}

async function testVersionBackfillHashOnly(): Promise<void> {
  const fake = makeFakeDb();
  // Pointer-style upsert sin hash (patrón easybroker_image): versión con hash null.
  const asset = await upsertAccountAsset(fake.client, {
    userId: USER,
    assetKey: "easybroker_image__abc",
    displayName: "foto.jpg",
    storageBucket: "case-documents",
    storagePath: `${USER}/case/foto.jpg`,
  });
  const pending = await getLatestAccountAssetVersion(fake.client, USER, asset.id);
  assert.equal(pending!.content_hash, null);

  const filled = await fillAccountAssetVersionContentHash(fake.client, {
    userId: USER,
    versionId: pending!.id,
    contentHash: "hash-backfilled",
  });
  assert.ok(filled);
  assert.equal(filled!.content_hash, "hash-backfilled");

  // Segunda corrida: no-op (guardada por content_hash is null).
  const secondRun = await fillAccountAssetVersionContentHash(fake.client, {
    userId: USER,
    versionId: pending!.id,
    contentHash: "hash-other",
  });
  assert.equal(secondRun, null, "backfill is one-shot per version");

  // Reescritura de otros campos de una versión: ilegal.
  await assert.rejects(
    async () => {
      const { error } = await fake.client
        .from("account_asset_versions")
        .update({ storage_path: "otra/ruta.jpg" })
        .eq("id", pending!.id)
        .select("*");
      if (error) throw error;
    },
    /immutable/,
    "version rows immutable except content_hash null→value"
  );
  console.log("ok - version backfill hash-only + immutability");
}

// ============================================================
// Runner
// ============================================================

async function main(): Promise<void> {
  await testFactInsertSupersedesPrior();
  await testFactRowsAreImmutable();
  await testArtifactEdgesAndReverseLookup();
  await testArtifactStatusCasAndSupersede();
  await testApprovalGrantSuspendReapprove();
  await testAssetReplacementCreatesVersions();
  await testVersionBackfillHashOnly();
  console.log("impact-plane selftest: all tests passed");
}

main().catch((err) => {
  console.error("impact-plane selftest failed:", err);
  process.exit(1);
});
