import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const AVACLICK_STATES_CATALOG = "avaclick_estados.json";

export type AvaclickCredentials = {
  apiUrl: string;
  companyName: string;
  email: string;
  password: string;
  source: "account" | "env";
};

export type AvaclickValuationInput = {
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  property_type: "house" | "condo_house" | "condo_apartment";
  latitude?: number;
  longitude?: number;
  state_name?: string;
  municipality_name?: string;
  neighborhood_name?: string;
  zip_code?: string;
  street?: string;
  lot?: string;
  block?: string;
  interior_number?: string;
  exterior_number?: string;
  land_area_m2?: number;
  construction_area_m2: number;
  has_elevator?: boolean;
  apartment_floor?: number;
  age_years?: number;
  parking_spaces?: number;
  bedrooms?: number;
  full_bathrooms?: number;
  half_bathrooms?: number;
  floors?: number;
  conservation?: "new" | "very_good" | "good" | "regular" | "bad";
  private_amenities?: string[];
  common_amenities?: string[];
};

type AvaclickResultError =
  | "pending_vendor_followup"
  | "validation_error"
  | "auth_error"
  | "quota_error"
  | "provider_error"
  | "unsupported_property_type";

export type AvaclickValuationResult =
  | {
      ok: true;
      status: "success";
      source: "avaclick";
      sale_average_mxn: number | null;
      sale_min_mxn: number | null;
      sale_max_mxn: number | null;
      rent_average_mxn: number | null;
      rent_min_mxn: number | null;
      rent_max_mxn: number | null;
      price_per_m2_min_mxn: number | null;
      price_per_m2_max_mxn: number | null;
      pdf_url: string | null;
      raw: unknown;
      warning?: string;
    }
  | {
      ok: false;
      status: AvaclickResultError;
      message: string;
      retryable: boolean;
      missing_required_fields?: string[];
      raw?: unknown;
      debug?: Record<string, unknown>;
    };

type CatalogState = {
  IdEstado: string;
  Nombre: string;
};

type CatalogMunicipality = {
  IdMunicipio: string;
  NombreMunicipio: string;
  IdEstado: string;
};

type CatalogNeighborhood = {
  IdAsentamientoHumano: string;
  Nombre: string;
  IdMunicipio: string;
};

type CatalogType = {
  IdTipoInmueble: string;
  Nombre: string;
};

type CatalogConservation = {
  IdConservacion: string;
  Nombre: string;
};

type CatalogAmenity = {
  [key: string]: string;
};

type ParsedCatalog<T> = {
  catalogo: string;
  total_registros: number;
  data: T[];
};

type AvaclickCatalogData = {
  states: CatalogState[];
  municipalities: CatalogMunicipality[];
  neighborhoods: CatalogNeighborhood[];
  propertyTypes: CatalogType[];
  conservation: CatalogConservation[];
  privateAmenities: CatalogAmenity[];
  commonAmenities: CatalogAmenity[];
};

const PROPERTY_TYPE_MAP: Record<AvaclickValuationInput["property_type"], string> = {
  house: "CASA HABITACIÓN",
  condo_house: "CASA EN CONDOMINIO",
  condo_apartment: "DPTO EN CONDOMINIO",
};

type AvaclickConservation = NonNullable<AvaclickValuationInput["conservation"]>;

const CONSERVATION_MAP: Record<AvaclickConservation, string> = {
  new: "Nuevo",
  very_good: "Muy Bueno",
  good: "Bueno",
  regular: "Regular",
  bad: "Malo",
};

let catalogDataPromise: Promise<AvaclickCatalogData> | null = null;

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/** Avaclick catalogs use "México" while callers often send "Estado de México". */
function resolveStateCatalogLabel(stateName: string): string {
  const normalized = normalizeText(stateName);
  if (
    normalized === "estado de mexico" ||
    normalized === "edomex" ||
    normalized === "estado de mexico (edomex)"
  ) {
    return "México";
  }
  return stateName;
}

function parseMoneyMx(value?: string | null): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.-]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCatalogJson<T>(raw: string, fileName: string): ParsedCatalog<T> {
  const parsed = JSON.parse(raw) as ParsedCatalog<T>;
  if (!parsed || !Array.isArray(parsed.data)) {
    throw new Error(`Formato inválido en catálogo ${fileName}`);
  }
  return parsed;
}

function resolveAvaclickCatalogDir() {
  const configured = process.env.AVACLICK_CATALOGS_DIR?.trim();
  if (configured) return configured;
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "pocs", "avaclick"),
    path.resolve(cwd, "..", "pocs", "avaclick"),
    path.resolve(cwd, "..", "..", "pocs", "avaclick"),
  ];
  return (
    candidates.find((candidate) =>
      existsSync(path.join(candidate, AVACLICK_STATES_CATALOG))
    ) ?? candidates[0]
  );
}

async function loadAvaclickCatalogs(): Promise<AvaclickCatalogData> {
  if (catalogDataPromise) return catalogDataPromise;
  catalogDataPromise = (async () => {
    const baseDir = resolveAvaclickCatalogDir();
    const [
      statesRaw,
      municipalitiesRaw,
      neighborhoodsRaw,
      propertyTypesRaw,
      conservationRaw,
      privateAmenitiesRaw,
      commonAmenitiesRaw,
    ] = await Promise.all([
      readFile(path.join(baseDir, "avaclick_estados.json"), "utf8"),
      readFile(path.join(baseDir, "avaclick_municipios.json"), "utf8"),
      readFile(path.join(baseDir, "avaclick_colonias.json"), "utf8"),
      readFile(path.join(baseDir, "avaclick_tipos_inmueble.json"), "utf8"),
      readFile(path.join(baseDir, "avaclick_conservacion.json"), "utf8"),
      readFile(path.join(baseDir, "avaclick_amenidades_privativas.json"), "utf8"),
      readFile(path.join(baseDir, "avaclick_amenidades_comunes.json"), "utf8"),
    ]);
    return {
      states: parseCatalogJson<CatalogState>(statesRaw, "avaclick_estados.json").data,
      municipalities: parseCatalogJson<CatalogMunicipality>(
        municipalitiesRaw,
        "avaclick_municipios.json"
      ).data,
      neighborhoods: parseCatalogJson<CatalogNeighborhood>(
        neighborhoodsRaw,
        "avaclick_colonias.json"
      ).data,
      propertyTypes: parseCatalogJson<CatalogType>(
        propertyTypesRaw,
        "avaclick_tipos_inmueble.json"
      ).data,
      conservation: parseCatalogJson<CatalogConservation>(
        conservationRaw,
        "avaclick_conservacion.json"
      ).data,
      privateAmenities: parseCatalogJson<CatalogAmenity>(
        privateAmenitiesRaw,
        "avaclick_amenidades_privativas.json"
      ).data,
      commonAmenities: parseCatalogJson<CatalogAmenity>(
        commonAmenitiesRaw,
        "avaclick_amenidades_comunes.json"
      ).data,
    };
  })();
  return catalogDataPromise;
}

function mapCatalogIdByName(
  rows: Array<Record<string, string>>,
  idKey: string,
  labelKeys: string[],
  expectedLabel: string
): number | null {
  const target = normalizeText(expectedLabel);
  if (!target) return null;
  const match = rows.find((row) =>
    labelKeys.some((key) => normalizeText(row[key]) === target)
  );
  if (!match) return null;
  const id = Number(match[idKey]);
  return Number.isFinite(id) ? id : null;
}

function mapAmenityIds(
  requested: string[] | undefined,
  catalogRows: CatalogAmenity[],
  idKey: string,
  labelKey: string
): number[] {
  const requestedValues = (requested ?? [])
    .map((value) => normalizeText(value))
    .filter(Boolean);
  if (requestedValues.length === 0) return [];
  const ids = new Set<number>();
  for (const item of requestedValues) {
    for (const row of catalogRows) {
      if (normalizeText(row[labelKey]) === item) {
        const parsed = Number(row[idKey]);
        if (Number.isFinite(parsed)) ids.add(parsed);
      }
    }
  }
  return [...ids].sort((a, b) => a - b);
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function fallbackZeroOrNumber(value: number | null): number {
  return value != null && Number.isFinite(value) ? value : 0;
}

function hasValidCoordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) > 0.000001
  );
}

function hasAnyAvaclickCharacteristic(input: AvaclickValuationInput) {
  return (
    input.age_years != null ||
    input.parking_spaces != null ||
    input.bedrooms != null ||
    input.full_bathrooms != null ||
    input.half_bathrooms != null ||
    input.floors != null ||
    input.conservation != null
  );
}

function validateAvaclickMinimumInput(input: AvaclickValuationInput) {
  const missing: string[] = [];
  const street = typeof input.street === "string" ? input.street.trim() : "";
  const customerName =
    typeof input.customer_name === "string" ? input.customer_name.trim() : "";
  const customerEmail =
    typeof input.customer_email === "string" ? input.customer_email.trim() : "";
  const customerPhone =
    typeof input.customer_phone === "string" ? input.customer_phone.trim() : "";
  const stateName =
    typeof input.state_name === "string" ? input.state_name.trim() : "";
  const municipalityName =
    typeof input.municipality_name === "string"
      ? input.municipality_name.trim()
      : "";
  const neighborhoodName =
    typeof input.neighborhood_name === "string"
      ? input.neighborhood_name.trim()
      : "";

  if (!customerName) missing.push("customer_name");
  if (!customerEmail) missing.push("customer_email");
  if (!customerPhone) missing.push("customer_phone");
  if (!hasValidCoordinate(input.latitude)) missing.push("latitude");
  if (!hasValidCoordinate(input.longitude)) missing.push("longitude");
  if (!street) missing.push("street");
  if (!stateName) missing.push("state_name");
  if (!municipalityName) missing.push("municipality_name");
  if (!neighborhoodName) missing.push("neighborhood_name");
  if (!Number.isFinite(input.construction_area_m2)) {
    missing.push("construction_area_m2");
  }
  if (
    (input.property_type === "house" || input.property_type === "condo_house") &&
    !Number.isFinite(input.land_area_m2)
  ) {
    missing.push("land_area_m2");
  }
  if (!hasAnyAvaclickCharacteristic(input)) {
    missing.push("characteristics_at_least_one");
  }
  return missing;
}

function normalizeApiErrorMessage(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function mapAvaclickError(
  message: string,
  raw: unknown
): Exclude<AvaclickValuationResult, { ok: true }> {
  const normalized = normalizeText(message);
  if (normalized.includes("maximo 72 horas")) {
    return {
      ok: false,
      status: "pending_vendor_followup",
      message,
      retryable: false,
      raw,
    };
  }
  if (normalized.includes("alcanzo el limite")) {
    return {
      ok: false,
      status: "quota_error",
      message,
      retryable: false,
      raw,
    };
  }
  if (normalized.includes("no tienes acceso")) {
    return {
      ok: false,
      status: "auth_error",
      message,
      retryable: false,
      raw,
    };
  }
  if (
    normalized.includes("superficie de construccion") ||
    normalized.includes("registrar un valor valido")
  ) {
    return {
      ok: false,
      status: "validation_error",
      message,
      retryable: false,
      raw,
    };
  }
  if (normalized.includes("error inesperado") || normalized === "ocurrio un error") {
    return {
      ok: false,
      status: "provider_error",
      message,
      retryable: true,
      raw,
    };
  }
  return {
    ok: false,
    status: "provider_error",
    message: message || "Respuesta de Avaclick no reconocida.",
    retryable: false,
    raw,
  };
}

function responseErrorMessage(payload: unknown): string {
  if (typeof payload !== "object" || payload == null) return "";
  const data = payload as Record<string, unknown>;
  const nestedA = data.retornarerror as Record<string, unknown> | undefined;
  const nestedB = data.retornarError as Record<string, unknown> | undefined;
  return normalizeApiErrorMessage(nestedA?.Mensaje ?? nestedB?.Mensaje ?? data.message ?? "");
}

function normalizeAvaclickResponse(payload: unknown): AvaclickValuationResult {
  const message = responseErrorMessage(payload);
  if (message) return mapAvaclickError(message, payload);

  if (typeof payload !== "object" || payload == null) {
    return {
      ok: false,
      status: "provider_error",
      message: "Respuesta de Avaclick no es JSON válido.",
      retryable: false,
      raw: payload,
    };
  }
  const data = payload as Record<string, unknown>;
  const retornar = data.retornar as Record<string, unknown> | undefined;
  const success = retornar?.Success === true;
  const avaluo = retornar?.Avaluo as Record<string, unknown> | undefined;

  if (success && avaluo) {
    return {
      ok: true,
      status: "success",
      source: "avaclick",
      sale_average_mxn: parseMoneyMx(String(avaluo.PrecioVentaPromedioMx ?? "")),
      sale_min_mxn: parseMoneyMx(String(avaluo.PrecioVentaMinimo ?? "")),
      sale_max_mxn: parseMoneyMx(String(avaluo.PrecioVentaMaximo ?? "")),
      rent_average_mxn: parseMoneyMx(String(avaluo.PrecioRentaPromedioMx ?? "")),
      rent_min_mxn: parseMoneyMx(String(avaluo.PrecioRentaMinima ?? "")),
      rent_max_mxn: parseMoneyMx(String(avaluo.PrecioRentaMaxima ?? "")),
      price_per_m2_min_mxn: parseMoneyMx(String(avaluo.PrecioMetroCuadradoMinimo ?? "")),
      price_per_m2_max_mxn: parseMoneyMx(String(avaluo.PrecioMetroCuadradoMaximo ?? "")),
      pdf_url:
        typeof avaluo.RutaPdf === "string" && avaluo.RutaPdf.trim()
          ? avaluo.RutaPdf.trim()
          : null,
      raw: payload,
      warning:
        "Opinión digital de valor (no avalúo legal, fiscal, bancario o judicial).",
    };
  }

  return {
    ok: false,
    status: "provider_error",
    message: "Respuesta de Avaclick no reconocida.",
    retryable: false,
    raw: payload,
  };
}

function shouldUseCommonAmenities(propertyType: AvaclickValuationInput["property_type"]) {
  return propertyType === "condo_house" || propertyType === "condo_apartment";
}

async function buildAvaclickPayload(
  input: AvaclickValuationInput,
  creds: AvaclickCredentials
) {
  const stateName = input.state_name ?? "";
  const municipalityName = input.municipality_name ?? "";
  const neighborhoodName = input.neighborhood_name ?? "";
  const streetName = input.street ?? "";
  const customerName = input.customer_name ?? "";
  const customerEmail = input.customer_email ?? "";
  const customerPhoneText = input.customer_phone ?? "";
  const zipText = input.zip_code ?? "";
  const catalogs = await loadAvaclickCatalogs();
  const stateCatalogLabel = resolveStateCatalogLabel(stateName);
  const stateId = mapCatalogIdByName(
    catalogs.states as unknown as Array<Record<string, string>>,
    "IdEstado",
    ["Nombre"],
    stateCatalogLabel
  );
  const municipalityCandidates =
    stateId != null
      ? catalogs.municipalities.filter(
          (municipality) => Number(municipality.IdEstado) === stateId
        )
      : catalogs.municipalities;
  const municipalityId = mapCatalogIdByName(
    municipalityCandidates as unknown as Array<Record<string, string>>,
    "IdMunicipio",
    ["NombreMunicipio"],
    municipalityName
  );
  const neighborhoodCandidates =
    municipalityId != null
      ? catalogs.neighborhoods.filter(
          (neighborhood) => Number(neighborhood.IdMunicipio) === municipalityId
        )
      : catalogs.neighborhoods;
  const neighborhoodId = mapCatalogIdByName(
    neighborhoodCandidates as unknown as Array<Record<string, string>>,
    "IdAsentamientoHumano",
    ["Nombre"],
    neighborhoodName
  );

  const propertyTypeLabel = PROPERTY_TYPE_MAP[input.property_type];
  const propertyTypeId = mapCatalogIdByName(
    catalogs.propertyTypes as unknown as Array<Record<string, string>>,
    "IdTipoInmueble",
    ["Nombre"],
    propertyTypeLabel
  );
  if (propertyTypeId == null) {
    throw new Error(`No se encontró Tipo_Inmueble para "${propertyTypeLabel}"`);
  }

  const conservationLabel = input.conservation
    ? CONSERVATION_MAP[input.conservation]
    : undefined;
  const conservationId = conservationLabel
    ? mapCatalogIdByName(
        catalogs.conservation as unknown as Array<Record<string, string>>,
        "IdConservacion",
        ["Nombre"],
        conservationLabel
      )
    : null;
  if (conservationLabel && conservationId == null) {
    throw new Error(`No se encontró Conservación para "${conservationLabel}"`);
  }

  const commonAmenities = shouldUseCommonAmenities(input.property_type)
    ? mapAmenityIds(
        input.common_amenities,
        catalogs.commonAmenities,
        "IdAmenidadesComunes",
        "Amenidades Comunes"
      )
    : [];
  const privateAmenities = mapAmenityIds(
    input.private_amenities,
    catalogs.privateAmenities,
    "IdAmenidadesPrivativas",
    "Amenidades Privativas"
  );
  if (input.property_type === "condo_apartment" && input.has_elevator) {
    if (!commonAmenities.includes(6)) commonAmenities.push(6);
  }

  const customerPhoneDigits = digitsOnly(customerPhoneText);
  const customerPhone = Number(customerPhoneDigits || "0");
  const zipDigits = digitsOnly(zipText);
  const zipCode = Number(zipDigits || "0");

  const payload = {
    Empresa: {
      NombreEmpresa: creds.companyName,
      Correo: creds.email,
      Password: creds.password,
    },
    Cliente: {
      NombreCliente: customerName,
      Correo: customerEmail,
      Telefono: Number.isFinite(customerPhone) ? customerPhone : 0,
    },
    Inmueble: {
      Latitud: Number(input.latitude),
      Longitud: Number(input.longitude),
      EstadoId: 0,
      MunicipioId: 0,
      ColoniaId: 0,
      EstadoNombre: stateName,
      MunicipioNombre: municipalityName,
      ColoniaNombre: neighborhoodName,
      CP: Number.isFinite(zipCode) ? zipCode : 0,
      Calle: streetName,
      Lote: input.lot ?? "",
      Manzana: input.block ?? "",
      NumeroInterior: input.interior_number ?? "",
      NumeroExterior: input.exterior_number ?? "",
      TipoInmueble: propertyTypeId,
      Terreno:
        input.property_type === "condo_apartment"
          ? 0
          : Number.isFinite(input.land_area_m2 ?? NaN)
            ? Number(input.land_area_m2)
            : 0,
      Construccion: Number(input.construction_area_m2),
      Elevador: input.has_elevator ? 1 : 0,
      PisoDepartamento:
        input.property_type === "condo_apartment"
          ? Number(input.apartment_floor ?? 0)
          : 0,
      Fachada: "",
    },
    Caracteristicas: Object.fromEntries(
      [
        ["Edad", input.age_years],
        ["Cochera", input.parking_spaces],
        ["Recamara", input.bedrooms],
        ["Banios", input.full_bathrooms],
        ["MedioBanio", input.half_bathrooms],
        ["NumeroPisos", input.floors],
        ["Conservacion", conservationId],
      ].filter(([, value]) => value !== undefined && value !== null)
    ),
    Amenidades: {
      amenidadPrivativas: privateAmenities,
      amenidadComunes: commonAmenities,
    },
  };

  const debug = {
    catalog_ids: {
      state_id: fallbackZeroOrNumber(stateId),
      municipality_id: fallbackZeroOrNumber(municipalityId),
      neighborhood_id: fallbackZeroOrNumber(neighborhoodId),
      property_type_id: propertyTypeId,
      conservation_id: conservationId ?? null,
    },
    request_payload_without_credentials: {
      Cliente: payload.Cliente,
      Inmueble: payload.Inmueble,
      Caracteristicas: payload.Caracteristicas,
      Amenidades: payload.Amenidades,
    },
  };

  return { payload, debug };
}

async function callAvaclick(
  payload: unknown,
  creds: AvaclickCredentials,
  debug?: Record<string, unknown>
): Promise<AvaclickValuationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(creds.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: "provider_error",
        message: `Avaclick HTTP ${response.status}`,
        retryable: response.status >= 500,
        raw: json,
        debug,
      };
    }
    const normalized = normalizeAvaclickResponse(json);
    return normalized.ok ? normalized : { ...normalized, debug };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: "provider_error",
      message: `No se pudo contactar Avaclick: ${message}`,
      retryable: true,
      debug,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAvaclickValuation(
  input: AvaclickValuationInput,
  creds: AvaclickCredentials
): Promise<AvaclickValuationResult> {
  if (input.property_type !== "house" && input.property_type !== "condo_house" && input.property_type !== "condo_apartment") {
    return {
      ok: false,
      status: "unsupported_property_type",
      message: "Avaclick solo soporta casa y departamento en condominio.",
      retryable: false,
    };
  }
  const missingRequiredFields = validateAvaclickMinimumInput(input);
  if (missingRequiredFields.length > 0) {
    return {
      ok: false,
      status: "validation_error",
      message:
        "Faltan datos mínimos para ejecutar Avaclick. Completa los campos requeridos y vuelve a intentar.",
      retryable: false,
      missing_required_fields: missingRequiredFields,
      debug: {
        minimum_requirements_notes: {
          coordinates:
            "latitude/longitude deben ser coordenadas válidas (no 0).",
          characteristics:
            "Avaclick requiere al menos un atributo en Caracteristicas (por ejemplo Edad o Conservacion).",
          property_type_land_area:
            "house/condo_house requieren land_area_m2.",
        },
      },
    };
  }
  const { payload, debug } = await buildAvaclickPayload(input, creds);
  const catalogIds = debug.catalog_ids as Record<string, unknown>;
  if (catalogIds.property_type_id === 0 || catalogIds.property_type_id == null) {
    return {
      ok: false,
      status: "validation_error",
      message: `No se encontró Tipo_Inmueble para "${input.property_type}".`,
      retryable: false,
      debug,
    };
  }

  const firstAttempt = await callAvaclick(payload, creds, debug);
  if (!firstAttempt.ok && firstAttempt.retryable) {
    return callAvaclick(payload, creds, debug);
  }
  return firstAttempt;
}

export async function testAvaclickCredentials(
  creds: AvaclickCredentials
): Promise<{ ok: true } | { ok: false; error: string }> {
  const probeInput: AvaclickValuationInput = {
    customer_name: "Prueba Avaclick",
    customer_email: "cliente@correo.com",
    customer_phone: "3330000000",
    property_type: "condo_house",
    latitude: 19.270469527143423,
    longitude: -99.62444830066556,
    state_name: "Estado de México",
    municipality_name: "Metepec",
    neighborhood_name: "San Carlos",
    zip_code: "52159",
    street: "San Carlos",
    exterior_number: "710",
    land_area_m2: 1095,
    construction_area_m2: 545,
    age_years: 20,
    parking_spaces: 1,
    bedrooms: 1,
    full_bathrooms: 1,
    half_bathrooms: 1,
    floors: 1,
    conservation: "new",
    private_amenities: [],
    common_amenities: [],
  };

  const result = await getAvaclickValuation(probeInput, creds);
  if (result.ok) return { ok: true };
  if (result.status === "auth_error") {
    return { ok: false, error: result.message };
  }
  if (result.status === "quota_error") {
    return { ok: true };
  }
  if (result.status === "validation_error" || result.status === "pending_vendor_followup") {
    return { ok: true };
  }
  if (result.retryable) {
    return { ok: false, error: result.message };
  }
  return { ok: false, error: result.message };
}
