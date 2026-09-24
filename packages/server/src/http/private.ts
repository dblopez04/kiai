// The score library is private: it has no login, so it must only be reachable on your own
// machine or network. This guard refuses anything that looks like it came through a public
// hostname or a tunnel, so a proxy pointed at the wrong port fails closed instead of exposing it.
// It also blocks DNS-rebinding attacks, which reach localhost services through a public name.

import { isIP } from "node:net";

const PRIVATE_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal", ".localhost", ".ts.net"];

/** Headers that tunnels and CDNs add; their presence means the request came from outside. */
const TUNNEL_HEADERS = ["cf-connecting-ip", "cf-ray", "cdn-loop"];

export function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]")); // [::1]:8080
  const colon = host.lastIndexOf(":");
  return colon > -1 && host.indexOf(":") === colon ? host.slice(0, colon) : host;
}

/** IP literals, single-label names (`homelab`), private suffixes, and `extra` are allowed. */
export function isPrivateHost(hostHeader: string | undefined, extra: readonly string[] = []): boolean {
  if (!hostHeader) return false;
  const name = hostnameOf(hostHeader).replace(/\.$/, "");
  if (!name) return false;
  if (isIP(name)) return true;
  if (name === "localhost" || !name.includes(".")) return true;
  if (PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  return extra.includes(name);
}

export type PrivateCheck = { ok: true } | { ok: false; reason: string };

export function checkPrivateRequest(
  method: string,
  headers: { get(name: string): string | undefined },
  extraHosts: readonly string[],
): PrivateCheck {
  const tunnel = TUNNEL_HEADERS.find((name) => headers.get(name) !== undefined);
  if (tunnel) return { ok: false, reason: `came through a tunnel or CDN (${tunnel} header)` };
  const host = headers.get("host");
  if (!isPrivateHost(host, extraHosts)) {
    return { ok: false, reason: `was addressed to "${host ?? ""}", which isn't a private hostname (add it to PRIVATE_HOSTS if it is)` };
  }
  // Browsers send Origin on writes; another site must not be able to trigger one.
  const origin = headers.get("origin");
  const isWrite = method !== "GET" && method !== "HEAD";
  // Sandboxed frames and data: URLs send "null"; never let them write.
  if (origin === "null") return isWrite ? { ok: false, reason: "came from an opaque origin" } : { ok: true };
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host) return { ok: false, reason: "came from another site" };
    } catch {
      return { ok: false, reason: "had an invalid Origin header" };
    }
  }
  return { ok: true };
}
