import { chmod, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'

export async function listenFresh(
  path: string,
  onConnection: (socket: Socket) => void,
): Promise<Server> {
  await rm(path, { force: true })
  const server = createServer(onConnection)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(path, 0o600)
  return server
}
