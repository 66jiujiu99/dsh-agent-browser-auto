// 仅服务固定的本地 E2E 页面；默认随机端口，避免占用用户已有服务。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const fixture = new URL('./browser-e2e.html', import.meta.url)
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
  if (pathname !== '/' && pathname !== '/browser-e2e.html') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('not found')
    return
  }
  try {
    const html = await readFile(fixture)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(String(error && error.message ? error.message : error))
  }
})
server.listen(Number(process.env.PORT || 0), '127.0.0.1', () => {
  const address = server.address()
  console.log(`http://127.0.0.1:${address.port}/browser-e2e.html`)
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
