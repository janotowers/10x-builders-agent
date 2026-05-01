import dns from "node:dns";
import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

let singleton:
  | MemorySaver
  | ReturnType<typeof PostgresSaver.fromConnString>
  | null = null;
let setupPromise: Promise<void> | null = null;
let postgresFailed = false;
let dnsOrderApplied = false;

/**
 * Force Node's DNS resolver to prefer IPv4 (`A` records) over IPv6 (`AAAA`)
 * when looking up the Postgres host.
 *
 * Why: Supabase pools (port 5432/6543) advertise both A and AAAA. Node's
 * default since 17.x is `verbatim` — it returns whatever DNS sends first,
 * which is often AAAA. Many local dev networks (Windows / WSL / corporate
 * Wi‑Fi / some ISPs) do not actually route IPv6 to AWS, so the connection
 * hangs until `ETIMEDOUT`. Setting `ipv4first` makes Node try the A record
 * first; if that fails it still falls back to AAAA. Production hosts
 * (Vercel, Cloud Run, etc.) tolerate this just fine.
 *
 * Configurable via `CHECKPOINTER_DNS_ORDER`:
 *   - `ipv4first` (default) — try IPv4 first, IPv6 second.
 *   - `verbatim`            — Node 18+ default; returns DNS order as-is.
 *   - `ipv6first`           — explicit IPv6 first (rarely useful).
 *   - `off` / `disabled`    — leave Node's current setting untouched.
 */
function applyDnsResultOrder(): void {
  if (dnsOrderApplied) return;
  dnsOrderApplied = true;
  const raw = process.env.CHECKPOINTER_DNS_ORDER?.trim().toLowerCase();
  if (raw === "off" || raw === "disabled") return;

  const order: "ipv4first" | "verbatim" | "ipv6first" =
    raw === "verbatim" || raw === "ipv6first" || raw === "ipv4first"
      ? raw
      : "ipv4first";

  try {
    dns.setDefaultResultOrder(order);
    console.log(`[checkpointer] dns.setDefaultResultOrder(${order})`);
  } catch (e) {
    console.warn(
      `[checkpointer] could not set DNS order to ${order}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Parse the host/port out of a postgres URL for diagnostic logs. Never
 * throws — returns `{}` on malformed input. We deliberately do NOT log
 * the password or the full URL.
 */
function describeHost(connectionString: string): { host?: string; port?: number } {
  try {
    const u = new URL(connectionString);
    const port = u.port ? Number(u.port) : undefined;
    return {
      host: u.hostname || undefined,
      port: port && Number.isFinite(port) ? port : undefined,
    };
  } catch {
    return {};
  }
}

export async function getCheckpointer() {
  if (singleton) return singleton;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || postgresFailed) {
    singleton = new MemorySaver();
    return singleton;
  }

  applyDnsResultOrder();
  const { host, port } = describeHost(connectionString);

  try {
    const saver = PostgresSaver.fromConnString(connectionString);
    if (!setupPromise) {
      setupPromise = saver.setup();
    }
    await setupPromise;
    singleton = saver;
    console.log(
      `[checkpointer] PostgresSaver connected host=${host ?? "?"} port=${port ?? "?"}`
    );
    return saver;
  } catch (e) {
    const errCode = (e as NodeJS.ErrnoException)?.code;
    const errAddress = (e as NodeJS.ErrnoException & { address?: string })
      ?.address;
    console.error(
      `[checkpointer] PostgresSaver failed to connect host=${host ?? "?"} port=${port ?? "?"}` +
        (errCode ? ` code=${errCode}` : "") +
        (errAddress ? ` address=${errAddress}` : "") +
        " — falling back to MemorySaver for this process lifetime. Error:",
      e
    );
    postgresFailed = true;
    singleton = new MemorySaver();
    return singleton;
  }
}
