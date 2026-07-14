type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function contextString(
  context: JsonRecord | null | undefined,
  key: string
): string | null {
  const value = context?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function formatPriceForSummary(
  amount: number | null,
  currency: string | null
): string | null {
  if (amount == null || !(amount > 0)) return null;
  const normalizedCurrency = (currency ?? "MXN").trim() || "MXN";
  return `${amount.toLocaleString("es-MX")} ${normalizedCurrency}`;
}

function approvalOf(
  context: JsonRecord,
  destination: "easybroker" | "ungga"
): string | null {
  const approvals = isRecord(context.publish_approvals)
    ? context.publish_approvals
    : {};
  const value = approvals[destination];
  return typeof value === "string" ? value : null;
}

function publicationPhaseOf(
  context: JsonRecord,
  destination: "easybroker" | "ungga"
): string | null {
  const publication = isRecord(context.publication) ? context.publication : {};
  const destinations = isRecord(publication.destinations)
    ? publication.destinations
    : {};
  const dest = isRecord(destinations[destination])
    ? destinations[destination]
    : {};
  return typeof dest.phase === "string" ? dest.phase : null;
}

function looksLikeEasyBrokerImportedUnggaId(propertyId: string): boolean {
  return /EB-[A-Z0-9]+/i.test(propertyId.trim());
}

function unggaUrlMatchesPropertyId(
  publishedUrl: string,
  propertyId: string
): boolean {
  const m = publishedUrl.match(/\/propiedades\/([^/?#]+)/i);
  if (!m?.[1]) return false;
  return m[1].trim() === propertyId.trim();
}

/**
 * Strict completion gate for listing_published_summary / case closure.
 *
 * - Does not accept EasyBroker draft listing_id alone
 * - Does not accept Ungga GU-ID alone (requires published_url)
 * - Rejects EasyBroker-imported Ungga IDs as evidence
 * - Blocks when machine work / in-flight phases are active
 */
export function canCompleteListingPublishedSummaryFromContext(
  context: JsonRecord,
  recentEvents?: Array<{ payload_jsonb?: unknown }>,
  options?: {
    allowLegacyRelaxed?: boolean;
    machineWorkInFlight?: boolean;
    hasInFlightLedgerOperation?: boolean;
  }
): { ok: boolean; reason?: string } {
  if (options?.machineWorkInFlight === true) {
    return {
      ok: false,
      reason: "Hay trabajo de publicación en curso; no se puede cerrar aún.",
    };
  }
  if (options?.hasInFlightLedgerOperation === true) {
    return {
      ok: false,
      reason:
        "Hay una operación de publicación claimed/running; no se puede cerrar aún.",
    };
  }

  const published = isRecord(context.published) ? context.published : {};
  const easybroker = isRecord(published.easybroker) ? published.easybroker : {};
  const ungga = isRecord(published.ungga) ? published.ungga : {};
  const manualPackage = isRecord(context.manual_publish_package)
    ? context.manual_publish_package
    : {};

  const easybrokerApproval = approvalOf(context, "easybroker");
  const unggaApproval = approvalOf(context, "ungga");
  const easybrokerPhase = publicationPhaseOf(context, "easybroker");
  const unggaPhase = publicationPhaseOf(context, "ungga");

  const inFlightPhase = (phase: string | null) =>
    phase === "draft_creating" ||
    phase === "publishing" ||
    phase === "media_processing";

  if (inFlightPhase(easybrokerPhase) || inFlightPhase(unggaPhase)) {
    return {
      ok: false,
      reason: "Hay una fase de publicación in-flight; no se puede cerrar aún.",
    };
  }

  const easybrokerFromEvents =
    recentEvents?.some((event) => {
      const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : null;
      return payload?.kind === "easybroker_published";
    }) ?? false;
  const unggaFromEvents =
    recentEvents?.some((event) => {
      const payload = isRecord(event.payload_jsonb) ? event.payload_jsonb : null;
      return payload?.kind === "ungga_published";
    }) ?? false;

  const easybrokerSkipped =
    easybrokerApproval === "skipped" ||
    easybrokerApproval === "rejected" ||
    easybrokerPhase === "skipped";
  const unggaSkipped =
    unggaApproval === "skipped" ||
    unggaApproval === "rejected" ||
    unggaPhase === "skipped";

  const easybrokerPublicUrl =
    contextString(easybroker, "public_url") ??
    contextString(easybroker, "url") ??
    contextString(easybroker, "agent_url");
  const easybrokerListingId = contextString(easybroker, "listing_id");
  const easybrokerStatus =
    contextString(easybroker, "status") ??
    contextString(easybroker, "remote_status");
  const easybrokerPublishedStrict =
    !easybrokerSkipped &&
    (easybrokerPhase === "published" ||
      easybrokerStatus === "published" ||
      easybrokerFromEvents) &&
    Boolean(easybrokerPublicUrl || easybrokerListingId);

  const unggaPropertyId = contextString(ungga, "ungga_property_id");
  const unggaUrl = contextString(ungga, "published_url");
  const unggaStatus =
    contextString(ungga, "status") ?? contextString(ungga, "remote_status");

  if (
    unggaPropertyId &&
    looksLikeEasyBrokerImportedUnggaId(unggaPropertyId)
  ) {
    return {
      ok: false,
      reason:
        "El GU-ID de Ungga parece importado desde EasyBroker; no cuenta como evidencia de publicación CLI.",
    };
  }

  const unggaPublishedStrict =
    !unggaSkipped &&
    (unggaPhase === "published" ||
      unggaStatus === "published" ||
      unggaFromEvents) &&
    Boolean(unggaUrl) &&
    (!unggaPropertyId || unggaUrlMatchesPropertyId(unggaUrl!, unggaPropertyId));

  const manualDelivered = Boolean(
    typeof manualPackage.description === "string" &&
      manualPackage.description.trim().length > 0 &&
      (typeof manualPackage.headline === "string"
        ? manualPackage.headline.trim().length > 0
        : true)
  );

  // When approvals exist, every non-skipped approved destination must be published.
  const easybrokerRequired =
    easybrokerApproval === "approved" ||
    (!easybrokerSkipped &&
      (easybrokerPhase != null || easybrokerListingId != null));
  const unggaRequired =
    unggaApproval === "approved" ||
    (!unggaSkipped && (unggaPhase != null || unggaPropertyId != null));

  if (easybrokerRequired && !easybrokerPublishedStrict && !easybrokerSkipped) {
    // Legacy relaxed mode (tool-readiness smoke only): listing_id alone.
    if (
      options?.allowLegacyRelaxed === true &&
      Boolean(easybrokerListingId || easybrokerPublicUrl)
    ) {
      // fall through
    } else {
      return {
        ok: false,
        reason:
          "EasyBroker aún no está publicado de forma verificable (fase/status published + evidencia).",
      };
    }
  }

  if (unggaRequired && !unggaPublishedStrict && !unggaSkipped) {
    if (
      options?.allowLegacyRelaxed === true &&
      Boolean(unggaPropertyId || unggaUrl)
    ) {
      // fall through
    } else {
      return {
        ok: false,
        reason:
          "Ungga aún no está publicado de forma verificable (requiere published_url del GU-ID CLI).",
      };
    }
  }

  if (
    easybrokerPublishedStrict ||
    unggaPublishedStrict ||
    (easybrokerSkipped && unggaSkipped && manualDelivered) ||
    (easybrokerSkipped && unggaPublishedStrict) ||
    (unggaSkipped && easybrokerPublishedStrict) ||
    (easybrokerSkipped && unggaSkipped) ||
    (options?.allowLegacyRelaxed === true &&
      (Boolean(easybrokerListingId || easybrokerPublicUrl) ||
        Boolean(unggaPropertyId || unggaUrl) ||
        manualDelivered ||
        easybrokerFromEvents ||
        unggaFromEvents))
  ) {
    // Require at least one real published destination unless both skipped
    // with optional manual package, or both skipped alone after explicit decisions.
    if (
      easybrokerPublishedStrict ||
      unggaPublishedStrict ||
      (easybrokerSkipped && unggaSkipped) ||
      (options?.allowLegacyRelaxed === true &&
        (Boolean(easybrokerListingId || easybrokerPublicUrl) ||
          Boolean(unggaPropertyId || unggaUrl) ||
          manualDelivered ||
          easybrokerFromEvents ||
          unggaFromEvents))
    ) {
      return { ok: true };
    }
  }

  return {
    ok: false,
    reason:
      "Para cerrar en published/completed debe existir evidencia de publicación real (EasyBroker/Ungga con URL/fase published) o destinos omitidos explícitamente.",
  };
}

export function formatListingPublishedSummaryNotifyText(opCase: {
  id: string;
  context_jsonb: unknown;
}): string {
  const context = isRecord(opCase.context_jsonb) ? opCase.context_jsonb : {};
  const propertyData = isRecord(context.property_data) ? context.property_data : {};
  const pricingProposal = isRecord(context.pricing_proposal)
    ? context.pricing_proposal
    : {};
  const approvedDescription = isRecord(context.listing_description_approved)
    ? context.listing_description_approved
    : {};
  const published = isRecord(context.published) ? context.published : {};
  const easybroker = isRecord(published.easybroker) ? published.easybroker : {};
  const ungga = isRecord(published.ungga) ? published.ungga : {};
  const manualPackage = isRecord(context.manual_publish_package)
    ? context.manual_publish_package
    : {};

  const headline =
    contextString(approvedDescription, "headline") ??
    contextString(propertyData, "property_title") ??
    "Publicación finalizada";
  const addressSummary =
    contextString(propertyData, "legal_address") ??
    contextString(propertyData, "address") ??
    contextString(manualPackage, "address_summary");
  const targetPrice = positiveNumberFromUnknown(
    pricingProposal.salida ??
      pricingProposal.target_price ??
      propertyData.target_price
  );
  const currency =
    contextString(pricingProposal, "currency") ??
    contextString(propertyData, "currency") ??
    "MXN";
  const price = formatPriceForSummary(targetPrice, currency);

  const easybrokerUrl =
    contextString(easybroker, "public_url") ??
    contextString(easybroker, "url") ??
    contextString(easybroker, "agent_url");
  const easybrokerListingId = contextString(easybroker, "listing_id");
  const unggaUrl = contextString(ungga, "published_url");
  const unggaPropertyId = contextString(ungga, "ungga_property_id");
  const manualHeadline = contextString(manualPackage, "headline");
  const manualDescription = contextString(manualPackage, "description");

  const easybrokerApproval = approvalOf(context, "easybroker");
  const unggaApproval = approvalOf(context, "ungga");
  const easybrokerSkipped =
    easybrokerApproval === "skipped" || easybrokerApproval === "rejected";
  const unggaSkipped =
    unggaApproval === "skipped" || unggaApproval === "rejected";

  const unggaResolved = Boolean(unggaUrl) || unggaSkipped;
  const easybrokerResolved =
    Boolean(easybrokerUrl || easybrokerListingId) || easybrokerSkipped;
  const allDestinationsResolved = easybrokerResolved && unggaResolved;
  const lines: string[] = [
    "**Resumen final de publicación**",
    "",
    allDestinationsResolved
      ? `Flujo completado para el caso ${opCase.id}.`
      : `Avance de publicación para el caso ${opCase.id} (aún puede faltar un destino).`,
    "",
    `**Título:** ${headline}`,
  ];
  if (addressSummary) lines.push(`**Dirección:** ${addressSummary}`);
  if (price) lines.push(`**Precio objetivo:** ${price}`);
  lines.push("");
  lines.push("**Resultado por destino:**");
  lines.push(
    easybrokerSkipped
      ? "- EasyBroker: omitido."
      : easybrokerUrl || easybrokerListingId
        ? `- EasyBroker: ${easybrokerUrl ?? `listing_id ${easybrokerListingId}`}`
        : "- EasyBroker: sin publicación final registrada."
  );
  lines.push(
    unggaSkipped
      ? "- Ungga: omitido."
      : unggaUrl
        ? `- Ungga: ${unggaUrl}`
        : unggaPropertyId
          ? `- Ungga: propiedad ${unggaPropertyId} (sin URL publicada).`
          : "- Ungga: sin publicación final registrada."
  );
  if (manualDescription || manualHeadline) {
    lines.push(
      `- Paquete manual: disponible (${manualHeadline ?? "sin titular"}).`
    );
  }
  return lines.join("\n").trim();
}
