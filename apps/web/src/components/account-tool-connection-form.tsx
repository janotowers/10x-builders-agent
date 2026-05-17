"use client";

/**
 * Formulario reusable para conectar/configurar/desconectar una cuenta
 * externa cuyo provider está declarado en
 * `apps/web/src/lib/account-tool-providers.ts`.
 *
 * Se monta en:
 *   - `apps/web/src/app/settings/settings-form.tsx` → sección "Cuentas externas"
 *   - `apps/web/src/app/settings/operational-case-types/operational-case-types-client.tsx`
 *     → inline cuando la readiness lo pide.
 *
 * Reglas:
 *   - Nunca recibe el secret descifrado; sólo lo envía cifrable al server
 *     cuando el usuario lo escribe.
 *   - El placeholder de un campo `password` no muestra el valor previo
 *     porque no lo tenemos en cliente (privacy by design); muestra ●●●●
 *     cuando ya hay credencial guardada para indicar "ya hay algo aquí".
 */

import { useCallback, useEffect, useState } from "react";
import type {
  AccountToolFieldSpec,
  AccountToolProviderSpec,
} from "@/lib/account-tool-providers";
import type { AccountToolSecretPublic } from "@agents/types";

interface Props {
  /** ID del provider (`easybroker`, `ungga_api`, …). */
  provider: string;
  /** Cuando true, muestra un header compacto sin el `<h3>` y sin descripción. */
  compact?: boolean;
  /**
   * Callback opcional. Se invoca tras un guardado o tras un test exitoso,
   * útil para que el contenedor refresque su propia readiness.
   */
  onChanged?: (secret: AccountToolSecretPublic | null) => void;
}

interface FetchedState {
  provider: AccountToolProviderSpec;
  secret: AccountToolSecretPublic | null;
}

export function AccountToolConnectionForm({
  provider,
  compact,
  onChanged,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<FetchedState | null>(null);
  const [configDraft, setConfigDraft] = useState<Record<string, string>>({});
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({});
  const [savingBusy, setSavingBusy] = useState(false);
  const [testingBusy, setTestingBusy] = useState(false);
  const [disconnectingBusy, setDisconnectingBusy] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: "ok"; message: string }
    | { kind: "err"; message: string }
    | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/account-tool-secrets/${provider}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as {
        provider: AccountToolProviderSpec;
        secret: AccountToolSecretPublic | null;
      };
      setState({ provider: body.provider, secret: body.secret });
      const initialConfig: Record<string, string> = {};
      for (const f of body.provider.configFields) {
        const v = body.secret?.config_jsonb?.[f.name];
        initialConfig[f.name] = typeof v === "string" ? v : "";
      }
      setConfigDraft(initialConfig);
      // Secret fields siempre vacíos: nunca se transportan al cliente.
      const emptySecrets: Record<string, string> = {};
      for (const f of body.provider.secretFields) emptySecrets[f.name] = "";
      setSecretDraft(emptySecrets);
    } catch (e) {
      setError((e as Error).message ?? "Error de red");
    } finally {
      setLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasSecret = Boolean(state?.secret);
  const status = state?.secret?.status ?? null;
  const lastError = state?.secret?.last_error ?? null;
  const lastChecked = state?.secret?.last_checked_at ?? null;
  const secretDraftEmpty = Object.values(secretDraft).every(
    (v) => !v.trim().length
  );
  const canTest = hasSecret && !testingBusy;
  const testIsPrimary =
    hasSecret && (status === "pending_test" || status === "invalid");
  const saveLabel = hasSecret ? "Actualizar credenciales" : "Guardar";

  async function handleSave() {
    if (!state) return;
    setFeedback(null);
    setSavingBusy(true);
    try {
      // Si ya hay secret guardado y el usuario no escribió uno nuevo,
      // sólo actualizamos config preservando el secret cifrado en server.
      const onlyConfig = hasSecret && secretDraftEmpty;
      const payload = onlyConfig
        ? { config: configDraft, preserve_secret: true }
        : { config: configDraft, secret: secretDraft };

      // Validar localmente que los campos requeridos estén llenos cuando
      // es nuevo registro o cuando el usuario quiso editar el secret.
      if (!hasSecret || !onlyConfig) {
        for (const f of state.provider.secretFields) {
          if (f.required && !secretDraft[f.name]?.trim()) {
            setFeedback({
              kind: "err",
              message: `Falta ${f.label}.`,
            });
            return;
          }
        }
      }
      for (const f of state.provider.configFields) {
        if (f.required && !configDraft[f.name]?.trim()) {
          setFeedback({ kind: "err", message: `Falta ${f.label}.` });
          return;
        }
      }

      const res = await fetch(`/api/account-tool-secrets/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({
          kind: "err",
          message: body.error ?? `Error ${res.status} al guardar.`,
        });
        return;
      }
      setState((prev) =>
        prev ? { provider: prev.provider, secret: body.secret } : prev
      );
      setSecretDraft((prev) => {
        const cleared: Record<string, string> = {};
        for (const k of Object.keys(prev)) cleared[k] = "";
        return cleared;
      });
      setFeedback({
        kind: "ok",
        message: onlyConfig
          ? "Configuración actualizada."
          : "Credenciales guardadas. Ahora prueba la conexión.",
      });
      onChanged?.(body.secret ?? null);
    } catch (e) {
      setFeedback({ kind: "err", message: (e as Error).message });
    } finally {
      setSavingBusy(false);
    }
  }

  async function handleTest() {
    if (!hasSecret) return;
    setFeedback(null);
    setTestingBusy(true);
    try {
      const res = await fetch(`/api/account-tool-secrets/${provider}/test`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({
          kind: "err",
          message: body.error ?? `Error ${res.status} al probar.`,
        });
        return;
      }
      if (body.ok) {
        setFeedback({ kind: "ok", message: "Conexión válida ✓" });
      } else {
        setFeedback({
          kind: "err",
          message: body.error ?? "La conexión falló.",
        });
      }
      if (body.secret) {
        setState((prev) =>
          prev ? { provider: prev.provider, secret: body.secret } : prev
        );
        onChanged?.(body.secret);
      }
    } catch (e) {
      setFeedback({ kind: "err", message: (e as Error).message });
    } finally {
      setTestingBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!hasSecret) return;
    if (
      !confirm(
        `¿Desconectar la cuenta de ${state?.provider.displayName}? Las credenciales se eliminarán de forma segura.`
      )
    )
      return;
    setFeedback(null);
    setDisconnectingBusy(true);
    try {
      const res = await fetch(
        `/api/account-tool-secrets/${provider}?hard=1`,
        { method: "DELETE" }
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({
          kind: "err",
          message: body.error ?? `Error ${res.status} al desconectar.`,
        });
        return;
      }
      setState((prev) =>
        prev ? { provider: prev.provider, secret: null } : prev
      );
      setSecretDraft((prev) => {
        const cleared: Record<string, string> = {};
        for (const k of Object.keys(prev)) cleared[k] = "";
        return cleared;
      });
      setConfigDraft((prev) => {
        const cleared: Record<string, string> = {};
        for (const k of Object.keys(prev)) cleared[k] = "";
        return cleared;
      });
      setFeedback({ kind: "ok", message: "Cuenta desconectada." });
      onChanged?.(null);
    } catch (e) {
      setFeedback({ kind: "err", message: (e as Error).message });
    } finally {
      setDisconnectingBusy(false);
    }
  }

  if (loading) {
    return (
      <p className="text-sm text-neutral-500">
        Cargando configuración…
      </p>
    );
  }
  if (error || !state) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        {error ?? "No se pudo cargar el provider."}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {!compact && (
        <header className="space-y-1">
          <h3 className="text-sm font-semibold">
            {state.provider.displayName}
          </h3>
          <p className="text-xs text-neutral-500">{state.provider.description}</p>
          {state.provider.credentialsHelpUrl && (
            <p className="text-xs">
              <a
                href={state.provider.credentialsHelpUrl}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 underline hover:text-blue-700"
              >
                Cómo obtener las credenciales →
              </a>
            </p>
          )}
        </header>
      )}

      <StatusBadge status={status} />

      {lastError && status === "invalid" && (
        <p className="text-xs text-red-600 dark:text-red-400">
          Último error: {lastError}
        </p>
      )}
      {lastChecked && (
        <p className="text-xs text-neutral-500">
          Última validación: {new Date(lastChecked).toLocaleString()}
        </p>
      )}

      <div className="space-y-2">
        {state.provider.configFields.map((f) => (
          <FieldInput
            key={f.name}
            field={f}
            value={configDraft[f.name] ?? ""}
            onChange={(v) =>
              setConfigDraft((prev) => ({ ...prev, [f.name]: v }))
            }
            placeholderOverride={undefined}
          />
        ))}
        {state.provider.secretFields.map((f) => (
          <FieldInput
            key={f.name}
            field={f}
            value={secretDraft[f.name] ?? ""}
            onChange={(v) =>
              setSecretDraft((prev) => ({ ...prev, [f.name]: v }))
            }
            placeholderOverride={hasSecret ? "●●●●●●●● (oculto)" : undefined}
          />
        ))}
      </div>

      {hasSecret && (
        <p className="text-xs text-neutral-500">
          Tip: para conservar las credenciales guardadas, deja los campos
          de password en blanco. Si los llenas, se reemplazarán.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {testIsPrimary ? (
          <>
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={!canTest}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {testingBusy ? "Probando…" : "Probar conexión"}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={savingBusy}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              {savingBusy ? "Guardando…" : saveLabel}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={savingBusy}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {savingBusy ? "Guardando…" : saveLabel}
            </button>
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={!canTest}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              {testingBusy ? "Probando…" : "Probar conexión"}
            </button>
          </>
        )}
        {hasSecret && (
          <button
            type="button"
            onClick={() => void handleDisconnect()}
            disabled={disconnectingBusy}
            className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-700 dark:hover:bg-red-900/20"
          >
            {disconnectingBusy ? "Desconectando…" : "Desconectar"}
          </button>
        )}
      </div>

      {feedback && (
        <p
          className={
            feedback.kind === "ok"
              ? "text-xs text-green-600 dark:text-green-400"
              : "text-xs text-red-600 dark:text-red-400"
          }
        >
          {feedback.message}
        </p>
      )}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
  placeholderOverride,
}: {
  field: AccountToolFieldSpec;
  value: string;
  onChange: (v: string) => void;
  placeholderOverride?: string;
}) {
  const inputType =
    field.type === "password"
      ? "password"
      : field.type === "url"
        ? "url"
        : "text";
  return (
    <label className="block text-xs">
      <span className="block text-neutral-600 dark:text-neutral-300">
        {field.label}
        {field.required ? " *" : ""}
      </span>
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholderOverride ?? field.placeholder ?? ""}
        autoComplete="off"
        className="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
      {field.help && (
        <span className="mt-0.5 block text-[11px] text-neutral-500">
          {field.help}
        </span>
      )}
    </label>
  );
}

function StatusBadge({
  status,
}: {
  status: AccountToolSecretPublic["status"] | null;
}) {
  const label =
    status === "active"
      ? "Conectada"
      : status === "pending_test"
        ? "Pendiente de probar"
        : status === "invalid"
          ? "Credenciales inválidas"
          : status === "disconnected"
            ? "Desconectada"
            : "Sin conexión";
  const tone =
    status === "active"
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
      : status === "pending_test"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
        : status === "invalid"
          ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
          : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}
    >
      {label}
    </span>
  );
}
