import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { banner, runCli, type CliIo } from '../src/cli.js';

/**
 * Phase 9 — the CLI. Pure: IO and the migration runner are injected, so
 * these tests never touch a database or a real stdout.
 */

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

function fakeIo(env: Record<string, string | undefined> = {}): {
  io: CliIo;
  out: () => string;
  err: () => string;
  calls: { databaseUrl: string }[];
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const calls: { databaseUrl: string }[] = [];
  return {
    io: {
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
      env,
      migrate: (options) => {
        calls.push(options);
        return Promise.resolve(['1_initial-schema']);
      },
    },
    out: () => outLines.join('\n'),
    err: () => errLines.join('\n'),
    calls,
  };
}

describe('phase 9 CLI', () => {
  it('the banner carries the name, the tagline, and the real version', () => {
    const text = banner(pkg.version);
    expect(text).toContain('_   _'); // the ascii art exists
    expect(text).toContain('Sidekiq of webhooks');
    expect(text).toContain(`v${pkg.version}`);
  });

  it('no args → banner + usage on stdout, exit 0', async () => {
    const { io, out } = fakeIo();
    expect(await runCli([], io)).toBe(0);
    expect(out()).toContain('Sidekiq of webhooks');
    expect(out()).toContain('Usage: harkara');
    expect(out()).toContain('migrate');
  });

  it('version prints exactly the package version', async () => {
    const { io, out } = fakeIo();
    expect(await runCli(['version'], io)).toBe(0);
    expect(out().trim()).toBe(pkg.version);
    const dashed = fakeIo();
    expect(await runCli(['--version'], dashed.io)).toBe(0);
    expect(dashed.out().trim()).toBe(pkg.version);
  });

  it('migrate without DATABASE_URL refuses politely, exit 1, nothing run', async () => {
    const { io, err, calls } = fakeIo({});
    expect(await runCli(['migrate'], io)).toBe(1);
    expect(err()).toContain('DATABASE_URL');
    expect(calls).toHaveLength(0);
  });

  it('migrate runs against DATABASE_URL and reports what applied', async () => {
    const { io, out, calls } = fakeIo({ DATABASE_URL: 'postgres://example/db' });
    expect(await runCli(['migrate'], io)).toBe(0);
    expect(calls).toEqual([{ databaseUrl: 'postgres://example/db' }]);
    expect(out()).toContain('1_initial-schema');
  });

  it('migrate --database-url beats the environment', async () => {
    const { io, calls } = fakeIo({ DATABASE_URL: 'postgres://env/db' });
    expect(await runCli(['migrate', '--database-url=postgres://flag/db'], io)).toBe(0);
    expect(calls).toEqual([{ databaseUrl: 'postgres://flag/db' }]);
  });

  it('unknown commands fail loudly with usage on stderr', async () => {
    const { io, err } = fakeIo();
    expect(await runCli(['deliver-everything'], io)).toBe(1);
    expect(err()).toContain('Unknown command');
    expect(err()).toContain('Usage: harkara');
  });
});
