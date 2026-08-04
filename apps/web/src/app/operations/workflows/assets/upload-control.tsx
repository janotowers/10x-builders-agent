"use client";

/**
 * Control de subida/reemplazo de un recurso de cuenta (Slice 2.7-3).
 * Reutiliza el endpoint existente POST /api/account-assets — misma disciplina
 * que el lab: max_size_mb se valida aquí en el cliente y el servidor aplica
 * su tope global y la regla DOCX de la plantilla de contrato.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function AssetUploadControl({
  assetKey,
  label,
  description,
  accept,
  maxSizeMb,
  hasExisting,
}: {
  assetKey: string;
  label: string;
  description?: string;
  accept?: string[];
  maxSizeMb?: number;
  hasExisting: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleFile(file: File) {
    setMessage(null);
    const effectiveMax = maxSizeMb ?? 15;
    if (file.size > effectiveMax * 1024 * 1024) {
      setMessage(`El archivo supera el máximo de ${effectiveMax} MB.`);
      return;
    }
    setBusy(true);
    try {
      const formData = new FormData();
      formData.set("asset_key", assetKey);
      formData.set("display_name", label);
      formData.set("description", description ?? "");
      formData.set("file", file);
      const res = await fetch("/api/account-assets", {
        method: "POST",
        body: formData,
      });
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!res.ok || !payload?.ok) {
        setMessage(payload?.error ?? "No se pudo subir el archivo.");
        return;
      }
      setMessage(hasExisting ? "Archivo reemplazado." : "Archivo subido.");
      router.refresh();
    } catch {
      setMessage("No se pudo subir el archivo.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={accept?.length ? accept.join(",") : undefined}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="rounded-md border border-violet-300 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-800 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200"
      >
        {busy ? "Subiendo…" : hasExisting ? "Reemplazar archivo" : "Subir archivo"}
      </button>
      {message ? (
        <p className="mt-1 text-[11px] text-neutral-500">{message}</p>
      ) : null}
    </div>
  );
}
