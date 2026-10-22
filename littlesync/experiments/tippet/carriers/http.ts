// a link over http long-poll, for a device that can only make requests (the cardputer, with
// esp_http_client). the wire, both ways: frames (a 4-byte big-endian length, then a message), back
// to back
//
//   POST url/send?link=<id>&ack=<k>   body: frames, 1 MB at most (413 past it)
//   GET  url/recv?link=<id>&ack=<k>   answer: a number (4 bytes big-endian), then frames
//
// a client makes a fresh link id each time it links. the server numbers what it queues for a link
// from 1. an answer's number is that of its last message; ack is the last one the client got. what
// comes after ack is sent again until a later recv acks it, so an answer lost on the way is not lost.
// with nothing queued, a recv is answered empty after about 25 s. a link with no recv for 60 s, or
// with more than 8 MB queued, is closed. ack past 0 on a link the server doesn't hold (it restarted,
// or closed it): 410. ack behind what the server still holds, or past what it sent (two clients on
// one id): 409. either way the client's link closes, and its host links again. room=<bytes> on the
// first request: the link's room
//
//   sync.link(poll("https://galaxy.example/tippet/pigs"))                // client
//   const http = httpLinks((link) => sync.link(link))                     // server
//   Deno.serve((req) => http(req) ?? new Response(null, { status: 404 }))
//   http.close()
import type { Link } from "../sync.ts"

const WAIT = 25_000, UNHEARD = 60_000, AGAIN = 1_000
// the most bytes of a send's body, and of what a link may hold unacked
const BODY = 1024 * 1024, QUEUE = 8 * 1024 * 1024
// room for steps in a send's body: what's left past the envelope and each step's length
const ROOM = BODY - BODY / 16

// messages, framed
export function frames(list: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(list.reduce((n, b) => n + 4 + b.length, 0))
	const view = new DataView(out.buffer)
	let at = 0
	for (const b of list) {
		view.setUint32(at, b.length)
		out.set(b, at + 4)
		at += 4 + b.length
	}
	return out
}

// frames, as messages; undefined: not whole frames
export function unframe(bytes: Uint8Array): Uint8Array[] | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const out: Uint8Array[] = []
	let at = 0
	while (at + 4 <= bytes.length) {
		const end = at + 4 + view.getUint32(at)
		if (end > bytes.length) return undefined
		out.push(bytes.slice(at + 4, end))
		at = end
	}
	return at === bytes.length ? out : undefined
}

// the client: one link, its id made here
export function poll(url: string, o: { room?: number } = {}): Link {
	const id = crypto.randomUUID()
	const at = (path: string) =>
		`${url}/${path}?link=${id}&ack=${ack}${o.room ? `&room=${o.room}` : ""}`
	const stop = new AbortController()
	const outbox: Uint8Array[] = []
	const closers: (() => void)[] = []
	let posting = false, ack = 0
	// a pause before trying again, cut short by close
	const rest = () =>
		new Promise<void>((r) => {
			if (stop.signal.aborted) return r()
			const t = setTimeout(done, AGAIN)
			function done() {
				clearTimeout(t)
				r()
			}
			stop.signal.addEventListener("abort", done, { once: true })
		})
	// 410: the server doesn't hold this link; 409: another client has its id
	const gone = (status: number) => (status === 410 || status === 409) && (close(), true)

	async function post() {
		if (posting) return
		posting = true
		while (outbox.length && !stop.signal.aborted) {
			// as many as fit in one body
			let n = 0, size = 0
			while (n < outbox.length && size + 4 + outbox[n].length <= BODY) {
				size += 4 + outbox[n++].length
			}
			try {
				const res = await fetch(at("send"), {
					method: "POST",
					body: frames(outbox.slice(0, n)),
					signal: stop.signal,
				})
				await res.body?.cancel()
				if (gone(res.status)) break
				if (!res.ok) throw new Error(`send: ${res.status}`)
				outbox.splice(0, n)
			} catch {
				await rest()
			}
		}
		posting = false
	}

	async function listen(fn: (bytes: Uint8Array) => void) {
		while (!stop.signal.aborted) {
			try {
				const res = await fetch(at("recv"), { signal: stop.signal })
				const bytes = new Uint8Array(await res.arrayBuffer())
				if (gone(res.status)) break
				const got = res.ok && bytes.length >= 4 ? unframe(bytes.subarray(4)) : undefined
				if (!got) throw new Error(`recv: ${res.status}`)
				const k = new DataView(bytes.buffer).getUint32(0), first = k - got.length + 1
				got.forEach((b, i) => first + i > ack && fn(b))
				ack = Math.max(ack, k)
			} catch {
				await rest()
			}
		}
	}

	function close() {
		if (stop.signal.aborted) return
		stop.abort()
		for (const f of closers) f()
	}

	return {
		room: Math.min(o.room ?? Infinity, ROOM),
		send(b) {
			if (stop.signal.aborted) return
			if (4 + b.length > BODY) throw new Error("bigger than a send's body")
			outbox.push(b)
			void post()
		},
		onMessage: (fn) => void listen(fn),
		onClose: (fn) => void closers.push(fn),
		close,
	}
}

// a link as the server holds it: queue, what's not yet acked, and its bytes; sent: how many it has
// ever queued; waiting: its recvs waiting for something to answer with
type Held = {
	link: Link
	queue: Uint8Array[]
	bytes: number
	sent: number
	fn?: (bytes: Uint8Array) => void
	closers: (() => void)[]
	unheard?: ReturnType<typeof setTimeout>
	waiting: Set<() => void>
}

const answer = (body: BodyInit | null, status = 200) =>
	new Response(body, { status, headers: { "access-control-allow-origin": "*" } })

// a request's body; undefined: more than BODY bytes
async function body(req: Request): Promise<Uint8Array | undefined> {
	if (Number(req.headers.get("content-length")) > BODY) return undefined
	const parts: Uint8Array[] = []
	let size = 0
	if (req.body) {
		for await (const p of req.body) {
			if ((size += p.length) > BODY) return undefined
			parts.push(p)
		}
	}
	const out = new Uint8Array(size)
	parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
	return out
}

// the server: one link per link id, made on first contact. undefined: not a send or recv
export function httpLinks(onLink: (link: Link) => void) {
	const held = new Map<string, Held>()
	const wake = (h: Held) => h.waiting.forEach((f) => f())

	function drop(id: string) {
		const h = held.get(id)
		if (!h) return
		held.delete(id)
		clearTimeout(h.unheard)
		wake(h)
		for (const f of h.closers) f()
	}
	function heard(id: string, h: Held) {
		clearTimeout(h.unheard)
		h.unheard = setTimeout(() => drop(id), UNHEARD)
	}
	function hold(id: string, url: URL): Held {
		let h = held.get(id)
		if (h) return h
		const link: Link = {
			room: Number(url.searchParams.get("room")) || undefined,
			send(b) {
				if (held.get(id) !== h) return
				h!.queue.push(b)
				h!.sent++
				if ((h!.bytes += b.length) > QUEUE) return drop(id)
				wake(h!)
			},
			onMessage: (fn) => void (h!.fn = fn),
			onClose: (fn) => void h!.closers.push(fn),
			close: () => drop(id),
		}
		held.set(id, h = { link, queue: [], bytes: 0, sent: 0, closers: [], waiting: new Set() })
		heard(id, h)
		onLink(link)
		return h
	}

	async function recv(h: Held, ack: number, signal: AbortSignal) {
		const first = h.sent - h.queue.length + 1
		// behind what's held, or past what was sent: another client on this id
		if (ack < first - 1 || ack > h.sent) return answer(null, 409)
		for (const b of h.queue.splice(0, ack - first + 1)) h.bytes -= b.length
		if (!h.queue.length) {
			await new Promise<void>((r) => {
				const t = setTimeout(done, WAIT)
				function done() {
					clearTimeout(t)
					signal.removeEventListener("abort", done)
					h.waiting.delete(done)
					r()
				}
				h.waiting.add(done)
				signal.addEventListener("abort", done)
			})
		}
		// as many as fit in its room, one at least
		let n = 0, size = 0
		while (
			n < h.queue.length && (!n || size + 4 + h.queue[n].length <= (h.link.room ?? Infinity))
		) {
			size += 4 + h.queue[n++].length
		}
		const out = new Uint8Array(4 + size)
		new DataView(out.buffer).setUint32(0, h.sent - h.queue.length + n)
		out.set(frames(h.queue.slice(0, n)), 4)
		return answer(out)
	}

	async function send(h: Held, req: Request) {
		const bytes = await body(req)
		if (!bytes) return answer(null, 413)
		const list = unframe(bytes)
		if (!list) return answer(null, 400)
		for (const b of list) h.fn?.(b)
		return answer(null, 204)
	}

	function handle(req: Request): Promise<Response> | undefined {
		const url = new URL(req.url), what = url.pathname.split("/").pop()
		if (what !== "send" && what !== "recv") return undefined
		const id = url.searchParams.get("link"), ack = Number(url.searchParams.get("ack"))
		if (!id || id.length > 64 || !Number.isSafeInteger(ack) || ack < 0) {
			return Promise.resolve(answer(null, 400))
		}
		// a link made again here would number from 1 again: the client links again instead
		if (!held.has(id) && ack > 0) return Promise.resolve(answer(null, 410))
		const h = hold(id, url)
		if (what === "send") return send(h, req).catch(() => answer(null, 400))
		// only a recv is heard: a client that never acks is let go
		heard(id, h)
		return recv(h, ack, req.signal).catch(() => answer(null, 400))
			.finally(() => held.get(id) === h && heard(id, h))
	}

	return Object.assign(handle, {
		// every link closed, and every recv answered
		close: () => [...held.keys()].forEach(drop),
	})
}
