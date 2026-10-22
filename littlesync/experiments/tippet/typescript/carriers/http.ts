// links over http long-poll (WIRE.md, http long-poll), for a device that can only make requests
// (the cardputer, with esp_http_client): poll is the client, httpLinks the server. a client's link
// closes when the server no longer holds it (410, 409), and its host links again
//
//   sync.link(poll("https://galaxy.example/tippet/pigs"))                // client
//   const http = httpLinks((link) => sync.link(link))                     // server
//   Deno.serve((req) => http(req) ?? new Response(null, { status: 404 }))
//   http.close()
import type { Link } from "../sync.ts"

const WAIT = 25_000, UNHEARD = 60_000, AGAIN = 1_000
// the most bytes of a send's body, of what a link may hold unacked, and of what it holds and still
// takes more; the most link ids closed here that are remembered
const BODY = 1024 * 1024, QUEUE = 8 * 1024 * 1024, MORE = 1024 * 1024, GONE = 4096

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
		`${url}/${path}?link=${id}&ack=${ack}&n=${sent + 1}${o.room ? `&room=${o.room}` : ""}`
	const stop = new AbortController()
	// messages not yet taken, and their bytes; sent: how many were taken
	const outbox: Uint8Array[] = []
	let bytes = 0, sent = 0
	const closers: (() => void)[] = []
	// waits for the outbox to empty below half of BODY
	const waiting: (() => void)[] = []
	const roomy = () => {
		if (bytes < BODY / 2 || stop.signal.aborted) waiting.splice(0).forEach((f) => f())
	}
	let posting = false, ack = 0
	// a pause before trying again, cut short by close
	const rest = () =>
		new Promise<void>((r) => {
			if (stop.signal.aborted) return r()
			const t = setTimeout(r, AGAIN)
			stop.signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true })
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
				for (const b of outbox.splice(0, n)) bytes -= b.length
				sent += n
				roomy()
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
		roomy()
		for (const f of closers) f()
	}

	return {
		send(b) {
			if (stop.signal.aborted) return
			if (4 + b.length > BODY) throw new Error("bigger than a send's body")
			// offline too long: let go, and linked again later
			if ((bytes += b.length) > BODY) return close()
			outbox.push(b)
			void post()
		},
		wait: () => new Promise<void>((r) => (waiting.push(r), roomy())),
		onMessage: (fn) => void listen(fn),
		onClose: (fn) => void closers.push(fn),
		close,
	}
}

// a link as the server holds it: queue, what's not yet acked, and its bytes; sent: how many it has
// ever queued; got: how many it has taken; waiting: its recvs waiting for something to answer with;
// roomy: what waits for it to take more
type Held = {
	id: string
	link: Link
	// the most bytes a recv answer carries (room= on the first request)
	room?: number
	queue: Uint8Array[]
	bytes: number
	sent: number
	got: number
	fn?: (bytes: Uint8Array) => void
	closers: (() => void)[]
	unheard?: ReturnType<typeof setTimeout>
	waiting: Set<() => void>
	roomy: (() => void)[]
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
	// link ids closed here lately, oldest first
	const gone = new Set<string>()
	const wake = (h: Held) => h.waiting.forEach((f) => f())
	const more = (h: Held) => {
		if (h.bytes < MORE || held.get(h.id) !== h) h.roomy.splice(0).forEach((f) => f())
	}

	function drop(id: string) {
		const h = held.get(id)
		if (!h) return
		held.delete(id)
		gone.add(id)
		if (gone.size > GONE) gone.delete(gone.values().next().value!)
		clearTimeout(h.unheard)
		wake(h)
		more(h)
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
			wait: () => new Promise((r) => (h!.roomy.push(r), more(h!))),
		}
		h = {
			id,
			link,
			room: Number(url.searchParams.get("room")) || undefined,
			queue: [],
			bytes: 0,
			sent: 0,
			got: 0,
			closers: [],
			waiting: new Set(),
			roomy: [],
		}
		held.set(id, h)
		heard(id, h)
		onLink(link)
		return h
	}

	async function recv(h: Held, ack: number, signal: AbortSignal) {
		const first = h.sent - h.queue.length + 1
		// behind what's held, or past what was sent: another client on this id
		if (ack < first - 1 || ack > h.sent) return answer(null, 409)
		for (const b of h.queue.splice(0, ack - first + 1)) h.bytes -= b.length
		more(h)
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
			n < h.queue.length && (!n || size + 4 + h.queue[n].length <= (h.room ?? Infinity))
		) {
			size += 4 + h.queue[n++].length
		}
		const out = new Uint8Array(4 + size)
		new DataView(out.buffer).setUint32(0, h.sent - h.queue.length + n)
		out.set(frames(h.queue.slice(0, n)), 4)
		return answer(out)
	}

	// n: the number of its first message; 0: not said
	async function send(h: Held, req: Request, n: number) {
		const bytes = await body(req)
		if (!bytes) return answer(null, 413)
		const list = unframe(bytes), first = n || h.got + 1
		if (!list) return answer(null, 400)
		// past what was taken: another client on this id
		if (first > h.got + 1) return answer(null, 409)
		// those taken already, from a send tried again, are passed over
		list.forEach((b, i) => first + i > h.got && h.fn?.(b))
		h.got = Math.max(h.got, first + list.length - 1)
		return answer(null, 204)
	}

	function handle(req: Request): Promise<Response> | undefined {
		const url = new URL(req.url), what = url.pathname.split("/").pop()
		if (what !== "send" && what !== "recv") return undefined
		const id = url.searchParams.get("link"), ack = Number(url.searchParams.get("ack"))
		const n = Number(url.searchParams.get("n") ?? 0)
		if (!id || id.length > 64 || ![ack, n].every((x) => Number.isSafeInteger(x) && x >= 0)) {
			return Promise.resolve(answer(null, 400))
		}
		// a link made again here would number from 1 again: the client links again instead
		if (!held.has(id) && (gone.has(id) || ack > 0 || n > 1)) {
			return Promise.resolve(answer(null, 410))
		}
		const h = hold(id, url)
		if (what === "send") return send(h, req, n).catch(() => answer(null, 400))
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
