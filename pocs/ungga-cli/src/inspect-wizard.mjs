/**
 * Inspección del wizard "Nueva propiedad" de Ungga. Genera un dump JSON con
 * los campos accesibles de cada pestaña para diseñar selectores específicos
 * en publishListingDraft sin adivinar.
 *
 * Uso (dentro de pocs/ungga-cli):
 *   node src/inspect-wizard.mjs            -> imprime JSON en stdout
 *   node src/inspect-wizard.mjs out.json   -> guarda JSON en out.json
 */
import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { fillGeneralTab, loginToUngga, closeSession } from "./steps.mjs";

const TAB_NAMES = ["GENERAL", "DETALLES", "MEDIA", "OPERACIÓN", "PUBLICAR"];

async function readFixture() {
  const path = process.env.UNGGA_CLI_INSPECT_FIXTURE?.trim();
  if (!path) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.error(`Could not read fixture ${path}: ${e?.message ?? e}`);
    return null;
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

async function dumpFields(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!(el instanceof Element)) return false;
      const rect = el.getClientRects();
      return Boolean(rect.length) && getComputedStyle(el).visibility !== "hidden";
    }
    function labelFor(el) {
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl) return lbl.innerText.trim();
      }
      const wrapping = el.closest("label");
      if (wrapping) return wrapping.innerText.trim();
      const aria = el.getAttribute("aria-label");
      if (aria) return aria.trim();
      const placeholder = el.getAttribute("placeholder");
      if (placeholder) return `[placeholder] ${placeholder.trim()}`;
      const previous = el.previousElementSibling;
      if (previous && previous.matches("label,span,div")) return previous.innerText.trim();
      const parentText = el.parentElement?.innerText?.split("\n")[0]?.trim();
      return parentText ?? null;
    }
    function descriptor(el) {
      return {
        tag: el.tagName,
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        id: el.id || null,
        placeholder: el.getAttribute("placeholder"),
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        label: labelFor(el),
        options:
          el.tagName === "SELECT"
            ? [...el.querySelectorAll("option")].map((o) => ({
                value: o.value,
                label: o.textContent?.trim(),
              }))
            : null,
      };
    }
    const fields = [...document.querySelectorAll("input,select,textarea")]
      .filter(visible)
      .map(descriptor);
    const headings = [...document.querySelectorAll("h1,h2,h3,h4")]
      .filter(visible)
      .map((el) => el.innerText.trim())
      .filter(Boolean);
    const tabs = [...document.querySelectorAll('[role="tab"], button')]
      .filter(visible)
      .map((el) => ({ text: el.innerText.trim(), role: el.getAttribute("role") }))
      .filter((x) => x.text.length > 0 && x.text.length < 40);
    const buttons = [...document.querySelectorAll("button")]
      .filter(visible)
      .map((el) => ({
        text: el.innerText.trim(),
        type: el.getAttribute("type"),
        ariaLabel: el.getAttribute("aria-label"),
      }))
      .filter((x) => x.text || x.ariaLabel);
    return { url: location.href, headings, tabs, fields, buttons };
  });
}

async function collectValidationErrors(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!(el instanceof Element)) return false;
      const rect = el.getClientRects();
      return Boolean(rect.length) && getComputedStyle(el).visibility !== "hidden";
    }
    const selectors = [
      '[role="alert"]',
      "[aria-invalid='true']",
      ".error",
      ".Mui-error",
      ".text-red-500",
      ".text-red-600",
      ".text-red-700",
      ".text-error",
    ];
    const seen = new Set();
    const found = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!visible(el)) continue;
        const text = el.innerText?.trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        found.push({ selector: sel, text });
      }
    }
    return found;
  });
}

async function clickContinue(page) {
  const button = page.getByRole("button", { name: /^continuar$/i }).first();
  if ((await button.count()) === 0) return false;
  const disabled = await button.evaluate((el) => {
    const candidate = el.closest("button") ?? el;
    return Boolean(
      candidate.disabled ||
        candidate.getAttribute("disabled") !== null ||
        candidate.getAttribute("aria-disabled") === "true"
    );
  });
  if (disabled) return false;
  await button.click().catch(() => {});
  return true;
}

const startedAt = Date.now();
const metrics = [];
let session;

try {
  const baseUrl = requireEnv("UNGGA_STAGING_URL");
  const email = requireEnv("UNGGA_STAGING_EMAIL");
  const password = requireEnv("UNGGA_STAGING_PASSWORD");
  const explicitPath = process.env.UNGGA_CLI_INSPECT_PATH?.trim();

  session = await loginToUngga({ baseUrl, email, password }, metrics);
  const origin = new URL(session.page.url()).origin;
  const target = explicitPath
    ? /^https?:\/\//i.test(explicitPath)
      ? explicitPath
      : `${origin}${explicitPath.startsWith("/") ? "" : "/"}${explicitPath}`
    : `${origin}/app/propiedades/nueva`;

  await session.page.goto(target, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await session.page.waitForTimeout(800);

  const tabs = {};
  tabs.initial = await dumpFields(session.page);

  const fixture = await readFixture();
  let filledFields = null;
  if (fixture) {
    const general = await fillGeneralTab(session.page, fixture);
    filledFields = general?.filled ?? general;
    await session.page.waitForTimeout(500);
    tabs.GENERAL_FILLED = await dumpFields(session.page);
  }

  for (const tabName of TAB_NAMES.slice(1)) {
    const advanced = await clickContinue(session.page);
    if (!advanced) {
      tabs[tabName] = { advanced: false, reason: "no enabled Continuar button" };
      break;
    }
    await session.page.waitForTimeout(1500);
    const validationErrors = await collectValidationErrors(session.page);
    const safe = tabName.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
    await session.page
      .screenshot({ path: `artifacts/inspect-after-${safe}.png`, fullPage: true })
      .catch(() => {});
    tabs[tabName] = {
      advanced: true,
      validationErrors,
      ...(await dumpFields(session.page)),
    };
    if (validationErrors.length > 0) break;
  }

  const report = {
    ok: true,
    duration_ms: Date.now() - startedAt,
    target,
    filled_general: filledFields,
    tabs,
    metrics,
  };
  const outPath = process.argv[2];
  const json = JSON.stringify(report, null, 2);
  if (outPath) await writeFile(outPath, json, "utf8");
  console.log(json);
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
