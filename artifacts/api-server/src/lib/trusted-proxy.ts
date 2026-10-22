import { isIP } from "node:net";

/**
 * Express `trust proxy` setting from TRUST_PROXY.
 *
 *   none                      X-Forwarded-For is ignored; req.ip is the socket peer.
 *   <entry>[,<entry>...]      Only peers matching an entry may supply X-Forwarded-For.
 *                             Entries are IPv4/IPv6 addresses or CIDRs, or the
 *                             Express presets loopback, linklocal, uniquelocal.
 *
 * "true", hop counts and catch-all ranges are refused: they let any client
 * that reaches the app directly choose its own address. Production must set
 * the variable explicitly so the proxy topology is a deliberate decision.
 */
export class TrustProxyConfigError extends Error {
  constructor(detail: string) {
    super(`TRUST_PROXY is misconfigured: ${detail}`);
    this.name = "TrustProxyConfigError";
  }
}

const PRESETS = new Set(["loopback", "linklocal", "uniquelocal"]);

function validEntry(entry: string): boolean {
  if (PRESETS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split("/");
  const family = isIP(address);
  if (!family || rest.length) return false;
  if (prefix === undefined) return !/^(0\.0\.0\.0|::)$/.test(address);
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits >= 8 && bits <= (family === 4 ? 32 : 128);
}

export function parseTrustProxy(env: NodeJS.ProcessEnv): false | string[] {
  const raw = (env.TRUST_PROXY ?? "").trim();
  if (!raw) {
    if (env.NODE_ENV === "production") {
      throw new TrustProxyConfigError("it must be set in production ('none' or trusted proxy addresses/CIDRs)");
    }
    return false;
  }
  if (raw === "none") return false;
  const entries = raw.split(",").map((entry) => entry.trim());
  entries.forEach((entry, index) => {
    if (!validEntry(entry)) {
      throw new TrustProxyConfigError(
        `entry ${index + 1} must be an IP address, a CIDR with prefix /8 or narrower, or loopback/linklocal/uniquelocal`,
      );
    }
  });
  return entries;
}
