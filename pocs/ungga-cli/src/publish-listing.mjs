import "dotenv/config";
import { readFile } from "node:fs/promises";
import {
  loginToUngga,
  publishListingDraft,
  publishExistingDraft,
  closeSession,
} from "./steps.mjs";
import { lastMeaningfulStep } from "./prepare-draft-contract.mjs";
import { normalizeUnggaUiFields } from "./normalize-ui-fields.mjs";

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

function resolvePropertyId(input) {
  const id =
    typeof input.ungga_property_id === "string" ? input.ungga_property_id.trim() : "";
  if (id) return id;
  const url = typeof input.draft_url === "string" ? input.draft_url.trim() : "";
  if (!url) return null;
  const m = url.match(/\/propiedades\/([^/?#]+)/i);
  if (!m?.[1]) return null;
  const segment = m[1];
  if (segment === "nueva" || segment === "new") return null;
  return segment;
}

function normalizeListing(input) {
  const ui = normalizeUnggaUiFields(input);
  const title = String(ui.title ?? "").trim();
  const operation = String(ui.operation ?? "").trim();
  const propertyType = String(ui.property_type ?? "").trim();
  const price = Number(ui.price);
  if (!title) throw new Error("Missing required input: title");
  if (!operation) throw new Error("Missing required input: operation");
  if (!propertyType) throw new Error("Missing required input: property_type");
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Invalid required input: price must be positive");
  }
  return {
    title,
    description:
      typeof ui.description === "string" ? ui.description.trim() : "",
    operation,
    property_type: propertyType,
    price,
    currency:
      typeof ui.currency === "string" && ui.currency.trim()
        ? ui.currency.trim()
        : "MXN",
    construction_m2:
      Number.isFinite(Number(ui.construction_m2)) && Number(ui.construction_m2) > 0
        ? Number(ui.construction_m2)
        : null,
    land_m2:
      Number.isFinite(Number(ui.land_m2)) && Number(ui.land_m2) > 0
        ? Number(ui.land_m2)
        : null,
    land_unit:
      typeof ui.land_unit === "string" && ui.land_unit.trim()
        ? ui.land_unit.trim()
        : "m²",
    condition:
      typeof ui.condition === "string" && ui.condition.trim()
        ? ui.condition.trim()
        : "Bueno",
    age_range:
      typeof ui.age_range === "string" && ui.age_range.trim()
        ? ui.age_range.trim()
        : "1-5 años",
    country:
      typeof ui.country === "string" && ui.country.trim()
        ? ui.country.trim()
        : null,
    address:
      typeof ui.address === "string" && ui.address.trim()
        ? ui.address.trim()
        : null,
    location:
      ui.location && typeof ui.location === "object" ? ui.location : {},
    bedrooms: numberOrNull(ui.bedrooms),
    bathrooms_full: numberOrNull(ui.bathrooms_full),
    bathrooms_half: numberOrNull(ui.bathrooms_half),
    parking_spaces: numberOrNull(ui.parking_spaces),
    covered_parking: Boolean(ui.covered_parking),
    floor:
      ui.floor != null && String(ui.floor).trim()
        ? String(ui.floor).trim()
        : null,
    location_type:
      typeof ui.location_type === "string" && ui.location_type.trim()
        ? ui.location_type.trim()
        : null,
    current_status:
      typeof ui.current_status === "string" && ui.current_status.trim()
        ? ui.current_status.trim()
        : null,
    amenities: Array.isArray(ui.amenities)
      ? ui.amenities.filter((a) => typeof a === "string" && a.trim())
      : [],
    video_url:
      typeof ui.video_url === "string" && ui.video_url.trim()
        ? ui.video_url.trim()
        : null,
    tour_url:
      typeof ui.tour_url === "string" && ui.tour_url.trim()
        ? ui.tour_url.trim()
        : null,
    operations: normalizeOperations(ui),
    commission_pct: numberOrNull(ui.commission_pct),
    image_urls: Array.isArray(ui.image_urls) ? ui.image_urls : [],
    case_id: typeof ui.case_id === "string" ? ui.case_id : undefined,
  };
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeOperations(input) {
  const topLevelCommission = numberOrNull(input.commission_pct);
  if (Array.isArray(input.operations) && input.operations.length > 0) {
    return input.operations
      .map((op) => {
        const commissionPct =
          numberOrNull(op.commission_pct) ?? topLevelCommission;
        return {
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
          ...(commissionPct != null && commissionPct > 0
            ? { commission_pct: commissionPct }
            : {}),
        };
      })
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
      ...(topLevelCommission != null && topLevelCommission > 0
        ? { commission_pct: topLevelCommission }
        : {}),
    };
    return op.price != null ? [op] : [];
  }
  return [];
}

const startedAt = Date.now();
const metrics = [];
let session;

try {
  const rawInput = await readJsonInput();
  const action =
    typeof rawInput.action === "string" && rawInput.action.trim()
      ? rawInput.action.trim()
      : "prepare_draft";
  const dryRun = envFlag("UNGGA_CLI_DRY_RUN", true);
  const baseUrl = requireEnv("UNGGA_STAGING_URL");
  const email = requireEnv("UNGGA_STAGING_EMAIL");
  const password = requireEnv("UNGGA_STAGING_PASSWORD");
  session = await loginToUngga({ baseUrl, email, password }, metrics);

  let result;
  let mode;
  if (action === "publish_draft") {
    const propertyId = resolvePropertyId(rawInput);
    if (!propertyId) {
      throw new Error(
        "publish_draft requires ungga_property_id or draft_url with /app/propiedades/{GU-ID}"
      );
    }
    result = await publishExistingDraft(
      session.page,
      {
        propertyId,
        dryRun,
        listing: {
          commission_pct:
            typeof rawInput.commission_pct === "number"
              ? rawInput.commission_pct
              : undefined,
          operations: Array.isArray(rawInput.operations)
            ? rawInput.operations
            : undefined,
        },
      },
      metrics
    );
    mode = dryRun ? "publish_dry_run" : "publish_draft";
  } else {
    const listing = normalizeListing(rawInput);
    result = await publishListingDraft(session.page, { listing, dryRun }, metrics);
    mode = dryRun ? "dry_run" : "save_draft";
  }

  const ok = result?.ok === true;
  console.log(
    JSON.stringify(
      {
        ok,
        action,
        mode,
        duration_ms: Date.now() - startedAt,
        last_step: result?.last_step ?? lastMeaningfulStep(metrics),
        result,
        metrics,
      },
      null,
      2
    )
  );
  if (!ok) process.exitCode = 1;
} catch (err) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        duration_ms: Date.now() - startedAt,
        error: err?.message ?? String(err),
        last_step: lastMeaningfulStep(metrics),
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
