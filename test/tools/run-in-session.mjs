import { parseArgs } from 'node:util'
import { SessionEnvError, startInSession } from '../../dist/session-guard.js'

const { values, positionals } = parseArgs({
  options: {
    folder: { type: 'string' },
    display: { type: 'string' },
  },
  allowPositionals: true,
})

const [command, ...args] = positionals
if (!values.folder || !values.display || command === undefined) {
  process.stderr.write(
    'usage: pnpm run in-session --folder DIR --display :N -- program [args...]\n',
  )
  process.exit(2)
}

try {
  const child = startInSession(command, args, {
    env: process.env,
    session: { folder: values.folder, display: values.display },
    stdio: 'inherit',
  })
  child.on('exit', (code) => process.exit(code ?? 1))
} catch (error) {
  if (!(error instanceof SessionEnvError)) throw error
  process.stderr.write(`${error.message}\n`)
  process.exit(4)
}
