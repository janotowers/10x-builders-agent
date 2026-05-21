import "dotenv/config";
import { closeSession, loginToEasyBroker } from "./steps.mjs";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing env ${name}`);
  return value;
}

const metrics = [];
let session;

try {
  session = await loginToEasyBroker(
    {
      loginUrl:
        process.env.EASYBROKER_WEB_URL?.trim() ||
        "https://www.easybroker.com/mx/account/authentication/new",
      email: requireEnv("EASYBROKER_WEB_EMAIL"),
      password: requireEnv("EASYBROKER_WEB_PASSWORD"),
    },
    metrics
  );
  console.log(JSON.stringify({ ok: true, url: session.page.url(), metrics }, null, 2));
} catch (err) {
  console.log(
    JSON.stringify(
      { ok: false, error: err?.message ?? String(err), metrics },
      null,
      2
    )
  );
  process.exitCode = 1;
} finally {
  await closeSession(session);
}
