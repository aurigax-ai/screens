import { createServer, request } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import type { Duplex } from 'node:stream'

export type Upstream = { authorization: string; connect: () => Duplex }

export function upstreamFromUrl(proxyUrl: string, open?: () => Duplex): Upstream {
  const url = new URL(proxyUrl)
  const credentials = Buffer.from(
    `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
  ).toString('base64')
  return {
    authorization: `Basic ${credentials}`,
    connect: open ?? (() => connect(Number(url.port), url.hostname)),
  }
}

export async function startProxyForwarder(upstream: Upstream): Promise<number> {
  const server = createServer((incoming, outgoing) => {
    const forwarded = request(
      {
        createConnection: () => upstream.connect() as never,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, 'proxy-authorization': upstream.authorization },
      },
      (answer) => {
        outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
        answer.pipe(outgoing)
      },
    )
    forwarded.on('error', () => outgoing.destroy())
    incoming.pipe(forwarded)
  })

  server.on('connect', (incoming, client, head) => {
    const tunnel = upstream.connect()
    tunnel.write(
      `CONNECT ${incoming.url} HTTP/1.1\r\nHost: ${incoming.url}\r\nProxy-Authorization: ${upstream.authorization}\r\n\r\n`,
    )
    if (head.length > 0) tunnel.write(head)
    tunnel.pipe(client)
    client.pipe(tunnel)
    tunnel.on('error', () => client.destroy())
    client.on('error', () => tunnel.destroy())
    tunnel.on('close', () => client.destroy())
    client.on('close', () => tunnel.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}
