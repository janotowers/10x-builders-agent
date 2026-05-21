import "dotenv/config";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import {
  closeSession,
  loginToEasyBroker,
  searchMlsProperties,
} from "./steps.mjs";

async function readJsonInput() {
  const argPath = process.argv[2];
  const raw = argPath
    ? await readFile(argPath, "utf8")
    : await new Promise((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
          data += chunk;
        });
        process.stdin.on("end", () => resolve(data));
        process.stdin.on("error", reject);
      });
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

async function hasStorageState() {
  const path = process.env.EASYBROKER_MLS_STORAGE_STATE?.trim() || "storage-state.json";
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeInput(input) {
  return {
    mode:
      input.mode === "closed_deals" || input.tool_id === "easybroker_search_closed_deals"
        ? "closed_deals"
        : "listings",
    mls_url:
      typeof input.mls_url === "string" && input.mls_url.trim()
        ? input.mls_url.trim()
        : process.env.EASYBROKER_MLS_URL?.trim() ||
          "https://www.easybroker.com/agent/mls_properties",
    zona: stringOrNull(input.zona),
    operation: normalizeOperation(input.operation),
    operations: Array.isArray(input.operations)
      ? input.operations.map(normalizeOperation).filter(Boolean)
      : [],
    property_type: stringOrNull(input.property_type),
    property_types: Array.isArray(input.property_types)
      ? input.property_types.filter((v) => typeof v === "string" && v.trim())
      : [],
    min_price: numberOrNull(input.min_price),
    max_price: numberOrNull(input.max_price),
    min_area_m2: numberOrNull(input.min_area_m2),
    max_area_m2: numberOrNull(input.max_area_m2),
    bedrooms: numberOrNull(input.bedrooms),
    min_bedrooms: numberOrNull(input.min_bedrooms),
    bathrooms: numberOrNull(input.bathrooms),
    min_bathrooms: numberOrNull(input.min_bathrooms),
    parking_spaces: numberOrNull(input.parking_spaces),
    min_parking_spaces: numberOrNull(input.min_parking_spaces),
    shared_commission_only: booleanOrFalse(input.shared_commission_only),
    date_from: stringOrNull(input.date_from),
    date_to: stringOrNull(input.date_to),
    limit: Math.min(numberOrNull(input.limit) ?? 20, 50),
  };
}

function normalizeOperation(value) {
  if (value === "sale" || value === "venta") return "sale";
  if (value === "rent" || value === "renta") return "rent";
  return null;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function booleanOrFalse(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return false;
}

const startedAt = Date.now();
const metrics = [];
let session;

try {
  const rawInput = await readJsonInput();
  const input = normalizeInput(rawInput);
  const loginUrl =
    process.env.EASYBROKER_WEB_URL?.trim() ||
    input.mls_url ||
    "https://www.easybroker.com/mx/account/authentication/new";
  const canUseStorage = await hasStorageState();
  const email = process.env.EASYBROKER_WEB_EMAIL?.trim() || (canUseStorage ? "" : requireEnv("EASYBROKER_WEB_EMAIL"));
  const password =
    process.env.EASYBROKER_WEB_PASSWORD?.trim() ||
    (canUseStorage ? "" : requireEnv("EASYBROKER_WEB_PASSWORD"));
  session = await loginToEasyBroker({ loginUrl, email, password }, metrics);
  const result = await searchMlsProperties(session.page, input, metrics);

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: input.mode,
        duration_ms: Date.now() - startedAt,
        result,
        metrics,
      },
      null,
      2
    )
  );
} catch (err) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        duration_ms: Date.now() - startedAt,
        error: err?.message ?? String(err),
        metrics,
      },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await closeSession(session);
}
