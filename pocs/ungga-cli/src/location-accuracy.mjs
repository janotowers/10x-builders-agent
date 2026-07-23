/**
 * Pure helpers for Ungga map pin accuracy (non-blocking).
 * Thresholds: OK ≤ 40 m; soft OK 40–80 m; retry candidate > 80 m.
 */

export const LOCATION_OK_MAX_M = 40;
export const LOCATION_SOFT_OK_MAX_M = 80;

export function isUsableLatLng(lat, lng) {
  if (lat == null || lng == null) return false;
  const a = Number(lat);
  const b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0 && b === 0) return false;
  if (Math.abs(a) < 1e-6 && Math.abs(b) < 1e-6) return false;
  return true;
}

export function haversineMeters(fromLat, fromLon, toLat, toLon) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const r = 6371_000;
  const dLat = toRad(toLat - fromLat);
  const dLon = toRad(toLon - fromLon);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(fromLat)) *
      Math.cos(toRad(toLat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(r * c);
}

/**
 * @returns {"ok" | "soft_ok" | "retry"}
 */
export function classifyLocationDistance(distanceM) {
  if (typeof distanceM !== "number" || !Number.isFinite(distanceM)) {
    return "retry";
  }
  if (distanceM <= LOCATION_OK_MAX_M) return "ok";
  if (distanceM <= LOCATION_SOFT_OK_MAX_M) return "soft_ok";
  return "retry";
}

/**
 * Extract lat/lng from Google Maps URLs, iframe src, or page HTML snippets.
 * @returns {{ latitude: number, longitude: number } | null}
 */
export function parseLatLngFromText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const patterns = [
    /@(-?\d+\.?\d*),\s*(-?\d+\.?\d*)(?:,\d)/,
    /!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/,
    /[?&](?:q|query|ll|center)=(-?\d+\.?\d*),\s*(-?\d+\.?\d*)/i,
    /[?&]lat(?:itude)?=(-?\d+\.?\d*).*?[?&]lng|lon(?:gitude)?=(-?\d+\.?\d*)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (isUsableLatLng(lat, lng)) {
      return { latitude: lat, longitude: lng };
    }
  }
  // Loose "lat, lng" near map/center keywords
  const loose = text.match(
    /(?:center|mapa|map|pin|coords?)[^-\d]{0,40}(-?\d{1,2}\.\d+)\s*[, ]\s*(-?\d{1,3}\.\d+)/i
  );
  if (loose) {
    const lat = Number(loose[1]);
    const lng = Number(loose[2]);
    if (isUsableLatLng(lat, lng)) {
      return { latitude: lat, longitude: lng };
    }
  }
  return null;
}

/**
 * Decide whether to warn after optional correction.
 * @returns {{
 *   status: "ok" | "soft_ok" | "corrected" | "warning" | "unreadable",
 *   distance_m: number | null,
 *   location_accuracy_warning: Record<string, unknown> | null
 * }}
 */
export function evaluateLocationAccuracy(input) {
  const expected = input?.expected;
  const observed = input?.observed;
  const source =
    typeof input?.source === "string" && input.source.trim()
      ? input.source.trim()
      : "unknown";
  const corrected = input?.corrected === true;

  if (
    !expected ||
    !isUsableLatLng(expected.latitude, expected.longitude)
  ) {
    return {
      status: "ok",
      distance_m: null,
      location_accuracy_warning: null,
    };
  }

  if (
    !observed ||
    !isUsableLatLng(observed.latitude, observed.longitude)
  ) {
    return {
      status: "unreadable",
      distance_m: null,
      location_accuracy_warning: {
        expected: {
          latitude: expected.latitude,
          longitude: expected.longitude,
        },
        observed: null,
        distance_m: null,
        source,
        reason: "map_center_unreadable",
      },
    };
  }

  const distance_m = haversineMeters(
    expected.latitude,
    expected.longitude,
    observed.latitude,
    observed.longitude
  );
  const bucket = classifyLocationDistance(distance_m);
  if (bucket === "ok" || bucket === "soft_ok") {
    return {
      status: corrected ? "corrected" : bucket,
      distance_m,
      location_accuracy_warning: null,
    };
  }

  return {
    status: "warning",
    distance_m,
    location_accuracy_warning: {
      expected: {
        latitude: expected.latitude,
        longitude: expected.longitude,
      },
      observed: {
        latitude: observed.latitude,
        longitude: observed.longitude,
      },
      distance_m,
      source,
      reason: corrected
        ? "pin_still_far_after_correction"
        : "pin_far_from_target",
    },
  };
}

export function pickTargetLocation(listing) {
  const loc =
    listing?.location && typeof listing.location === "object"
      ? listing.location
      : null;
  if (!loc) return null;
  const latitude = Number(loc.latitude ?? loc.lat);
  const longitude = Number(loc.longitude ?? loc.lng ?? loc.lon);
  if (!isUsableLatLng(latitude, longitude)) return null;
  const source =
    typeof loc.source === "string" && loc.source.trim()
      ? loc.source.trim()
      : "listing.location";
  return { latitude, longitude, source };
}
