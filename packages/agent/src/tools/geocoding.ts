type GeocodingInput = {
  street?: string;
  exterior_number?: string;
  neighborhood?: string;
  municipality?: string;
  state?: string;
  postal_code?: string;
  country?: string;
};

type GeocodingCandidate = {
  formatted_address: string;
  latitude: number;
  longitude: number;
  place_id: string | null;
  location_type: string | null;
  confidence: "high" | "medium" | "low";
};

type GeocodingResult =
  | {
      ok: true;
      status: "ok";
      provider: "google";
      latitude: number;
      longitude: number;
      formatted_address: string;
      confidence: "high" | "medium" | "low";
      candidates: GeocodingCandidate[];
    }
  | {
      ok: false;
      status: "not_configured" | "validation_error" | "ambiguous" | "provider_error";
      provider: "google";
      message: string;
      retryable: boolean;
      candidates?: GeocodingCandidate[];
      debug?: Record<string, unknown>;
    };

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildGoogleAddress(input: GeocodingInput): string {
  const parts = [
    [cleanText(input.street), cleanText(input.exterior_number)]
      .filter(Boolean)
      .join(" ")
      .trim(),
    cleanText(input.neighborhood),
    cleanText(input.municipality),
    cleanText(input.state),
    cleanText(input.postal_code),
    cleanText(input.country) ?? "MX",
  ].filter(Boolean);
  return parts.join(", ");
}

function confidenceFromLocationType(value: unknown): "high" | "medium" | "low" {
  const normalized = typeof value === "string" ? value.toUpperCase() : "";
  if (normalized === "ROOFTOP" || normalized === "RANGE_INTERPOLATED") return "high";
  if (normalized === "GEOMETRIC_CENTER") return "medium";
  return "low";
}

function parseGoogleCandidates(raw: unknown): GeocodingCandidate[] {
  if (!raw || typeof raw !== "object") return [];
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const result = row as Record<string, unknown>;
      const geometry =
        result.geometry && typeof result.geometry === "object"
          ? (result.geometry as Record<string, unknown>)
          : null;
      const location =
        geometry?.location && typeof geometry.location === "object"
          ? (geometry.location as Record<string, unknown>)
          : null;
      const lat = typeof location?.lat === "number" ? location.lat : null;
      const lng = typeof location?.lng === "number" ? location.lng : null;
      const formattedAddress =
        typeof result.formatted_address === "string"
          ? result.formatted_address.trim()
          : "";
      if (!formattedAddress || lat == null || lng == null) return null;
      return {
        formatted_address: formattedAddress,
        latitude: lat,
        longitude: lng,
        place_id:
          typeof result.place_id === "string" && result.place_id.trim()
            ? result.place_id.trim()
            : null,
        location_type:
          typeof geometry?.location_type === "string" ? geometry.location_type : null,
        confidence: confidenceFromLocationType(geometry?.location_type),
      } satisfies GeocodingCandidate;
    })
    .filter((candidate): candidate is GeocodingCandidate => candidate != null);
}

export async function geocodePropertyAddress(
  input: GeocodingInput
): Promise<GeocodingResult> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      status: "not_configured",
      provider: "google",
      message:
        "Falta GOOGLE_MAPS_API_KEY para geocoding. Configura la variable en el entorno.",
      retryable: false,
    };
  }

  const address = buildGoogleAddress(input);
  if (!address) {
    return {
      ok: false,
      status: "validation_error",
      provider: "google",
      message:
        "Faltan datos de dirección para geocodificar. Proporciona al menos calle/zona/municipio/estado.",
      retryable: false,
    };
  }

  const params = new URLSearchParams({
    address,
    key: apiKey,
    language: "es",
    region: "mx",
  });
  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const payload = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!response.ok) {
      return {
        ok: false,
        status: "provider_error",
        provider: "google",
        message: `Google Geocoding HTTP ${response.status}`,
        retryable: response.status >= 500,
        debug: { response_status: response.status },
      };
    }
    const apiStatus =
      payload && typeof payload.status === "string" ? payload.status : "";
    if (apiStatus && apiStatus !== "OK" && apiStatus !== "ZERO_RESULTS") {
      return {
        ok: false,
        status: "provider_error",
        provider: "google",
        message: `Google Geocoding status=${apiStatus}`,
        retryable: apiStatus === "UNKNOWN_ERROR",
        debug: {
          api_status: apiStatus,
          error_message:
            typeof payload?.error_message === "string"
              ? payload.error_message
              : undefined,
        },
      };
    }

    const candidates = parseGoogleCandidates(payload);
    if (candidates.length === 0) {
      return {
        ok: false,
        status: "validation_error",
        provider: "google",
        message:
          "No se pudo geocodificar la dirección con suficiente precisión. Ajusta calle/colonia/municipio.",
        retryable: false,
      };
    }

    const [top, ...rest] = candidates;
    const topConfidenceRank = top.confidence === "high" ? 3 : top.confidence === "medium" ? 2 : 1;
    const secondRank =
      rest[0] == null
        ? 0
        : rest[0].confidence === "high"
          ? 3
          : rest[0].confidence === "medium"
            ? 2
            : 1;

    if (topConfidenceRank < 3 && secondRank >= topConfidenceRank) {
      return {
        ok: false,
        status: "ambiguous",
        provider: "google",
        message:
          "La dirección es ambigua; se requieren más detalles o confirmación de candidato.",
        retryable: false,
        candidates: candidates.slice(0, 5),
      };
    }

    return {
      ok: true,
      status: "ok",
      provider: "google",
      latitude: top.latitude,
      longitude: top.longitude,
      formatted_address: top.formatted_address,
      confidence: top.confidence,
      candidates: candidates.slice(0, 5),
    };
  } catch (error) {
    return {
      ok: false,
      status: "provider_error",
      provider: "google",
      message:
        error instanceof Error
          ? `No se pudo geocodificar la dirección: ${error.message}`
          : "No se pudo geocodificar la dirección.",
      retryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export type { GeocodingInput, GeocodingResult, GeocodingCandidate };
