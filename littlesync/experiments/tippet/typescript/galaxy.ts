// galaxy: just another peer. per room, a log on disk and a sync that relays, and no graph and no
// signer: it checks every step's chain and signature (log.take) and never reads a patch. a room is
// loaded on use, and let go (its log closed) once it has had no links for 5 minutes. at most 1000
// are open: past that the one least recently written is let go, links or not. its dir is made on
// its first kept run
//
//   /tippet/<room>          a websocket (carriers/websocket.ts)
//   /tippet/<room>/send     http long-poll (carriers/http.ts)
//   /tippet/<room>/recv
//
//   const galaxy = createGalaxy({ dir: "./tippet-data" })   // at: where it answers, "/tippet" when none
//   Deno.serve(galaxy.handler)
//   await galaxy.close()
//
//   PORT=8090 DIR=./tippet-data deno run --allow-net --allow-read --allow-write typescript/galaxy.ts
import { createLog, type Log } from "./log.ts"
import { createSync, type Sync } from "./sync.ts"
import { fileStore } from "./store_file.ts"
import { socket } from "./carriers/websocket.ts"
import { httpLinks } from "./carriers/http.ts"
import { hex } from "./step.ts"
import { blake3 } from "@ermine/blake3"

// written: when it last kept a run, 0 never
type Room = {
	log: Log
	sync: Sync
	http: ReturnType<typeof httpLinks>
	sockets: Set<WebSocket>
	written: number
	timer?: ReturnType<typeof setTimeout>
}

// idle: how long a room with no links stays open (ms); most: how many rooms are open at once
export function createGalaxy(o: { dir: string; at?: string; idle?: number; most?: number }) {
	const at = (o.at ?? "/tippet") + "/"
	const idle = o.idle ?? 5 * 60_000, most = o.most ?? 1000
	// rooms open or opening; loaded: those open; closing: those being let go, until their log is
	// on disk
	const rooms = new Map<string, Promise<Room>>()
	const loaded = new Map<string, Room>()
	const closing = new Map<string, Promise<void>>()

	function free(n: string, r: Room) {
		clearTimeout(r.timer)
		rooms.delete(n), loaded.delete(n)
		r.http.close()
		for (const ws of r.sockets) ws.close()
		const done: Promise<void> = r.log.close().catch(() => {})
			.finally(() => closing.get(n) === done && closing.delete(n))
		closing.set(n, done)
	}

	// a room, loaded from disk on use. its dir is its name's hash, so names that a filesystem folds
	// together (case, unicode normalization) stay apart
	function room(n: string): Promise<Room> {
		let r = rooms.get(n)
		if (r) return r
		if (rooms.size >= most) {
			let oldest: [string, Room] | undefined
			for (const e of loaded) if (!oldest || e[1].written < oldest[1].written) oldest = e
			if (oldest) free(...oldest)
		}
		r = (async () => {
			await closing.get(n)
			const dir = `${o.dir}/${hex(blake3(new TextEncoder().encode(n)))}`
			const log = createLog({ store: fileStore(dir) })
			await log.load()
			const sync = createSync({ log, relay: true })
			const room: Room = {
				log,
				sync,
				http: httpLinks((link) => sync.link(link)),
				sockets: new Set<WebSocket>(),
				written: 0,
			}
			log.on(() => room.written = Date.now())
			// counted idle from its last link gone, until it is let go
			const linked = () => {
				clearTimeout(room.timer)
				if (loaded.get(n) !== room) return
				if (!sync.links) room.timer = setTimeout(() => free(n, room), idle)
			}
			loaded.set(n, room)
			sync.onLinks(linked)
			linked()
			return room
		})()
		rooms.set(n, r)
		r.catch(() => rooms.delete(n))
		return r
	}

	async function handler(req: Request): Promise<Response> {
		const path = new URL(req.url).pathname
		const parts = path.startsWith(at) ? path.slice(at.length).split("/") : []
		if (parts.length < 1 || parts.length > 2) return new Response("not found", { status: 404 })
		let n = ""
		try {
			n = decodeURIComponent(parts[0])
		} catch {
			// not a name
		}
		if (["", ".", ".."].includes(n) || n.includes("/")) {
			return new Response("not a room", { status: 400 })
		}
		if (parts.length === 2 && parts[1] !== "send" && parts[1] !== "recv") {
			return new Response("not found", { status: 404 })
		}
		if (parts.length === 1 && req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("a websocket, or /send and /recv", { status: 426 })
		}
		const r = await room(n)
		if (parts.length === 2) return r.http(req)!
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
			await Promise.allSettled(rooms.values())
			for (const [n, r] of loaded) free(n, r)
			await Promise.all(closing.values())
		},
		// how many rooms are open
		get open() {
			return rooms.size
		},
	}
}

if (import.meta.main) {
	const galaxy = createGalaxy({ dir: Deno.env.get("DIR") ?? "./tippet-data" })
	Deno.serve({ port: Number(Deno.env.get("PORT") ?? 8090) }, galaxy.handler)
}
