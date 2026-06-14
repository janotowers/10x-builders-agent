// This file configures the initialization of Sentry for edge features.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

const isProduction = process.env.NODE_ENV === "production";

if (isProduction) {
  Sentry.init({
    dsn: "https://77589a6cc582461c8733837d211a0d80@o4511276262293504.ingest.us.sentry.io/4511276310724608",

    tracesSampleRate: 1,
    enableLogs: true,
    sendDefaultPii: true,
  });
}
