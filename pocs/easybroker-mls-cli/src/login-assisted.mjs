import "dotenv/config";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { launchEasyBrokerContext } from "./steps.mjs";

const LOGIN_URL =
  process.env.EASYBROKER_WEB_URL?.trim() ||
  "https://www.easybroker.com/mx/account/authentication/new";

const MLS_URL =
  process.env.EASYBROKER_MLS_URL?.trim() ||
  "https://www.easybroker.com/agent/mls_properties/search/propiedades-en-venta-o-renta?network_search=true";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultStateFile = path.resolve(here, "..", "storage-state.json");
const stateFile =
  process.env.EASYBROKER_MLS_STORAGE_STATE?.trim() || defaultStateFile;

const LOGGED_IN_PATTERNS = [
  /\/manager(?:\/|$|\?)/i,
  /\/agent\/mls_properties/i,
  /\/dashboard/i,
];

function looksLoggedIn(url) {
  return LOGGED_IN_PATTERNS.some((re) => re.test(url));
}

async function hasEasyBrokerSessionCookies(context) {
  const cookies = await context.cookies();
  return cookies.some(
    (cookie) =>
      typeof cookie.domain === "string" &&
      /easybroker\.com$/i.test(cookie.domain) &&
      !/_grecaptcha/i.test(cookie.name ?? "")
  );
}

async function waitForLoggedIn(page, context) {
  const maxMs = Number(process.env.EASYBROKER_ASSISTED_TIMEOUT_MS ?? "600000");
  const deadline = Date.now() + (Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 600_000);
  let lastUrl = "";
  while (Date.now() < deadline) {
    const url = page.url();
    if (url !== lastUrl) {
      console.log(`  · URL actual: ${url}`);
      lastUrl = url;
    }
    if (looksLoggedIn(url) && (await hasEasyBrokerSessionCookies(context))) {
      const body = await page.locator("body").innerText({ timeout: 4_000 }).catch(() => "");
      if (!/403\s*Forbidden|Access denied/i.test(body)) return true;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

let browser;
try {
  console.log(
    [
      "",
      "Abriendo Chromium en modo asistido.",
      "  1) Inicia sesión en EasyBroker manualmente (resuelve el reCAPTCHA si aparece).",
      "  2) Una vez dentro (por ejemplo en /manager o en Bolsa Inmobiliaria), esta ventana detectará",
      "     la sesión y guardará las cookies. No cierres Chromium hasta verlo confirmado en consola.",
      `  3) Cuando estés dentro, puedes navegar manualmente al MLS (${MLS_URL}) si quieres asegurarte`,
      "     de que la sesión cubra esa ruta también.",
      "",
    ].join("\n")
  );
  const session = await launchEasyBrokerContext({ headless: false });
  browser = session.browser;
  const { context, page } = session;
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  console.log(`Esperando login manual en ${page.url()} ...`);
  const ok = await waitForLoggedIn(page, context);
  if (!ok) {
    throw new Error(
      "Tiempo de espera agotado o sesión sin cookies de EasyBroker. Vuelve a ejecutar `npm --prefix pocs/easybroker-mls-cli run poc:login:assisted` y completa el login antes del timeout."
    );
  }
  await mkdir(path.dirname(stateFile), { recursive: true });
  const state = await context.storageState();
  const easyBrokerCookieCount = state.cookies.filter(
    (cookie) =>
      typeof cookie.domain === "string" && /easybroker\.com$/i.test(cookie.domain)
  ).length;
  if (easyBrokerCookieCount === 0) {
    throw new Error(
      "El storage state no contiene cookies de easybroker.com. No se guardó. Reintenta el login asistido."
    );
  }
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
  console.log(
    JSON.stringify(
      {
        ok: true,
        message: "Sesión guardada.",
        storage_state: stateFile,
        easybroker_cookies: easyBrokerCookieCount,
        hint:
          "Si no estaba ya configurada, agrega EASYBROKER_MLS_STORAGE_STATE en tus variables de entorno apuntando a esta ruta para que el resto del sistema la use.",
      },
      null,
      2
    )
  );
} catch (e) {
  console.log(
    JSON.stringify({ ok: false, error: e?.message ?? String(e) }, null, 2)
  );
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
