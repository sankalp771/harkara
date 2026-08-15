#!/usr/bin/env node
import { runCli } from './cli.js';
import { runMigrations } from './migrate.js';

process.exitCode = await runCli(process.argv.slice(2), {
  out: (line) => {
    console.log(line);
  },
  err: (line) => {
    console.error(line);
  },
  env: process.env,
  migrate: runMigrations,
});
