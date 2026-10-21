// the gateway as a process: WebSocket connections at /littlesync, each one littlesync link (binary
// messages carry the byte stream), HTTP sessions at /littlesync/<session> (http.ts), and one
// together device, a Subduction peer of the upstream server, kept (dialled again when lost). in
// memory only. README.md says how to run it.
//   PORT              default 8080
//   UPSTREAM          default wss://galaxy.observer
//   UPSTREAM_SERVICE  the server's service name, when it isn't its url's host (a local subduction_cli:
//                     ermine)
//   GATEWAY_SEED      64 hex: the gateway's key (Subduction peer and ephemeral signer) the same on
//                     every start; default a new key each start
//   QUIET             1: no protocol log lines
// GET / gives the counts (Stats) and the last refusals as JSON
import { createSigner } from "../../../typescript/seal.ts"
import { unhex } from "../../../typescript/hex.ts"
import { createGateway } from "./gateway.ts"
import { createSessions } from "./http.ts"
import { dial } from "./socket.ts"

const env = (k: string) => Deno.env.get(k) || undefined
const port = Number(env("PORT") ?? 8080)
const upstream = env("UPSTREAM") ?? "wss://galaxy.observer"
const service = env("UPSTREAM_SERVICE")
const seed = env("GATEWAY_SEED")
const quiet = env("QUIET") === "1"

const signer = await createSigner(seed ? unhex(seed) : undefined)
const stamp = () => new Date().toISOString().slice(11, 23)
const log = quiet ? () => {} : (line: string) => console.log(`${stamp()} ${line}`)
// the upstream's lines are logged even when quiet
const gateway = createGateway({
	signer,
	service: service ?? new URL(upstream).host,
	log: (line) => line.startsWith("upstream") ? console.log(`${stamp()} ${line}`) : log(line),
})
const sessions = createSessions(gateway, { log })

// the server: dialled until it answers, and again whenever it drops
gateway.keep(() => dial(upstream))

setInterval(() => gateway.tick(), 50)
setInterval(() => sessions.tick(), 1000)

Deno.serve(
	{ port, onListen: ({ port }) => console.log(`${stamp()} listening on ${port}`) },
	(req) => {
		const url = new URL(req.url)
		if (url.pathname === "/littlesync") {
			if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
				return new Response("a WebSocket upgrade, please\n", { status: 426 })
			}
			const { socket, response } = Deno.upgradeWebSocket(req)
			socket.binaryType = "arraybuffer"
			let conn: ReturnType<typeof gateway.open> | undefined
			socket.onopen = () => {
				conn = gateway.open((bytes) => {
					if (socket.readyState === WebSocket.OPEN) socket.send(bytes)
				})
			}
			socket.onmessage = (e) => {
				if (e.data instanceof ArrayBuffer) conn?.feed(new Uint8Array(e.data))
			}
			socket.onclose = () => conn?.close()
			socket.onerror = () => conn?.close()
			return response
		}
		if (url.pathname.startsWith("/littlesync/")) {
			return sessions.handle(req, url.pathname.slice("/littlesync/".length))
		}
		if (url.pathname === "/") {
			return Response.json({
				upstream,
				sessions: sessions.count(),
				followed: gateway.followed(),
				stats: gateway.stats,
				refusals: gateway.refusals.slice(-50),
			})
		}
		return new Response("not here\n", { status: 404 })
	},
)
