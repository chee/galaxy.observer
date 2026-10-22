// galaxy: just another peer. per room, a log on disk and a sync that relays, and no graph and no
// signer: it checks every step's chain and signature (log.take) and never reads a patch
//
//   /tippet/<room>          a websocket (carriers/websocket.ts)
//   /tippet/<room>/send     http long-poll (carriers/http.ts)
//   /tippet/<room>/recv
//
//   const galaxy = createGalaxy({ dir: "./tippet-data" })   // at: where it answers, "/tippet" when none
//   Deno.serve(galaxy.handler)
//   await galaxy.close()
//
//   PORT=8090 DIR=./tippet-data deno run --allow-net --allow-read --allow-write galaxy.ts
import { createLog, type Log } from "./log.ts"
import { createSync, type Sync } from "./sync.ts"
import { fileStore } from "./store_file.ts"
import { socket } from "./carriers/websocket.ts"
import { httpLinks } from "./carriers/http.ts"
import { hex } from "./step.ts"
import { blake3 } from "@ermine/blake3"

type Room = { log: Log; sync: Sync; http: ReturnType<typeof httpLinks>; sockets: Set<WebSocket> }

// a room's name from its url-encoded form; undefined: not a name
function name(raw: string): string | undefined {
	let s: string
	try {
		s = decodeURIComponent(raw)
	} catch {
		return undefined
	}
	return s === "" || s === "." || s === ".." || s.includes("/") ? undefined : s
}

export function createGalaxy(o: { dir: string; at?: string }) {
	const at = (o.at ?? "/tippet") + "/"
	const rooms = new Map<string, Promise<Room>>()

	// a room, made on first use and loaded from disk. its dir is its name's hash, so names that a
	// filesystem folds together (case, unicode normalization) stay apart
	function room(n: string): Promise<Room> {
		let r = rooms.get(n)
		if (!r) {
			r = (async () => {
				const dir = `${o.dir}/${hex(blake3(new TextEncoder().encode(n)))}`
				const log = createLog({ store: fileStore(dir) })
				await log.load()
				const sync = createSync({ log, relay: true })
				return {
					log,
					sync,
					http: httpLinks((link) => sync.link(link)),
					sockets: new Set<WebSocket>(),
				}
			})()
			rooms.set(n, r)
			r.catch(() => rooms.delete(n))
		}
		return r
	}

	async function handler(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname
		const parts = path.startsWith(at) ? path.slice(at.length).split("/") : []
		if (parts.length < 1 || parts.length > 2) return new Response("not found", { status: 404 })
		const n = name(parts[0])
		if (n === undefined) return new Response("not a room", { status: 400 })
		if (parts.length === 2) {
			if (parts[1] !== "send" && parts[1] !== "recv") {
				return new Response("not found", { status: 404 })
			}
			return (await room(n)).http(req)!
		}
		if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("a websocket, or /send and /recv", { status: 426 })
		}
		const r = await room(n)
		const { socket: ws, response } = Deno.upgradeWebSocket(req)
		r.sockets.add(ws)
		ws.addEventListener("close", () => r.sockets.delete(ws))
		r.sync.link(socket(ws))
		return response
	}

	return {
		handler,
		// every link closed, and every record on disk
		async close() {
			for (const r of await Promise.all(rooms.values())) {
				r.http.close()
				for (const ws of r.sockets) ws.close()
				await r.log.saved()
			}
			rooms.clear()
		},
	}
}

if (import.meta.main) {
	const galaxy = createGalaxy({ dir: Deno.env.get("DIR") ?? "./tippet-data" })
	Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8090) }, galaxy.handler)
}
