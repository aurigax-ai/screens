#!/usr/bin/env node
import { runCli } from './run-cli.js'

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
})
