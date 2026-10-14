import { RequestError } from './protocol.js'

export type Backend = 'xvnc' | 'oci'

export function chooseBackend(options: {
  platform: NodeJS.Platform
  requested: Backend | undefined
  configured: Backend | undefined
}): Backend {
  if (options.platform !== 'linux') {
    if (options.requested === 'xvnc') {
      throw new RequestError('usage', 'the xvnc backend is Linux only; use --backend oci')
    }
    return 'oci'
  }
  return options.requested ?? options.configured ?? 'xvnc'
}
