/**
 * DNS hijack guard for the WorkBuddy provider.
 *
 * Why this exists
 * ---------------
 * 2026-09-10: turns kept dying with `TRANSPORT` ("Connection error.") plus
 * occasional `TIMEOUT`, always in bursts, on `workbuddy-cn` only. Root cause
 * was DNS, not the API: the LAN router — the single nameserver in
 * /etc/resolv.conf — intermittently answered `copilot.tencent.com` with
 * 117.55.193.154, a hijack box. Its certificate is issued for the IP itself
 * (not the hostname) and expired 2026-08-28, so every TLS handshake failed
 * with `CERT_HAS_EXPIRED`. The OpenAI SDK wrapped that in
 * `APIConnectionError: Connection error.`, dsh-llm-pi-ai classified it as
 * TRANSPORT, and the turn died after five retries — each retry re-resolved to
 * the same poisoned answer because the hijacked A record carries a multi-hour
 * TTL. The upstream authoritative nameservers never return that address.
 *
 * How this fixes it
 * -----------------
 * Re-resolve the provider's own hosts over DNS-over-HTTPS, bypassing the
 * system resolver, and hand the good addresses to the connection path through
 * `dns.lookup`. The patch is deliberately narrow:
 *
 *   - only hostnames in {@link TRUSTED_HOSTS} are intercepted; every other
 *     lookup is delegated to the original implementation untouched;
 *   - if DoH yields nothing, the last known-good answer is used, and failing
 *     that the original lookup runs — so a DoH outage degrades to today's
 *     behaviour instead of breaking the provider;
 *   - instilling is idempotent and reversible via the returned disposer.
 *
 * Patching `dns.lookup` rather than passing a custom `fetch` is deliberate:
 * Node reads this function live at connect time, so one narrow patch covers
 * every path the provider uses — the pi-ai/OpenAI streaming client, model
 * discovery, token refresh and the credits probe — and it keeps working when
 * another plugin replaces the process-wide undici dispatcher.
 *
 * @module llm-workbuddy/dns
 */
// The default import is required, not stylistic: the `node:dns` module
// namespace is non-extensible, so `import * as dns` yields a frozen view whose
// `lookup` cannot be reassigned. Node exposes the same object as the default
// export, and that one is writable — which is the object the connection path
// actually reads.
import dns from "node:dns";

const systemLookup = dns.lookup;

/** Hosts the provider talks to. Everything else keeps the system resolver. */
export const TRUSTED_HOSTS = Object.freeze([
  "copilot.tencent.com",
  "workbuddy.cn",
  "www.workbuddy.cn",
  "codebuddy.cn",
  "www.codebuddy.cn",
]);

/**
 * JSON DoH endpoints, tried in parallel.
 *
 * The address-literal entries come first on purpose: `223.5.5.5` needs no DNS
 * lookup of its own (AliDNS serves a certificate valid for that IP), so the
 * bootstrap cannot be poisoned. The hostname entries are only a fallback.
 */
export const DOH_ENDPOINTS = Object.freeze([
  "https://223.5.5.5/resolve",
  "https://dns.alidns.com/resolve",
  "https://doh.pub/dns-query",
]);

/** How long a successful DoH answer is trusted before it is refreshed. */
export const CACHE_TTL_MS = 60_000;
/** How long a failed DoH answer is remembered, to avoid hammering. */
export const CACHE_FAILURE_TTL_MS = 5_000;
/**
 * How long a last known-good answer may stand in when DoH is unreachable.
 * Bounded so a long outage cannot pin an address that has genuinely moved.
 */
export const STALE_TTL_MS = 24 * 60 * 60 * 1000;
/** Per-endpoint DoH timeout. */
export const DOH_TIMEOUT_MS = 3_000;

const TRUSTED = new Set(TRUSTED_HOSTS);

/** hostname -> { records, expires } — fresh answers. */
const cache = new Map();
/** hostname -> { records, at } — last answer that actually resolved. */
const lastGood = new Map();
/** hostname -> in-flight promise, so parallel connects share one lookup. */
const inflight = new Map();

let activeGuard = null;

/**
 * Install the guard process-wide.
 *
 * Reference counted, because DSH reloads plugins in place
 * (`patchReload: live`): a naive install/dispose pair would let the *old*
 * plugin instance's disposer tear the guard down after the new instance had
 * already asked for it, silently disarming the protection. Each call returns
 * its own idempotent disposer and the lookup is restored only when the last
 * consumer lets go.
 *
 * @param original - lookup to wrap; defaults to the current `dns.lookup`.
 * @returns a disposer releasing this consumer's claim.
 */
export function installDnsGuard(original) {
  if (activeGuard === null) {
    const previous = original ?? dns.lookup;
    const guarded = makeGuardedLookup(previous);
    dns.lookup = guarded;
    activeGuard = { previous, guarded, refs: 0 };
  }
  activeGuard.refs += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const state = activeGuard;
    if (state === null) return;
    state.refs -= 1;
    if (state.refs > 0) return;
    // Only restore when our function is still active: another plugin may have
    // wrapped it after us, and yanking it out would break that.
    if (dns.lookup === state.guarded) dns.lookup = state.previous;
    activeGuard = null;
  };
}

/** True when the guard is currently installed. */
export function dnsGuardInstalled() {
  return activeGuard !== null;
}
function normalizeHostname(hostname) {
  if (typeof hostname === "string") return hostname.toLowerCase().replace(/\.$/, "");
  return String(hostname).toLowerCase().replace(/\.$/, "");
}

function isTrusted(hostname) {
  return TRUSTED.has(normalizeHostname(hostname));
}

function toRecords(addresses) {
  const unique = new Map();
  for (const address of addresses) unique.set(address, { address, family: 4 });
  return [...unique.values()];
}

function isIPv4(value) {
  if (typeof value !== "string") return false;
  const parts = value.trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

async function queryEndpoint(endpoint, hostname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  try {
    const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=A`;
    const response = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return [];
    const body = await response.json();
    const answers = Array.isArray(body?.Answer) ? body.Answer : [];
    return answers
      .filter((entry) => entry?.type === 1 && isIPv4(entry.data))
      .map((entry) => entry.data.trim());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve one hostname through every DoH endpoint and merge what came back. */
export async function resolveOverDoh(hostname) {
  const results = await Promise.all(DOH_ENDPOINTS.map((endpoint) => queryEndpoint(endpoint, hostname)));
  return toRecords(results.flat());
}

function freshRecords(hostname) {
  const entry = cache.get(hostname);
  if (entry !== undefined && entry.expires > Date.now()) return entry.records;
  return undefined;
}

function staleRecords(hostname) {
  const entry = lastGood.get(hostname);
  if (entry !== undefined && Date.now() - entry.at <= STALE_TTL_MS) return entry.records;
  return undefined;
}

/** Resolve a trusted host, coalescing concurrent callers onto one query. */
function resolveTrusted(hostname) {
  const fresh = freshRecords(hostname);
  if (fresh !== undefined) return Promise.resolve(fresh);
  const pending = inflight.get(hostname);
  if (pending !== undefined) return pending;
  const promise = resolveOverDoh(hostname).then(
    (records) => {
      if (records.length > 0) {
        cache.set(hostname, { records, expires: Date.now() + CACHE_TTL_MS });
        lastGood.set(hostname, { records, at: Date.now() });
        return records;
      }
      // Do not cache an empty answer for a full minute: a transient DoH
      // outage must not pin every request to the system resolver.
      cache.set(hostname, { records: [], expires: Date.now() + CACHE_FAILURE_TTL_MS });
      return [];
    },
    () => {
      cache.set(hostname, { records: [], expires: Date.now() + CACHE_FAILURE_TTL_MS });
      return [];
    },
  ).finally(() => {
    inflight.delete(hostname);
  });
  inflight.set(hostname, promise);
  return promise;
}

/**
 * Build a `dns.lookup`-compatible function resolving trusted hosts via DoH.
 *
 * @param original - the lookup to delegate non-trusted hosts (and failures) to.
 * @returns a lookup usable as `dns.lookup` or as undici's `connect.lookup`.
 */
export function makeGuardedLookup(original = systemLookup) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const normalized = typeof options === "number" ? { family: options } : (options ?? {});
    if (!isTrusted(hostname)) return original.call(this, hostname, normalized, callback);

    const host = normalizeHostname(hostname);
    const fallback = () => original.call(this, hostname, normalized, callback);
    resolveTrusted(host).then(
      (records) => {
        const usable = records.length > 0 ? records : (staleRecords(host) ?? []);
        if (usable.length === 0) return fallback();
        if (normalized.all) return callback(null, usable);
        return callback(null, usable[0].address, usable[0].family);
      },
      () => {
        const stale = staleRecords(host);
        if (stale === undefined) return fallback();
        if (normalized.all) return callback(null, stale);
        return callback(null, stale[0].address, stale[0].family);
      },
    );
  };
}

/** Drop all cached answers. Exposed for tests and manual recovery. */
export function resetDnsCache() {
  cache.clear();
  lastGood.clear();
  inflight.clear();
}
