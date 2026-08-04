/**
 * Panel de recursos (assets) del tenant — Workflow Studio shell (Slice 2.7-3).
 *
 * Agrega los required assets de las definiciones resueltas del tenant
 * (privada publicada más reciente por case type, si no la global) y muestra
 * por asset: label/descripción, qué definición+paso lo consume, la fila
 * actual de account_assets (o su ausencia) y el estado de readiness.
 *
 * Precedencia de fuente [D 2.7-4]: graph_jsonb.step_bindings[].required_assets
 * de la definición publicada; mientras ninguna versión publicada los traiga,
 * fallback a la fuente del lab (operational_flow_jsonb + tool catalog). Nunca
 * se muta una definición publicada.
 *
 * Subida/reemplazo vía POST /api/account-assets existente (2.7-3). Acceso
 * por cuenta, sin gate de admin (2.7-6).
 */
import { redirect } from "next/navigation";
import {
  createServerClient,
  getLatestPublishedDefinitionForUser,
  listAccountAssets,
  listOperationalCaseTypesForUser,
} from "@agents/db";
import { TOOL_CATALOG } from "@agents/agent";
import type { AccountAsset, OperationalCaseType } from "@agents/types";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import {
  aggregateTenantAssets,
  resolveRequiredAssetsForDefinition,
  tenantAssetReadinessLabel,
  type ResolvedRequiredAsset,
  type TenantAssetEntry,
} from "@/lib/workflow-studio/required-assets";
import { AssetUploadControl } from "./upload-control";
import { WorkflowStudioTabs } from "../studio-tabs";

export const dynamic = "force-dynamic";

function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readinessBadgeClasses(entry: TenantAssetEntry): string {
  switch (entry.readiness) {
    case "configured":
      return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200";
    case "missing":
      return "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200";
    case "optional_missing":
      return "border-neutral-300 bg-neutral-100 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  }
}

function currentAssetLine(asset: AccountAsset): string {
  const parts = [
    asset.content_type ?? "archivo",
    formatFileSize(asset.file_size_bytes),
    `actualizado ${new Date(asset.updated_at).toLocaleDateString("es-MX")}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export default async function TenantAssetsPanelPage() {
  const auth = await createClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) redirect("/login");

  const db = createServerClient();
  const catalogById = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));

  let entries: TenantAssetEntry[] = [];
  let unavailable = false;
  try {
    const caseTypes = await listOperationalCaseTypesForUser(db, user.id);
    // Flow del lab por case type: preferir la fila privada del usuario (su
    // customización) sobre la global — mismo orden que la herencia del lab.
    const caseTypeBySlug = new Map<string, OperationalCaseType>();
    for (const caseType of caseTypes) {
      const existing = caseTypeBySlug.get(caseType.case_type);
      if (!existing || (caseType.user_id && !existing.user_id)) {
        caseTypeBySlug.set(caseType.case_type, caseType);
      }
    }

    const resolved: ResolvedRequiredAsset[] = [];
    for (const [slug, caseType] of caseTypeBySlug) {
      const definition = await getLatestPublishedDefinitionForUser(
        db,
        user.id,
        slug
      );
      if (!definition) continue;
      resolved.push(
        ...resolveRequiredAssetsForDefinition({
          definition,
          fallback: {
            flow: caseType.operational_flow_jsonb ?? [],
            catalogById,
          },
        })
      );
    }

    const accountAssets = await listAccountAssets(db, { userId: user.id });
    entries = aggregateTenantAssets(resolved, accountAssets);
  } catch {
    unavailable = true;
  }

  return (
    <AppShell
      title="Recursos de la cuenta"
      description="Archivos que tus workflows necesitan: qué definición y paso los consumen, y qué falta por subir."
    >
      <WorkflowStudioTabs active="assets" />

      {unavailable ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          El panel de recursos no está disponible en este entorno.
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          Ninguna definición de workflow de tu cuenta declara recursos
          requeridos todavía.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <article
              key={entry.assetKey}
              className="rounded-2xl border border-neutral-200 bg-white p-4 text-xs shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                    {entry.status.label}
                  </p>
                  {entry.status.description ? (
                    <p className="mt-0.5 text-neutral-500">
                      {entry.status.description}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-neutral-400">
                    <code className="text-[10px]">{entry.assetKey}</code>
                    {entry.status.max_count > 1
                      ? ` · colección (${entry.status.configured_count}/${entry.status.max_count})`
                      : ""}
                  </p>
                </div>
                <span
                  className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${readinessBadgeClasses(entry)}`}
                >
                  {tenantAssetReadinessLabel(entry.readiness)}
                </span>
              </div>

              <div className="mt-2 space-y-0.5 text-neutral-500">
                {entry.consumers.map((consumer, i) => (
                  <p key={`${consumer.definitionId}-${consumer.stepKey}-${i}`}>
                    Lo usa: {consumer.caseType}
                    {consumer.definitionVersion != null
                      ? ` (v${consumer.definitionVersion})`
                      : ""}{" "}
                    · paso {consumer.stepLabel ?? consumer.stepKey}
                    {consumer.source === "lab_fallback"
                      ? " · fuente: plantilla del laboratorio"
                      : ""}
                  </p>
                ))}
              </div>

              {entry.status.assets.length > 0 ? (
                <div className="mt-2 space-y-0.5 text-neutral-600 dark:text-neutral-300">
                  {entry.status.assets.map((asset) => (
                    <p key={asset.id}>
                      {asset.display_name} · {currentAssetLine(asset)}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-neutral-400">Sin archivo subido.</p>
              )}

              <div className="mt-3">
                <AssetUploadControl
                  assetKey={entry.assetKey}
                  label={entry.status.label}
                  description={entry.status.description}
                  accept={entry.status.accept}
                  maxSizeMb={entry.status.max_size_mb}
                  hasExisting={entry.status.assets.length > 0}
                />
              </div>
            </article>
          ))}
        </div>
      )}
    </AppShell>
  );
}
