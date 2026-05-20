import "dotenv/config";
import { readFile } from "node:fs/promises";
import {
  loginToUngga,
  publishListingDraft,
  closeSession,
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

function envFlag(name, fallback = false) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

function normalizeListing(input) {
  const title = String(input.title ?? "").trim();
  const operation = String(input.operation ?? "").trim();
  const propertyType = String(input.property_type ?? "").trim();
  const price = Number(input.price);
  if (!title) throw new Error("Missing required input: title");
  if (!operation) throw new Error("Missing required input: operation");
  if (!propertyType) throw new Error("Missing required input: property_type");
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Invalid required input: price must be positive");
  }
  return {
    title,
    description:
      typeof input.description === "string" ? input.description.trim() : "",
    operation,
    property_type: propertyType,
    price,
    currency:
      typeof input.currency === "string" && input.currency.trim()
        ? input.currency.trim()
        : "MXN",
    construction_m2:
      Number.isFinite(Number(input.construction_m2)) && Number(input.construction_m2) > 0
        ? Number(input.construction_m2)
        : null,
    land_m2:
      Number.isFinite(Number(input.land_m2)) && Number(input.land_m2) > 0
        ? Number(input.land_m2)
        : null,
    land_unit:
      typeof input.land_unit === "string" && input.land_unit.trim()
        ? input.land_unit.trim()
        : "m²",
    condition:
      typeof input.condition === "string" && input.condition.trim()
        ? input.condition.trim()
        : null,
    age_range:
      typeof input.age_range === "string" && input.age_range.trim()
        ? input.age_range.trim()
        : null,
    country:
      typeof input.country === "string" && input.country.trim()
        ? input.country.trim()
        : null,
    address:
      typeof input.address === "string" && input.address.trim()
        ? input.address.trim()
        : null,
    location:
      input.location && typeof input.location === "object" ? input.location : {},
    bedrooms: numberOrNull(input.bedrooms),
    bathrooms_full: numberOrNull(input.bathrooms_full),
    bathrooms_half: numberOrNull(input.bathrooms_half),
    parking_spaces: numberOrNull(input.parking_spaces),
    covered_parking: Boolean(input.covered_parking),
    floor:
      input.floor != null && String(input.floor).trim()
        ? String(input.floor).trim()
        : null,
    location_type:
      typeof input.location_type === "string" && input.location_type.trim()
        ? input.location_type.trim()
        : null,
    current_status:
      typeof input.current_status === "string" && input.current_status.trim()
        ? input.current_status.trim()
        : null,
    amenities: Array.isArray(input.amenities)
      ? input.amenities.filter((a) => typeof a === "string" && a.trim())
      : [],
    video_url:
      typeof input.video_url === "string" && input.video_url.trim()
        ? input.video_url.trim()
        : null,
    tour_url:
      typeof input.tour_url === "string" && input.tour_url.trim()
        ? input.tour_url.trim()
        : null,
    operations: normalizeOperations(input),
    image_urls: Array.isArray(input.image_urls) ? input.image_urls : [],
    case_id: typeof input.case_id === "string" ? input.case_id : undefined,
  };
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeOperations(input) {
  if (Array.isArray(input.operations) && input.operations.length > 0) {
    return input.operations
      .map((op) => ({
        type:
          op.type === "sale" || op.type === "venta"
            ? "sale"
            : op.type === "rent" || op.type === "renta"
            ? "rent"
            : null,
        price: numberOrNull(op.price),
        currency:
          typeof op.currency === "string" && op.currency.trim()
            ? op.currency.trim()
            : "MXN",
      }))
      .filter((op) => op.type && op.price != null);
  }
  if (input.operation && input.price != null) {
    const op = {
      type:
        input.operation === "sale" || input.operation === "venta" ? "sale" : "rent",
      price: numberOrNull(input.price),
      currency:
        typeof input.currency === "string" && input.currency.trim()
          ? input.currency.trim()
          : "MXN",
    };
    return op.price != null ? [op] : [];
  }
  return [];
}

const startedAt = Date.now();
const metrics = [];
let session;

try {
  const listing = normalizeListing(await readJsonInput());
  const dryRun = envFlag("UNGGA_CLI_DRY_RUN", true);
  const baseUrl = requireEnv("UNGGA_STAGING_URL");
  const email = requireEnv("UNGGA_STAGING_EMAIL");
  const password = requireEnv("UNGGA_STAGING_PASSWORD");
  session = await loginToUngga({ baseUrl, email, password }, metrics);
  const result = await publishListingDraft(
    session.page,
    { listing, dryRun },
    metrics
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: dryRun ? "dry_run" : "save_draft",
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
