import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Prioriza IPv4 al resolver DNS. Algunos entornos (dev/CI) tienen IPv6
    // roto/bloqueado hacia api.telegram.org: Node intenta la IPv6 primero,
    // se cuelga ~10s y devuelve ConnectTimeoutError. Forzar ipv4first evita
    // ese estancamiento y hace que los fetch salientes (Telegram, etc.) usen
    // la ruta IPv4 que sí funciona.
    try {
      const dns = await import("node:dns");
      dns.setDefaultResultOrder("ipv4first");
    } catch (error) {
      console.warn("[instrumentation] no se pudo forzar ipv4first DNS:", error);
    }

    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
