// sync: a log's steps, caught up over links. a link is anything that carries bytes both ways
// (carriers/). each side says what it has ({t: "have"}), and is sent what it lacks ({t: "batch"}, its
// steps packed: pack.ts);
// a step added later goes to every link that lacks it, whoever wrote it. live things ({t: "live"})
// are sent on and never kept; a relay (galaxy) passes them to its other links. a message that isn't
// one of these is dropped
//
//   const sync = createSync({ log })
//   const unlink = sync.link(link)
//   sync.live(bytes); sync.onLive((bytes) => ...)
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import type { Log } from "./log.ts"
import { pack, type Packed, unpack } from "./pack.ts"

export type Link = {
	send(bytes: Uint8Array): void
	onMessage(fn: (bytes: Uint8Array) => void): void
	onClose?(fn: () => void): void
	close?(): void
	// one link to any number of peers (a broadcast): what they have is not kept, only answered
	many?: boolean
	// the most bytes of steps one message may carry (a small device's buffer)
	room?: number
}

type Linked = { link: Link; theirs: Map<string, number> }
type Message =
	| { t: "have"; have: Record<string, number> }
	| { t: "batch"; device: string; pack: Packed; sig: Uint8Array }
	| { t: "live"; id: string; data: Uint8Array }

const isMap = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x) && !ArrayBuffer.isView(x)
// a message as this side reads it, or undefined
function read(bytes: Uint8Array): Message | undefined {
	let m: unknown
	try {
		m = decode(bytes)
	} catch {
		return undefined
	}
	if (!isMap(m)) return undefined
	if (m.t === "have" && isMap(m.have) && Object.values(m.have).every(Number.isInteger)) {
		return m as Message
	}
	if (
		m.t === "batch" && typeof m.device === "string" && m.sig instanceof Uint8Array &&
		isMap(m.pack) && m.pack.first instanceof Uint8Array
	) return m as Message
	if (m.t === "live" && typeof m.id === "string" && m.data instanceof Uint8Array) {
		return m as Message
	}
}

export type Sync = ReturnType<typeof createSync>

export function createSync(o: { log: Log; relay?: boolean }) {
	const { log } = o
	const links = new Set<Linked>()
	const lives: ((data: Uint8Array) => void)[] = []
	// told when a link is added or gone
	const linked: (() => void)[] = []
	const tell = () => linked.forEach((f) => f())
	// live ids lately seen, oldest first
	const seen = new Set<string>()
	const mark = (id: string) => {
		seen.add(id)
		if (seen.size > 1024) seen.delete(seen.values().next().value!)
	}
	const send = (l: Linked, bytes: Uint8Array) => {
		try {
			l.link.send(bytes)
		} catch {
			// a link that can't send any more: dropped when it says it closed
		}
	}

	// a device's steps from n on, to one link, a batch at a time
	async function push(l: Linked, device: string, from: number) {
		while (from <= log.count(device)) {
			const b = await log.batch(device, from, l.link.room)
			if (!b) return
			send(
				l,
				encode({ t: "batch", device, pack: pack(b.steps), sig: b.sig } as unknown as Value),
			)
			from += b.steps.length
			if (!l.link.many) l.theirs.set(device, Math.max(l.theirs.get(device) ?? 0, from - 1))
		}
	}
	// all it lacks, by what it said it has
	function offer(l: Linked, have: Record<string, number>) {
		for (const [d, n] of Object.entries(log.have())) {
			const from = (have[d] ?? 0) + 1
			if (from <= n) void push(l, d, from)
		}
	}

	async function receive(l: Linked, bytes: Uint8Array) {
		const m = read(bytes)
		if (!m) return
		if (m.t === "have") {
			if (!l.link.many) l.theirs = new Map(Object.entries(m.have))
			offer(l, m.have)
		} else if (m.t === "batch") {
			let r
			try {
				r = await log.take({ device: m.device, steps: unpack(m.pack), sig: m.sig }, l)
			} catch {
				return
			}
			if ("added" in r && !l.link.many) {
				l.theirs.set(m.device, Math.max(l.theirs.get(m.device) ?? 0, log.count(m.device)))
			}
			// a gap: say what this side has, and it is sent again from there
			if ("refused" in r && r.refused === "gap") {
				send(l, encode({ t: "have", have: log.have() } as unknown as Value))
			}
		} else {
			if (seen.has(m.id)) return
			mark(m.id)
			for (const f of lives) f(m.data)
			if (o.relay) { for (const other of links) if (other !== l) send(other, bytes) }
		}
	}

	// steps added (written here, or taken): to every link that lacks them, but the one they came on
	log.on((device, steps, from) => {
		for (const l of links) {
			if (l === from) continue
			const n = l.link.many ? steps[0].n : (l.theirs.get(device) ?? 0) + 1
			if (n <= log.count(device)) void push(l, device, n)
		}
	})

	return {
		link(link: Link): () => void {
			const l: Linked = { link, theirs: new Map() }
			links.add(l)
			link.onMessage((b) => void receive(l, b))
			link.onClose?.(() => links.delete(l) && tell())
			send(l, encode({ t: "have", have: log.have() } as unknown as Value))
			tell()
			return () => {
				if (links.delete(l)) tell()
				link.close?.()
			}
		},
		get links() {
			return links.size
		},
		onLinks(f: () => void) {
			linked.push(f)
			return () => void linked.splice(linked.indexOf(f), 1)
		},
		live(data: Uint8Array) {
			const id = crypto.randomUUID()
			mark(id)
			const bytes = encode({ t: "live", id, data })
			for (const l of links) send(l, bytes)
		},
		onLive(f: (data: Uint8Array) => void) {
			lives.push(f)
			return () => void lives.splice(lives.indexOf(f), 1)
		},
	}
}
