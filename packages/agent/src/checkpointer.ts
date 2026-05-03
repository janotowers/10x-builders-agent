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
 * NOTE: in current Supabase projects the *direct* host
 * `db.<ref>.supabase.co` only resolves to AAAA (IPv4 is an add-on). For
 * those, even `ipv4first` will not help because there is no A record. The
 * fix is to switch `DATABASE_URL` to the **Supabase Pooler** host
 * (`aws-0-<region>.pooler.supabase.com`), which serves IPv4. See
 * `docs/setup/supabase_pooler.md`.
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

/** Default per-attempt timeout for the initial PostgresSaver setup. The
 *  default Node socket timeout for a hung TCP connect is ~30s; that turns
 *  every cold turn into a 30s wait when Postgres is unreachable. We cap it
 *  to a much smaller value and fall back to MemorySaver fast. Configurable
 *  via `CHECKPOINTER_CONNECT_TIMEOUT_MS`. */
function resolveConnectTimeoutMs(): number {
  const raw = Number(process.env.CHECKPOINTER_CONNECT_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return 5000;
}

function isLikelySupabaseDirectHost(host: string | undefined): boolean {
  if (!host) return false;
  // Direct connection: `db.<ref>.supabase.co` (IPv6-only on most newer
  // projects). Pooler hosts look like `aws-0-<region>.pooler.supabase.com`
  // and are IPv4-friendly.
  return /^db\.[a-z0-9-]+\.supabase\.co$/i.test(host);
}

function diagnoseConnectionError(
  host: string | undefined,
  errCode: string | undefined,
  errAddress: string | undefined
): string | null {
  if (!errCode) return null;
  if (errCode === "XX000" && host?.endsWith(".pooler.supabase.com")) {
    return (
      "[checkpointer] Supabase Pooler reached, but it rejected the tenant/user. " +
      "Copy the exact 'Session pooler' connection string from Supabase Dashboard " +
      "instead of inferring the region/host manually. The username must look like " +
      "`postgres.<project-ref>` and the host/region must match the dashboard value."
    );
  }
  const isTimeout = errCode === "ETIMEDOUT" || errCode === "ENETUNREACH";
  const looksIPv6 =
    typeof errAddress === "string" && errAddress.includes(":");
  if (isTimeout && looksIPv6 && isLikelySupabaseDirectHost(host)) {
    return (
      "[checkpointer] Looks like the direct Supabase host only resolves to IPv6 " +
      "(AAAA) and your network does not route IPv6 to AWS. Switch DATABASE_URL " +
      "to the Supabase Session Pooler. From Supabase Dashboard → Project " +
      "Settings → Database → Connection string, copy the 'Session Pooler' URL " +
      "(host looks like `aws-0-<region>.pooler.supabase.com`, port `5432`, " +
      "user `postgres.<ref>`). See `docs/setup/supabase_pooler.md`."
    );
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err: NodeJS.ErrnoException = Object.assign(
        new Error(`${label} timed out after ${timeoutMs}ms`),
        { code: "ETIMEDOUT" }
      );
      reject(err);
    }, timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
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
  const timeoutMs = resolveConnectTimeoutMs();

  try {
    const saver = PostgresSaver.fromConnString(connectionString);
    if (!setupPromise) {
      setupPromise = withTimeout(
        saver.setup(),
        timeoutMs,
        "PostgresSaver.setup"
      );
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
    const hint = diagnoseConnectionError(host, errCode, errAddress);
    console.error(
      `[checkpointer] PostgresSaver failed to connect host=${host ?? "?"} port=${port ?? "?"}` +
        (errCode ? ` code=${errCode}` : "") +
        (errAddress ? ` address=${errAddress}` : "") +
        ` (timeout=${timeoutMs}ms)` +
        " — falling back to MemorySaver for this process lifetime. Error:",
      e
    );
    if (hint) console.error(hint);
    postgresFailed = true;
    setupPromise = null;
    singleton = new MemorySaver();
    return singleton;
  }
}
