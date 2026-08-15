import { describe, expect, it } from 'vitest';
import { vetAddress, vetUrl } from '../src/egress.js';

/**
 * Phase 7 — §9.1/§9.3 pure vetting tables. vetAddress returns a refusal
 * reason (string) or null for deliverable; vetUrl gates scheme and
 * parseability before any DNS happens.
 */

describe('§9.1 vetAddress: the blocklist is ranges, never a list of IPs', () => {
  const refused = (ip: string) => {
    const reason = vetAddress(ip);
    expect(reason, `${ip} must be refused`).not.toBeNull();
    return reason!;
  };
  const allowed = (ip: string) => {
    expect(vetAddress(ip), `${ip} must be deliverable`).toBeNull();
  };

  it('loopback', () => {
    refused('127.0.0.1');
    refused('127.255.255.254'); // the whole /8, not one address
    refused('::1');
  });

  it('RFC1918 private ranges', () => {
    refused('10.0.0.1');
    refused('10.255.255.255');
    refused('172.16.0.1');
    refused('172.31.255.254');
    refused('192.168.1.1');
  });

  it('169.254.169.254 (cloud metadata) falls as a LINK-LOCAL RANGE member, not a named IP', () => {
    // Maintainer rider: the metadata service must be caught by the
    // 169.254.0.0/16 range check — pin a neighbor too, so the check can
    // never be "optimized" into an IP list.
    refused('169.254.169.254');
    refused('169.254.0.1');
    refused('fe80::1');
    refused('fe80::dead:beef');
  });

  it('unspecified, CGNAT, multicast, reserved', () => {
    refused('0.0.0.0');
    refused('0.1.2.3');
    refused('100.64.0.1'); // CGNAT 100.64.0.0/10
    refused('100.127.255.254');
    refused('224.0.0.1'); // multicast
    refused('240.0.0.1'); // reserved
    refused('255.255.255.255');
    refused('::');
    refused('ff02::1'); // v6 multicast
  });

  it('IPv6 unique-local (fc00::/7)', () => {
    refused('fc00::1');
    refused('fd12:3456:789a::1');
  });

  it('v4-mapped IPv6 unwraps and vets the embedded IPv4', () => {
    refused('::ffff:10.0.0.1');
    refused('::ffff:127.0.0.1');
    refused('::ffff:169.254.169.254');
    allowed('::ffff:8.8.8.8');
  });

  it('NAT64 well-known prefix (64:ff9b::/96) unwraps too — same trick, different wrapper', () => {
    refused('64:ff9b::a00:1'); // embeds 10.0.0.1
    refused('64:ff9b::7f00:1'); // embeds 127.0.0.1
    allowed('64:ff9b::808:808'); // embeds 8.8.8.8
  });

  it('public addresses are deliverable', () => {
    allowed('1.1.1.1');
    allowed('8.8.8.8');
    allowed('93.184.215.14');
    allowed('99.255.255.255'); // just below CGNAT
    allowed('100.128.0.0'); // just above CGNAT
    allowed('2606:4700::1111');
    allowed('2001:4860:4860::8888');
  });

  it('garbage is refused, not crashed on', () => {
    refused('not-an-ip');
    refused('');
    refused('10.0.0');
  });
});

describe('§9.3 vetUrl: scheme gate before any DNS', () => {
  it('https is always deliverable', () => {
    const vetted = vetUrl('https://example.com/hook', { allowInsecureHttp: false });
    expect('url' in vetted && vetted.url.hostname).toBe('example.com');
  });

  it('plain http is refused by default, citing §9.3', () => {
    const vetted = vetUrl('http://example.com/hook', { allowInsecureHttp: false });
    expect('refused' in vetted && vetted.refused).toMatch(/§9\.3/);
  });

  it('plain http is deliverable with the explicit opt-in', () => {
    const vetted = vetUrl('http://example.com/hook', { allowInsecureHttp: true });
    expect('url' in vetted).toBe(true);
  });

  it('non-HTTP schemes are refused even with the opt-in', () => {
    for (const raw of ['ftp://example.com/x', 'file:///etc/passwd', 'gopher://example.com']) {
      const vetted = vetUrl(raw, { allowInsecureHttp: true });
      expect('refused' in vetted, `${raw} must be refused`).toBe(true);
    }
  });

  it('unparseable URLs are refused, not thrown', () => {
    const vetted = vetUrl('http://', { allowInsecureHttp: true });
    expect('refused' in vetted).toBe(true);
  });
});
