/**
 * Copy humano para tarjetas HITL. El riesgo del catálogo decide *si* se pide
 * aprobación; este módulo decide *cómo* se explica al usuario (efecto de
 * negocio, no nombre técnico de la tool).
 */

function short(s: string, max = 140): string {
  return s.length > max ? `${s.slice(0, max).trim()}…` : s;
}

export function buildToolConfirmationMessage(
  toolName: string,
  args: Record<string, unknown>,
  extras: {
    memoryContent?: string | null;
    memoryAlreadyArchived?: boolean;
    userTimezone?: string | null;
  } = {}
): string {
  const userTimezone = extras.userTimezone;
  const recurringScheduleLabel = (
    cronExpr: unknown,
    timezone: unknown
  ): string => {
    const cron = String(cronExpr ?? "").trim();
    const tz = String(timezone ?? userTimezone ?? "UTC");
    const everyMinutes = cron.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (everyMinutes) return `cada ${everyMinutes[1]} minutos`;
    const hourly = cron.match(/^(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (hourly) return `cada hora, al minuto ${hourly[1]}`;
    return `${cron || "frecuencia recurrente"} (${tz})`;
  };

  if (toolName === "archive_user_memory") {
    const id = String(args.memory_id ?? "");
    const content = extras.memoryContent?.trim();
    const alreadyNote = extras.memoryAlreadyArchived
      ? "\n(Este recuerdo ya estaba archivado; aprobar no cambia nada.)"
      : "";
    if (content) {
      return `Confirma archivar este recuerdo (reversible):\n\n«${content}»\n\nID: ${id}${alreadyNote}`;
    }
    return `Confirma archivar este recuerdo (reversible):\nID: ${id}${alreadyNote}`;
  }
  if (toolName === "delete_user_memory") {
    const id = String(args.memory_id ?? "");
    const content = extras.memoryContent?.trim();
    if (content) {
      return `Confirma borrar definitivamente este recuerdo (irreversible):\n\n«${content}»\n\nID: ${id}`;
    }
    return `Confirma borrar definitivamente este recuerdo (irreversible):\nID: ${id}`;
  }
  if (toolName === "github_create_repo") {
    return `Se necesita tu confirmación para crear el repositorio "${String(args.name ?? "")}"${args.private ? " (privado)" : ""}.`;
  }
  if (toolName === "github_create_issue") {
    return `Se necesita tu confirmación para crear el issue "${String(args.title ?? "")}" en ${String(args.owner ?? "")}/${String(args.repo ?? "")}.`;
  }
  if (toolName === "calendar_create_event") {
    const fmt = (iso: unknown): string => {
      try {
        const d = new Date(String(iso));
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleString("es-MX", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: userTimezone ?? "America/Mexico_City",
        });
      } catch {
        return String(iso);
      }
    };
    return `Confirma crear el evento "${String(args.summary ?? "")}" de ${fmt(args.start_datetime)} a ${fmt(args.end_datetime)}.`;
  }
  if (toolName === "calendar_update_event") {
    return `Confirma actualizar el evento ${String(args.event_id ?? "")}.`;
  }
  if (toolName === "calendar_delete_event") {
    return `Confirma eliminar el evento ${String(args.event_id ?? "")}.`;
  }
  if (toolName === "bash") {
    const term = String(args.terminal ?? "default");
    const p = String(args.prompt ?? "");
    const preview = p.length > 200 ? `${p.slice(0, 200)}…` : p;
    return `Confirma ejecutar en el servidor (etiqueta: "${term}") el comando:\n${preview}`;
  }
  if (toolName === "write_file") {
    const p = String(args.path ?? "");
    const c = String(args.content ?? "");
    const bytes = Buffer.byteLength(c, "utf8");
    return `Confirma escribir (crear o sobrescribir) el archivo \`${p}\` en el workspace del servidor (${bytes} bytes).`;
  }
  if (toolName === "edit_file") {
    const p = String(args.path ?? "");
    const oldS = String(args.old_string ?? "");
    const newS = String(args.new_string ?? "");
    return `Confirma editar el archivo \`${p}\`: reemplazar\n«${short(oldS)}»\npor\n«${short(newS)}».`;
  }
  if (toolName === "schedule_task") {
    const prompt = String(args.prompt ?? "");
    const type = String(args.schedule_type ?? "");
    const title = String(args.display_title ?? "").trim();
    const taskLine = title || short(prompt);
    if (type === "one_time") {
      const when = args.run_at
        ? (() => {
            try {
              return new Date(String(args.run_at)).toLocaleString("es-MX", {
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: userTimezone ?? "UTC",
              });
            } catch {
              return String(args.run_at);
            }
          })()
        : "hora no especificada";
      return `Programar tarea para ${when}.\n\nTarea: «${taskLine}»`;
    }
    return `Programar tarea recurrente ${recurringScheduleLabel(args.cron_expr, args.timezone)}.\n\nTarea: «${taskLine}»`;
  }
  if (toolName === "operational_case_create") {
    const caseType = String(args.case_type ?? "operacional");
    const title =
      typeof args.context === "object" &&
      args.context &&
      !Array.isArray(args.context) &&
      typeof (args.context as Record<string, unknown>).title === "string"
        ? String((args.context as Record<string, unknown>).title)
        : "";
    return title
      ? `Confirma iniciar el caso «${short(title)}» (${caseType}).`
      : `Confirma iniciar un nuevo caso operacional (${caseType}).`;
  }
  if (toolName === "operational_case_update_state") {
    const step = args.current_step ? String(args.current_step) : null;
    const status = args.status ? String(args.status) : null;
    const parts = [
      step ? `paso «${step}»` : null,
      status ? `estado «${status}»` : null,
    ].filter(Boolean);
    return parts.length > 0
      ? `Confirma actualizar el caso en curso (${parts.join(", ")}).`
      : "Confirma actualizar el estado del caso en curso.";
  }
  if (toolName === "telegram_send_message_to_contact") {
    const preview = short(String(args.message ?? args.text ?? ""));
    return preview
      ? `Confirma enviar este mensaje al contacto externo:\n\n«${preview}»`
      : "Confirma enviar un mensaje al contacto externo por Telegram.";
  }
  if (toolName === "easybroker_create_listing") {
    return "Confirma crear el borrador de la propiedad en EasyBroker.";
  }
  if (toolName === "easybroker_upload_images") {
    return "Confirma subir las fotos de la propiedad a EasyBroker.";
  }
  if (toolName === "easybroker_publish_listing") {
    return "Confirma publicar la propiedad en EasyBroker.";
  }
  if (toolName === "ungga_publish_listing") {
    const action = String(args.action ?? "");
    if (action === "prepare_draft") {
      return "Confirma preparar el borrador de publicación en Ungga.";
    }
    if (action === "publish_draft") {
      return "Confirma publicar la propiedad en Ungga.";
    }
    return "Confirma continuar la publicación en Ungga.";
  }
  if (toolName === "generate_document_from_template") {
    const template = String(args.template_key ?? args.template ?? "documento");
    return `Confirma generar el documento «${short(template)}».`;
  }

  const argPreview = Object.entries(args)
    .filter(
      ([key, value]) =>
        !["expected_version", "case_id"].includes(key) &&
        (typeof value === "string" || typeof value === "number")
    )
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${short(String(value), 60)}`)
    .join("; ");
  return argPreview
    ? `Confirma esta acción (${toolName}):\n${argPreview}`
    : `Confirma esta acción: ${toolName}.`;
}
