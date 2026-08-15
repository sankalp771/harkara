import { readFileSync } from 'node:fs';
import type { RunMigrationsOptions } from './migrate.js';

/**
 * Phase 9 — the `harkara` CLI. Deliberately tiny: delivery lives in the
 * library (`createHarkara({ pool })`); the CLI only carries the schema
 * and identity. Logic is pure — IO and the migration runner are
 * injected — so the whole surface is unit-testable without a database.
 */

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  migrate: (options: RunMigrationsOptions) => Promise<string[]>;
}

/** Figlet-style letters, assembled per row so no line is hand-miscounted. */
const LETTERS: Record<string, string[]> = {
  H: [' _   _ ', '| | | |', '| |_| |', '|  _  |', '|_| |_|'],
  a: ['       ', '  __ _ ', ' / _` |', '| (_| |', ' \\__,_|'],
  r: ['      ', ' _ __ ', "| '__|", '| |   ', '|_|   '],
  k: [' _    ', '| | __', '| |/ /', '|   < ', '|_|\\_\\'],
};

export function banner(version: string): string {
  const word = ['H', 'a', 'r', 'k', 'a', 'r', 'a'];
  const art = [0, 1, 2, 3, 4]
    .map((row) => word.map((letter) => LETTERS[letter]?.[row] ?? '').join(''))
    .join('\n');
  return [
    '',
    art,
    '',
    '  webhook delivery on the Postgres you already run',
    `  the Sidekiq of webhooks · v${version}`,
    '  https://github.com/sankalp771/harkara',
    '',
  ].join('\n');
}

const USAGE = [
  'Usage: harkara <command>',
  '',
  'Commands:',
  '  migrate    Apply harkara schema to DATABASE_URL (safe on every boot;',
  '             ledger lives in harkara_migrations, never your tables)',
  '             options: --database-url=postgres://…  (beats the env)',
  '  version    Print the installed version',
  '  help       Show this help',
  '',
  'Delivery itself is library-shaped: createHarkara({ pool }) in your app.',
].join('\n');

export function packageVersion(): string {
  // src/cli.ts sits at <root>/src; dist/src/cli.js sits at <pkg>/dist/src —
  // package.json is one hop up in dev, two hops up when installed.
  for (const hop of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(hop, import.meta.url), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'harkara' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // try the next hop
    }
  }
  return 'unknown';
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const version = packageVersion();

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.out(banner(version));
    io.out(USAGE);
    return 0;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    io.out(version);
    return 0;
  }

  if (command === 'migrate') {
    const flag = rest.find((a) => a.startsWith('--database-url='));
    const databaseUrl = flag?.slice('--database-url='.length) ?? io.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl === '') {
      io.err('harkara migrate: set DATABASE_URL or pass --database-url=postgres://…');
      return 1;
    }
    try {
      const applied = await io.migrate({ databaseUrl });
      io.out(
        applied.length === 0
          ? 'harkara migrate: already up to date'
          : `harkara migrate: applied ${String(applied.length)} migration(s): ${applied.join(', ')}`,
      );
      return 0;
    } catch (err) {
      io.err(`harkara migrate: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  io.err(`Unknown command: ${command}`);
  io.err('');
  io.err(USAGE);
  return 1;
}
