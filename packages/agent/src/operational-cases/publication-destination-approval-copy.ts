/**
 * Shared advisor-facing copy for EasyBroker / Ungga destination approval HITL.
 * Used by agent notify_user, publication-runner, and E2E auto-continue so
 * Telegram and web inbox stay in parity.
 */

export type PublicationDestinationLabel = "EasyBroker" | "Ungga";

export function publicationDestinationLabelFromKind(
  kind: string | null | undefined
): PublicationDestinationLabel | null {
  if (kind === "easybroker_publish_approval") return "EasyBroker";
  if (kind === "ungga_publish_approval") return "Ungga";
  return null;
}

export function formatPublishDestinationApprovalNotifyText(params: {
  destination: PublicationDestinationLabel;
  /**
   * Optional leading context line (e.g. Ungga after EasyBroker published).
   * When omitted, uses a destination-appropriate default.
   */
  contextLine?: string;
}): string {
  const { destination } = params;
  const contextLine =
    params.contextLine?.trim() ||
    (destination === "Ungga"
      ? "EasyBroker ya quedó publicado. ¿Quieres continuar con Ungga?"
      : `¿Quieres continuar con ${destination}?`);

  const skipConsequence =
    destination === "Ungga"
      ? "finaliza el proceso sin publicar en Ungga."
      : "continúa con los demás destinos sin publicar aquí.";

  return [
    `Aprobación de publicación en ${destination}`,
    "",
    contextLine,
    "",
    `• **Publicar en ${destination}**: continúa la publicación en este destino.`,
    `• **Omitir ${destination}**: ${skipConsequence}`,
    "• **Pausar publicación**: detén el caso aquí para revisión interna.",
    "",
    "Elige una opción:",
  ].join("\n");
}
