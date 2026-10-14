#!/usr/bin/env node
import { runCli } from './run-cli.js'

process.exitCode = runCli(process.argv.slice(2), process.stdout, process.stderr)
