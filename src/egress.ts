import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/**
 * §9 — the egress guard. Endpoint URLs are untrusted user input aimed at
 * Harkara's own HTTP client. Everything here follows one rule: resolve
 * exactly once, vet everything that came back, and hand the socket the
 * vetted bytes — there is no second resolution for DNS rebinding to win
 * (§9.2). Redirects are never followed (a 3xx is terminal, §3.2), the
 * byte cap kills the read DURING streaming, and one deadline covers
 * connect → headers → body.
 */

export interface SsrfOptions {
  /** §9.3 — plain http is an explicit local-development opt-in. */
  allowInsecureHttp: boolean;
  /** §9.3 — private/loopback/link-local targets are an explicit opt-in. */
  allowPrivateAddresses: boolean;
}

/** DNS seam: injectable for tests, real dns.lookup otherwise. */
export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * §9.1 — is this address deliverable? Returns a refusal reason or null.
 * The checks are RANGES, never a list of addresses: 169.254.169.254 is
 * refused because it is link-local, not because it is famous.
 */
export function vetAddress(ip: string): string | null {
  const bare = ip.split('%')[0] ?? ip; // strip any zone index (fe80::1%eth0)
  const version = isIP(bare);
  if (version === 4) return vet4(bare);
  if (version === 6) return vet6(bare);
  return 'not a valid IP address';
}

function vet4(ip: string): string | null {
  const [a = -1, b = -1] = ip.split('.').map(Number);
  if (a === 0) return 'this-network range (0.0.0.0/8)';
  if (a === 10) return 'private range (10.0.0.0/8)';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT range (100.64.0.0/10)';
  if (a === 127) return 'loopback range (127.0.0.0/8)';
  if (a === 169 && b === 254) return 'link-local range (169.254.0.0/16)';
  if (a === 172 && b >= 16 && b <= 31) return 'private range (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'private range (192.168.0.0/16)';
  if (a >= 224 && a <= 239) return 'multicast range (224.0.0.0/4)';
  if (a >= 240) return 'reserved range (240.0.0.0/4)';
  return null;
}

function vet6(ip: string): string | null {
  const words = expand6(ip);
  if (words === null) return 'not a valid IPv6 address';
  const [w0 = 0, w1 = 0] = words;
  if (words.every((w) => w === 0)) return 'unspecified address (::)';
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return 'loopback (::1)';
  if ((w0 & 0xffc0) === 0xfe80) return 'link-local range (fe80::/10)';
  if ((w0 & 0xfe00) === 0xfc00) return 'unique-local range (fc00::/7)';
  if ((w0 & 0xff00) === 0xff00) return 'multicast range (ff00::/8)';
  // Wrapped IPv4 rides inside IPv6 two ways; unwrap and apply the same
  // rules — same trick, different wrapper.
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    return wrapReason(vet4(embedded4(words)), 'v4-mapped');
  }
  if (w0 === 0x64 && w1 === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    return wrapReason(vet4(embedded4(words)), 'NAT64 (64:ff9b::/96)');
  }
  return null;
}

function embedded4(words: number[]): string {
  const hi = words[6] ?? 0;
  const lo = words[7] ?? 0;
  return `${String(hi >> 8)}.${String(hi & 0xff)}.${String(lo >> 8)}.${String(lo & 0xff)}`;
}

function wrapReason(inner: string | null, wrapper: string): string | null {
  return inner === null ? null : `${wrapper}-embedded ${inner}`;
}

/** Expand an IPv6 literal (isIP-validated) to its eight 16-bit words. */
function expand6(ip: string): number[] | null {
  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    // Dotted-quad tail (::ffff:127.0.0.1) → two hex groups.
    const parts = tail.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
    const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = parts;
    const g1 = ((p0 << 8) | p1).toString(16);
    const g2 = ((p2 << 8) | p3).toString(16);
    text = `${text.slice(0, lastColon + 1)}${g1}:${g2}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const [firstHalf = '', secondHalf = ''] = halves;
  const left = firstHalf === '' ? [] : firstHalf.split(':');
  const right = halves.length === 2 && secondHalf !== '' ? secondHalf.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 0) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  const groups =
    halves.length === 2 ? [...left, ...(Array(missing).fill('0') as string[]), ...right] : left;
  const words = groups.map((g) => parseInt(g, 16));
  if (words.length !== 8 || words.some((w) => Number.isNaN(w) || w < 0 || w > 0xffff)) return null;
  return words;
}

/** §9.3 — scheme gate, before any DNS happens. */
export function vetUrl(
  rawUrl: string,
  opts: { allowInsecureHttp: boolean },
): { url: URL } | { refused: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { refused: 'egress guard: unparseable URL — refusing to deliver (§9.1)' };
  }
  if (url.protocol === 'https:') return { url };
  if (url.protocol === 'http:') {
    if (opts.allowInsecureHttp) return { url };
    return {
      refused:
        'egress guard: https required — plain http is an explicit local-development opt-in (§9.3)',
    };
  }
  return {
    refused: `egress guard: unsupported scheme "${url.protocol}" — only https (or opted-in http) delivers (§9.1)`,
  };
}

/** Per-worker keep-alive pools; a pooled socket was vetted at connect. */
export interface EgressAgents {
  http: HttpAgent;
  https: HttpsAgent;
}

export function createAgents(): EgressAgents {
  return {
    http: new HttpAgent({ keepAlive: true }),
    https: new HttpsAgent({ keepAlive: true }),
  };
}

export function destroyAgents(agents: EgressAgents): void {
  agents.http.destroy();
  agents.https.destroy();
}

export type EgressResult =
  | { kind: 'http'; statusCode: number; retryAfter: string | null; body: string }
  | { kind: 'network'; message: string }
  | { kind: 'config'; message: string };

export interface PinnedRequestOptions {
  method: string;
  headers: Record<string, string>;
  body: string;
  /** One deadline covering connect → headers → body (§9.2). */
  timeoutMs: number;
  /** Hard cap enforced DURING the streamed read (§9.2). */
  byteCap: number;
  ssrf: SsrfOptions;
  resolver?: Resolver;
  agents?: EgressAgents;
}

/**
 * The vetted, pinned request. Refusals (kind 'config') never touch the
 * wire; resolution failures and pre-status timeouts are 'network'
 * (retryable, §3.2); once the status line arrives, the outcome is
 * 'http' no matter what happens to the body — the caps protect
 * resources, the status decides (§9.2).
 */
export async function pinnedRequest(
  rawUrl: string,
  opts: PinnedRequestOptions,
): Promise<EgressResult> {
  const vetted = vetUrl(rawUrl, opts.ssrf);
  if ('refused' in vetted) return { kind: 'config', message: vetted.refused };
  const { url } = vetted;
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

  let addresses: { address: string; family: number }[];
  if (isIP(hostname) !== 0) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await (opts.resolver ?? defaultResolver)(hostname);
    } catch (err) {
      return { kind: 'network', message: `DNS resolution failed for ${hostname}: ${errText(err)}` };
    }
    if (addresses.length === 0) {
      return { kind: 'network', message: `DNS returned no addresses for ${hostname}` };
    }
  }

  if (!opts.ssrf.allowPrivateAddresses) {
    // All-or-nothing: one bad record poisons the whole answer set — an
    // attacker controls their own DNS answers and wins on connect order.
    for (const { address } of addresses) {
      const reason = vetAddress(address);
      if (reason !== null) {
        return {
          kind: 'config',
          message: `egress guard: ${hostname} resolves to ${address} — ${reason} — refusing to deliver (§9.1)`,
        };
      }
    }
  }

  const target = addresses[0];
  if (target === undefined) {
    return { kind: 'network', message: `DNS returned no addresses for ${hostname}` };
  }
  const isHttps = url.protocol === 'https:';

  return new Promise<EgressResult>((resolve) => {
    let settled = false;
    // Once the status line arrives, EVERY exit — end, cap, abort, reset —
    // finishes with that status (§9.2: the status decides). Before it,
    // errors are network failures.
    let finishResponse: (() => void) | null = null;
    const done = (result: EgressResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const req = (isHttps ? httpsRequest : httpRequest)(
      {
        // The PIN: the socket dials the vetted address; the Host header
        // and TLS identity (SNI + cert check) stay on the hostname.
        host: target.address,
        family: target.family === 6 ? 6 : 4,
        port: url.port !== '' ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: opts.method,
        agent: isHttps ? (opts.agents?.https ?? false) : (opts.agents?.http ?? false),
        headers: { ...opts.headers, host: url.host },
        ...(isHttps ? { servername: hostname } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const finish = () => {
          done({
            kind: 'http',
            statusCode: res.statusCode ?? 0,
            retryAfter: firstHeader(res.headers['retry-after']),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        };
        res.on('data', (chunk: Buffer) => {
          const room = opts.byteCap - received;
          if (room > 0) chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          received += chunk.length;
          if (received >= opts.byteCap) {
            // §9.2 — destroy at the cap, never buffer past it.
            finish();
            res.destroy();
          }
        });
        finishResponse = finish;
        res.on('end', finish);
        res.on('error', finish);
      },
    );
    req.on('error', (err) => {
      // Mid-body aborts surface here too (the time cap firing while the
      // body drips) — the status already decided if we have one.
      if (finishResponse !== null) finishResponse();
      else done({ kind: 'network', message: errText(err) });
    });
    req.end(opts.body);
  });
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message;
  }
  return String(err);
}
