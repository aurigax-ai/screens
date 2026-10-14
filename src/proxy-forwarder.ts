import { createServer, request } from 'node:http'
import { type AddressInfo, connect } from 'node:net'

export async function startProxyForwarder(upstreamProxy: string): Promise<number> {
  const upstream = new URL(upstreamProxy)
  const credentials = Buffer.from(
    `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`,
  ).toString('base64')
  const authorization = `Basic ${credentials}`
  const upstreamPort = Number(upstream.port)

  const server = createServer((incoming, outgoing) => {
    const forwarded = request(
      {
        host: upstream.hostname,
        port: upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, 'proxy-authorization': authorization },
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
    const tunnel = connect(upstreamPort, upstream.hostname, () => {
      tunnel.write(
        `CONNECT ${incoming.url} HTTP/1.1\r\nHost: ${incoming.url}\r\nProxy-Authorization: ${authorization}\r\n\r\n`,
      )
      if (head.length > 0) tunnel.write(head)
      tunnel.pipe(client)
      client.pipe(tunnel)
    })
    tunnel.on('error', () => client.destroy())
    client.on('error', () => tunnel.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}
