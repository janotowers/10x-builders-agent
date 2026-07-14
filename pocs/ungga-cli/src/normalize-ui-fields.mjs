/**
 * Map agent/internal enum values to Ungga UI option labels.
 * Agent tools often send English codes (good, MX, existing); the wizard needs Spanish labels.
 */

function normKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const CONDITION_MAP = {
  // "Nuevo" belongs to antigüedad in Ungga, not ESTADO DE LA PROPIEDAD.
  new: "Bueno",
  nuevo: "Bueno",
  very_good: "Muy bueno",
  muy_bueno: "Muy bueno",
  "muy bueno": "Muy bueno",
  excellent: "Excelente",
  excelente: "Excelente",
  good: "Bueno",
  bueno: "Bueno",
  regular: "Regular",
  fair: "Regular",
  bad: "Malo",
  malo: "Malo",
  poor: "Malo",
};

const AGE_RANGE_MAP = {
  unknown: "1-5 años",
  new: "A estrenar",
  nuevo: "A estrenar",
  "a estrenar": "A estrenar",
  "0-1": "Menos de 1 año",
  "menos de 1 ano": "Menos de 1 año",
  "0-5": "1-5 años",
  "0-5 anos": "1-5 años",
  "0-5 años": "1-5 años",
  "menos de 5 anos": "1-5 años",
  "menos de 5 años": "1-5 años",
  "1-5": "1-5 años",
  "1-5 anos": "1-5 años",
  "1-5 años": "1-5 años",
  "5-10": "5-10 años",
  "5-10 anos": "5-10 años",
  "5-10 años": "5-10 años",
  "10-20": "10-20 años",
  "10-20 anos": "10-20 años",
  "10-20 años": "10-20 años",
  "20+": "Más de 20 años",
  "mas de 20 anos": "Más de 20 años",
  "más de 20 años": "Más de 20 años",
};

const COUNTRY_MAP = {
  mx: "México",
  mex: "México",
  mexico: "México",
  "méxico": "México",
};

const LOCATION_TYPE_MAP = {
  house: "Residencial",
  home: "Residencial",
  residential: "Residencial",
  residencial: "Residencial",
  apartment: "Residencial",
  departamento: "Residencial",
  commercial: "Comercial",
  comercial: "Comercial",
};

const CURRENT_STATUS_MAP = {
  existing: "Habitable",
  habitable: "Habitable",
  occupied: "Habitable",
  vacant: "Habitable",
  under_construction: "En construcción",
  "en construccion": "En construcción",
  "en construcción": "En construcción",
  remodel: "En remodelación",
  remodeling: "En remodelación",
  "en remodelacion": "En remodelación",
  "en remodelación": "En remodelación",
};

const LAND_UNIT_MAP = {
  m2: "m²",
  "m^2": "m²",
  sqm: "m²",
  "m²": "m²",
};

function mapOrPassthrough(map, value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const key = normKey(raw);
  if (Object.prototype.hasOwnProperty.call(map, key)) {
    return map[key];
  }
  if (Object.prototype.hasOwnProperty.call(map, raw.toLowerCase())) {
    return map[raw.toLowerCase()];
  }
  return raw;
}

export function normalizeUnggaUiFields(input) {
  const next = { ...(input && typeof input === "object" ? input : {}) };

  const condition = mapOrPassthrough(CONDITION_MAP, next.condition);
  next.condition = condition;

  const age = mapOrPassthrough(AGE_RANGE_MAP, next.age_range);
  next.age_range = age;

  const country = mapOrPassthrough(COUNTRY_MAP, next.country);
  next.country = country;

  const locationType = mapOrPassthrough(LOCATION_TYPE_MAP, next.location_type);
  next.location_type = locationType;

  const currentStatus = mapOrPassthrough(CURRENT_STATUS_MAP, next.current_status);
  next.current_status = currentStatus;

  const landUnit = mapOrPassthrough(LAND_UNIT_MAP, next.land_unit);
  next.land_unit = landUnit || "m²";

  return next;
}
