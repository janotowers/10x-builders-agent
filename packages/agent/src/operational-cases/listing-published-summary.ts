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

export function canCompleteListingPublishedSummaryFromContext(
  context: JsonRecord,
  recentEvents?: Array<{ payload_jsonb?: unknown }>
): { ok: boolean; reason?: string } {
  const published = isRecord(context.published) ? context.published : {};
  const easybroker = isRecord(published.easybroker) ? published.easybroker : {};
  const ungga = isRecord(published.ungga) ? published.ungga : {};
  const manualPackage = isRecord(context.manual_publish_package)
    ? context.manual_publish_package
    : {};
  const easybrokerPublished = Boolean(
    (typeof easybroker.listing_id === "string" && easybroker.listing_id.trim()) ||
      (typeof easybroker.public_url === "string" && easybroker.public_url.trim())
  );
  const unggaPublished = Boolean(
    (typeof ungga.ungga_property_id === "string" && ungga.ungga_property_id.trim()) ||
      (typeof ungga.published_url === "string" && ungga.published_url.trim())
  );
  const manualDelivered = Boolean(
    typeof manualPackage.description === "string" &&
      manualPackage.description.trim().length > 0 &&
      (typeof manualPackage.headline === "string"
        ? manualPackage.headline.trim().length > 0
        : true)
  );
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

  if (
    easybrokerPublished ||
    unggaPublished ||
    manualDelivered ||
    easybrokerFromEvents ||
    unggaFromEvents
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      "Para cerrar en published/completed debe existir al menos un destino publicado (EasyBroker/Ungga) o un manual_publish_package entregable.",
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

  const unggaResolved = Boolean(unggaUrl || unggaPropertyId);
  const easybrokerResolved = Boolean(easybrokerUrl || easybrokerListingId);
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
    easybrokerUrl || easybrokerListingId
      ? `- EasyBroker: ${easybrokerUrl ?? `listing_id ${easybrokerListingId}`}`
      : "- EasyBroker: sin publicación final registrada."
  );
  lines.push(
    unggaUrl || unggaPropertyId
      ? `- Ungga: ${unggaUrl ?? `propiedad ${unggaPropertyId}`}`
      : "- Ungga: sin publicación final registrada."
  );
  if (manualDescription || manualHeadline) {
    lines.push(
      `- Paquete manual: disponible (${manualHeadline ?? "sin titular"}).`
    );
  }
  return lines.join("\n").trim();
}
