// sync: a log's steps, caught up over links (WIRE.md, messages). a link is anything that carries
// bytes both ways (carriers/). each side says what it has, and is sent what it lacks, a run at a
// time; a step added later goes to every link that lacks it. live things are passed on, never kept
//
//   const sync = createSync({ log })
//   const unlink = sync.link(link)
//   sync.live(bytes); sync.onLive((bytes) => ...)
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import type { Log } from "./log.ts"
import { pack, type Packed, unpack } from "./pack.ts"
import { decodeStep, hex, key, unhex, whole } from "./step.ts"

export type Link = {
	send(bytes: Uint8Array): void
	onMessage(fn: (bytes: Uint8Array) => void): void
	onClose?(fn: () => void): void
	close?(): void
	// one link to any number of peers (a broadcast): what they have is not kept, only answered, and
	// with this device's own steps alone
	many?: boolean
	// kept once it can take more: a run goes only after it
	wait?(): Promise<void>
}

// theirs: how many of each device's steps it has, or has been sent; pushing: by device, the push
// going on, and whether it was asked again while it ran; refused: devices it refused; turn: its
// runs, one after another
type Linked = {
	link: Link
	theirs: Map<string, number>
	pushing: Map<string, boolean>
	refused: Set<string>
	turn: Promise<void>
}
// refused: n, how many of the device's steps the refusing side holds. devices hex, as the log has
// them; a live id hex
export type Message =
	| { t: "have"; have: Record<string, number> }
	| { t: "run"; device: string; sig: Uint8Array; pack: Packed }
	| { t: "refused"; device: string; n: number }
	| { t: "live"; id: string; data: Uint8Array }

const sized = (x: unknown, n: number) => x instanceof Uint8Array && x.length === n
// a message as this side reads it, or undefined
export function read(b: Uint8Array): Message | undefined {
	let m: unknown
	try {
		m = decode(b)
	} catch {
		return undefined
	}
	if (!Array.isArray(m)) return undefined
	const [t, x, y, z] = m
	if (t === "have" && m.length === 2 && Array.isArray(x)) {
		const have: Record<string, number> = {}
		for (const e of x) {
			if (!Array.isArray(e) || e.length !== 2 || !key(e[0]) || !whole(e[1])) return undefined
			have[hex(e[0])] = e[1]
		}
		return { t, have }
	}
	if (t === "run" && m.length === 4 && key(x) && sized(y, 64) && Array.isArray(z)) {
		return { t, device: hex(x), sig: y, pack: z as Packed }
	}
	if (t === "refused" && m.length === 3 && key(x) && whole(y)) return { t, device: hex(x), n: y }
	if (t === "live" && m.length === 3 && sized(x, 8) && y instanceof Uint8Array) {
		return { t, id: hex(x), data: y }
	}
}

// a message's bytes
export function wire(m: Message): Uint8Array {
	const a = m.t === "have"
		? [m.t, Object.entries(m.have).map(([d, n]) => [unhex(d), n])]
		: m.t === "run"
		? [m.t, unhex(m.device), m.sig, m.pack]
		: m.t === "refused"
		? [m.t, unhex(m.device), m.n]
		: [m.t, unhex(m.id), m.data]
	return encode(a as Value)
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
	const drop = (l: Linked) => links.delete(l) && tell()
	// a link that can't send any more is gone, and closed
	const send = (l: Linked, bytes: Uint8Array) => {
		try {
			l.link.send(bytes)
		} catch {
			drop(l)
			l.link.close?.()
		}
	}
	const say = (l: Linked, m: Message) => send(l, wire(m))
	const have = (): Message => ({ t: "have", have: log.have() })

	// one run of a device's to a link, once the link can take it; false: nothing more to send
	async function one(l: Linked, device: string): Promise<boolean> {
		await l.link.wait?.()
		const from = (l.theirs.get(device) ?? 0) + 1
		if (!links.has(l) || l.refused.has(device) || from > log.count(device)) return false
		const b = await log.run(device, from)
		if (!b) return false
		// they said what they have meanwhile: this run may not be what they lack
		if (!links.has(l) || (l.theirs.get(device) ?? 0) !== from - 1) return true
		say(l, { t: "run", device, sig: b.sig, pack: pack(b.steps) })
		l.theirs.set(device, from + b.steps.length - 1)
		return true
	}
	// a device's steps to one link, a run at a time, until it has them all, in turn with the
	// link's other pushes. one per link and device: asked again while it runs, it goes on
	function push(l: Linked, device: string) {
		if (l.pushing.has(device)) return void l.pushing.set(device, true)
		l.pushing.set(device, false)
		const turn = async () => {
			let more = false
			try {
				more = await one(l, device)
			} catch {
				// a store that can't be read: this push ends
			}
			if (more || l.pushing.get(device)) {
				l.pushing.set(device, false)
				l.turn = l.turn.then(turn)
			} else l.pushing.delete(device)
		}
		l.turn = l.turn.then(turn)
	}

	async function receive(l: Linked, bytes: Uint8Array) {
		const m = read(bytes)
		if (!m) return
		const many = l.link.many
		if (m.t === "have") {
			// on a broadcast, each says what is its own
			const me = log.device
			if (many) {
				if (me === undefined) return
				l.theirs.set(me, Math.min(l.theirs.get(me) ?? 0, m.have[me] ?? 0))
				return push(l, me)
			}
			l.theirs = new Map(Object.entries(m.have))
			for (const [d, n] of Object.entries(log.have())) if ((m.have[d] ?? 0) < n) push(l, d)
		} else if (m.t === "run") {
			// last: the n of the run's last step, which they hold
			let r, last = 0
			try {
				const steps = unpack(m.pack)
				last = decodeStep(steps[0]).n + steps.length - 1
				r = await log.take({ device: m.device, steps, sig: m.sig }, l)
			} catch {
				r = { refused: "pack" }
			}
			// a gap: say what this side has, and it is sent again from there. refused for good: say
			// so, and it is sent no more
			if ("added" in r) {
				l.theirs.set(m.device, Math.max(l.theirs.get(m.device) ?? 0, last))
			} else if (r.refused === "gap") say(l, have())
			else if (!many) say(l, { t: "refused", device: m.device, n: log.count(m.device) })
		} else if (m.t === "refused") {
			// one peer of a broadcast refusing is not the rest refusing
			if (!many && log.count(m.device)) l.refused.add(m.device)
		} else {
			if (seen.has(m.id)) return
			mark(m.id)
			for (const f of lives) f(m.data)
			if (o.relay) { for (const other of links) if (other !== l) send(other, bytes) }
		}
	}

	// steps added (written here, or taken): to every link that lacks them, but the one they came on
	log.on((device, _, from) => {
		for (const l of links) if (l !== from) push(l, device)
	})

	return {
		link(link: Link): () => void {
			// a broadcast is sent only what comes from now on, and what its peers say they lack
			const theirs = new Map(
				link.many ? Object.keys(log.have()).map((d) => [d, log.count(d)]) : [],
			)
			const l: Linked = {
				link,
				theirs,
				pushing: new Map(),
				refused: new Set(),
				turn: Promise.resolve(),
			}
			links.add(l)
			link.onMessage((b) => void receive(l, b))
			link.onClose?.(() => drop(l))
			say(l, have())
			tell()
			return () => {
				drop(l)
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
			const id = crypto.getRandomValues(new Uint8Array(8))
			mark(hex(id))
			const b = wire({ t: "live", id: hex(id), data })
			for (const l of links) send(l, b)
		},
		onLive(f: (data: Uint8Array) => void) {
			lives.push(f)
			return () => void lives.splice(lives.indexOf(f), 1)
		},
	}
}
