/**
 * Validación N3/N4 cuando package_ready debe bloquear publicación (preflight).
 * Patrón: escenario package_ready_preflight_blocked
 */

const PUBLISH_TOOLS = [
  "image_watermark",
  "easybroker_create_listing",
  "easybroker_upload_images",
  "ungga_publish_listing",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function rawPhotosCount(context: Record<string, unknown>): number {
  const raw = context.raw_photos;
  return Array.isArray(raw) ? raw.length : 0;
}

export function publishToolExecuted(
  toolCalls: Array<{ tool_name: string; status: string }>
) {
  return PUBLISH_TOOLS.filter((toolName) =>
    toolCalls.some(
      (call) =>
        call.tool_name === toolName &&
        (call.status === "executed" || call.status === "pending_confirmation")
    )
  );
}

export function validatePackageReadyPreflightOutcome(params: {
  current_step: string;
  status: string;
  context: Record<string, unknown>;
  notify_user_executed: boolean;
  toolCalls: Array<{ tool_name: string; status: string }>;
}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (params.current_step !== "package_ready") {
    errors.push("current_step debe ser package_ready.");
  }
  if (params.status !== "paused") {
    errors.push("status debe ser paused cuando el preflight bloquea publicación.");
  }
  if (!params.notify_user_executed) {
    errors.push("notify_user debe explicar qué falta para publicar.");
  }
  const published = publishToolExecuted(params.toolCalls);
  if (published.length > 0) {
    errors.push(
      `No debe publicar ni procesar paquete en preflight bloqueado; tools ejecutadas de más: ${published.join(", ")}.`
    );
  }
  const photoCount = rawPhotosCount(params.context);
  if (photoCount >= 5) {
    errors.push(
      "raw_photos no debe tener 5+ fotos en el escenario de preflight bloqueado."
    );
  }
  return { ok: errors.length === 0, errors };
}
