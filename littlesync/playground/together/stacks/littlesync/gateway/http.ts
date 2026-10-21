// littlesync over plain HTTP/1.1, for a device with an HTTP client and no WebSocket
// (esp_http_client): a session is one link (gateway.open), named by the device. README.md, http.
//   POST /littlesync/<session>?wait=ms&most=bytes   body: bytes up (any: frames, half a frame,
//                                                  none); answer: bytes down, whole frames
//   GET  /littlesync/<session>?wait=ms&most=bytes   the same with nothing up
//   DELETE /littlesync/<session>                    the session ends now
// the answer is the frames waiting, at once; none waiting, it waits up to wait ms for some (0 when
// not given). most: the answer's bytes at most (whole frames; one frame always goes, however big).
// a session unknown (new, ended, or the gateway began again) is opened by its first request; one
// with no request for IDLE ms ends (its link closes: its holds stop). a newer waiting request ends
// the one waiting before it (empty). frames waiting past QUEUE bytes: the oldest go (littlesync
// resends what is not acked), as frames lost on a line
import type { Conn, Gateway } from "./gateway.ts"

export const SESSION = /^[A-Za-z0-9_-]{8,64}$/
// ms: the longest wait, the default most, how long a session lasts with no request
export const WAIT = 25000
export const MOST = 16384
export const IDLE = 30000
// bytes: the most a request may carry; frames kept waiting per session
export const BODY = 65536
export const QUEUE = 262144
// sessions at once
export const SESSIONS = 256
// a waiting request answers this long after the first frame for it, so frames sent together go
// together
const GATHER = 5

type Poll = { most: number; answer: (r: Response) => void; timer?: ReturnType<typeof setTimeout> }

type Session = {
	id: string
	conn: Conn
	frames: Uint8Array[]
	bytes: number
	last: number
	poll?: Poll
}

export type Sessions = {
	// a request for /littlesync/<id>: its answer
	handle(req: Request, id: string): Promise<Response>
	// sessions with no request for IDLE ms end. call it every second or so
	tick(): void
	count(): number
	close(): void
}

const octets = { "content-type": "application/octet-stream", "cache-control": "no-store" }
const plain = (status: number, text: string) =>
	new Response(text + "\n", { status, headers: { "content-type": "text/plain" } })

// the frames in bytes from link.next: each 0x00 … 0x00, back to back
function split(bytes: Uint8Array): Uint8Array[] {
	const out: Uint8Array[] = []
	let from = -1
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== 0) continue
		if (from < 0 || i === from + 1) from = i
		else out.push(bytes.slice(from, i + 1)), from = -1
	}
	return out
}

export function createSessions(
	gateway: Gateway,
	options: { idle?: number; now?: () => number; log?: (line: string) => void } = {},
): Sessions {
	const idle = options.idle ?? IDLE
	const now = options.now ?? Date.now
	const log = options.log ?? (() => {})
	const sessions = new Map<string, Session>()

	// frames for the session's waiting request, if any: answered (after GATHER ms)
	function answer(s: Session, p: Poll) {
		if (p.timer !== undefined) clearTimeout(p.timer)
		if (s.poll === p) s.poll = undefined
		s.last = now()
		p.answer(new Response(take(s, p.most), { headers: octets }))
	}

	// whole frames off the front, most bytes at most (one at least)
	function take(s: Session, most: number): Uint8Array<ArrayBuffer> {
		let n = 0, size = 0
		while (n < s.frames.length && (n === 0 || size + s.frames[n].length <= most)) {
			size += s.frames[n++].length
		}
		const out = new Uint8Array(size)
		let at = 0
		for (const f of s.frames.splice(0, n)) out.set(f, at), at += f.length
		s.bytes -= size
		return out
	}

	function open(id: string): Session {
		const s = { id, frames: [], bytes: 0, last: now() } as unknown as Session
		s.conn = gateway.open((bytes) => {
			for (const f of split(bytes)) s.frames.push(f), s.bytes += f.length
			while (s.bytes > QUEUE && s.frames.length > 1) s.bytes -= s.frames.shift()!.length
			const p = s.poll
			if (p && p.timer === undefined) p.timer = setTimeout(() => answer(s, p), GATHER)
		})
		sessions.set(id, s)
		log(`http ${id}: open`)
		return s
	}

	function end(s: Session, why: string) {
		sessions.delete(s.id)
		if (s.poll) answer(s, s.poll)
		s.conn.close()
		log(`http ${s.id}: ${why}`)
	}

	return {
		async handle(req, id) {
			if (!SESSION.test(id)) return plain(400, "a session: 8 to 64 of A-Z a-z 0-9 _ -")
			let s = sessions.get(id)
			if (req.method === "DELETE") {
				if (s) end(s, "ended")
				return new Response(null, { status: 204 })
			}
			if (req.method !== "POST" && req.method !== "GET") return plain(405, "POST, GET, DELETE")
			const url = new URL(req.url)
			const number = (k: string, d: number) => {
				const v = Number(url.searchParams.get(k) ?? d)
				return Number.isFinite(v) && v >= 0 ? v : d
			}
			const wait = Math.min(number("wait", 0), WAIT), most = Math.max(1, number("most", MOST))
			const length = Number(req.headers.get("content-length") ?? 0)
			if (length > BODY) return plain(413, `at most ${BODY} bytes up`)
			const up = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined
			if (up && up.length > BODY) return plain(413, `at most ${BODY} bytes up`)
			if (!s) {
				if (sessions.size >= SESSIONS) return plain(503, "too many sessions")
				s = open(id)
			}
			s.last = now()
			// a newer request: the one waiting before it ends now
			if (s.poll) answer(s, s.poll)
			if (up?.length) s.conn.feed(up)
			if (s.frames.length || wait === 0) {
				return new Response(take(s, most), { headers: octets })
			}
			const session = s
			return await new Promise<Response>((resolve) => {
				const p: Poll = { most, answer: resolve }
				session.poll = p
				const timer = setTimeout(() => answer(session, p), wait)
				const was = p.answer
				p.answer = (r) => (clearTimeout(timer), was(r))
				req.signal?.addEventListener("abort", () => {
					if (session.poll !== p) return
					session.poll = undefined
					if (p.timer !== undefined) clearTimeout(p.timer)
					clearTimeout(timer)
				})
			})
		},
		tick() {
			const t = now()
			for (const s of [...sessions.values()]) {
				if (!s.poll && t - s.last > idle) end(s, "idle")
			}
		},
		count: () => sessions.size,
		close() {
			for (const s of [...sessions.values()]) end(s, "closed")
		},
	}
}
