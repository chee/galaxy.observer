// the front: what the server passes through for /littlesync, in one process with the gateway. the
// tippet galaxy (experiments/tippet/galaxy.ts) answers /littlesync/tippet/<room>; everything else
// goes on to the gateway, on its own port, as it came (a websocket piped both ways)
//   FRONT_PORT   where the server sends /littlesync, default 8081
//   PORT         the gateway's own port (main.ts), default 8080
//   TIPPET_DIR   the tippet rooms' logs, default ./tippet-data
import "./playground/together/stacks/littlesync/gateway/main.ts"
import { createGalaxy } from "./experiments/tippet/galaxy.ts"

const env = (k: string) => Deno.env.get(k) || undefined
const gateway = `127.0.0.1:${env("PORT") ?? 8080}`
const tippet = createGalaxy({ dir: env("TIPPET_DIR") ?? "./tippet-data", at: "/littlesync/tippet" })

// a websocket to the gateway, the client's messages held until it opens
function pipe(req: Request, url: URL): Response {
	const { socket: outer, response } = Deno.upgradeWebSocket(req)
	const inner = new WebSocket(`ws://${gateway}${url.pathname}${url.search}`)
	outer.binaryType = inner.binaryType = "arraybuffer"
	const held: (string | ArrayBuffer)[] = []
	outer.onmessage = (e) => inner.readyState === WebSocket.OPEN ? inner.send(e.data) : held.push(e.data)
	inner.onopen = () => held.splice(0).forEach((m) => inner.send(m))
	inner.onmessage = (e) => outer.readyState === WebSocket.OPEN && outer.send(e.data)
	const end = () => {
		if (outer.readyState <= WebSocket.OPEN) outer.close()
		if (inner.readyState <= WebSocket.OPEN) inner.close()
	}
	outer.onclose = outer.onerror = inner.onclose = inner.onerror = end
	return response
}

Deno.serve({ port: Number(env("FRONT_PORT") ?? 8081) }, (req) => {
	const url = new URL(req.url)
	if (url.pathname.startsWith("/littlesync/tippet/")) return tippet.handler(req)
	if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return pipe(req, url)
	return fetch(new Request(`http://${gateway}${url.pathname}${url.search}`, req))
})
