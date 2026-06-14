// This file configures the initialization of Sentry on the client.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

const isProduction = process.env.NODE_ENV === "production";

// Sentry (especially Session Replay) records DOM mutations on the main thread.
// In development this causes severe typing lag and memory pressure when the
// /monitoring tunnel cannot flush. Disable the SDK entirely in dev.
if (isProduction) {
  Sentry.init({
    dsn: "https://77589a6cc582461c8733837d211a0d80@o4511276262293504.ingest.us.sentry.io/4511276310724608",

    integrations: [Sentry.replayIntegration()],

    tracesSampleRate: 1,
    enableLogs: true,

    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,

    sendDefaultPii: true,
  });
}

export const onRouterTransitionStart = isProduction
  ? Sentry.captureRouterTransitionStart
  : () => {};
