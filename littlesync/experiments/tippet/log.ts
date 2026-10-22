// the log: every step this device holds, by device, in order, and the signatures that vouch for
// them. it is the store: what is on disk is the log's records, appended, and now and then a
// snapshot (history.ts). it knows nothing of the graph: galaxy holds logs with no graph at all
//
//   const log = createLog({ store, signer })
//   await log.load()
//   log.write({ node, part, patches, when })     // a step of this device's, signed when sent
//   await log.take(batch)                        // another's steps, checked: chain and signature
//   log.on((device, steps, from) => ...)         // steps added, and the link they came on
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { decodeStep, encodeStep, hashStep, same, type Step } from "./step.ts"
import { type Signer, verify } from "./sign.ts"

// a device's steps from some n on, and its signature over the last one's hash
export type Batch = { device: string; steps: Uint8Array[]; sig: Uint8Array }

// where a log keeps itself: records appended in order, and one snapshot, replaced
export type Store = {
	load(): Promise<{ records: Uint8Array[]; snapshot?: Uint8Array }>
	append(record: Uint8Array): Promise<void>
	snapshot(bytes: Uint8Array): Promise<void>
}

export function createMemoryStore(): Store {
	const records: Uint8Array[] = []
	let snap: Uint8Array | undefined
	return {
		load: () => Promise.resolve({ records: [...records], snapshot: snap }),
		append: (r) => (records.push(r), Promise.resolve()),
		snapshot: (b) => (snap = b, Promise.resolve()),
	}
}

// a device's steps and their hashes; sigs: a signature over step n's hash, by n; top: the highest
// step signed
type Feed = {
	steps: Uint8Array[]
	hashes: Uint8Array[]
	sigs: Map<number, Uint8Array>
	top: number
}
type Chained = { steps: Step[]; hashes: Uint8Array[] }
// from: the link they came on; none: written here
export type Told = (device: string, steps: Step[], from?: unknown) => void

export type Log = ReturnType<typeof createLog>

export function createLog(o: { store?: Store; signer?: Signer } = {}) {
	const store = o.store ?? createMemoryStore()
	const me = o.signer
	const feeds = new Map<string, Feed>()
	const told: Told[] = []
	let lamport = 0
	let saving = Promise.resolve()
	let taking: Promise<unknown> = Promise.resolve()
	let signing: Promise<void> | undefined
	const save = (r: Value) => {
		const bytes = encode(r)
		saving = saving.then(() => store.append(bytes))
	}
	const feed = (d: string) => {
		let f = feeds.get(d)
		if (!f) feeds.set(d, f = { steps: [], hashes: [], sigs: new Map(), top: 0 })
		return f
	}

	// steps that go on from a feed's latest, each naming the one before, with their hashes
	function chain(device: string, bytes: Uint8Array[]): Chained | undefined {
		const f = feeds.get(device)
		let n = f?.steps.length ?? 0, before = n ? f!.hashes[n - 1] : null
		const steps: Step[] = [], hashes: Uint8Array[] = []
		for (const b of bytes) {
			const s = decodeStep(b)
			if (s.device !== device || s.n !== n + 1 || !same(s.before, before)) return undefined
			steps.push(s), hashes.push(before = hashStep(b))
			n++
		}
		return { steps, hashes }
	}
	const vouch = (f: Feed, n: number, sig: Uint8Array) => {
		f.sigs.set(n, sig)
		f.top = Math.max(f.top, n)
	}
	// checked steps, in memory
	function keep(device: string, bytes: Uint8Array[], c: Chained) {
		const f = feed(device)
		f.steps.push(...bytes), f.hashes.push(...c.hashes)
		for (const s of c.steps) lamport = Math.max(lamport, s.lamport)
	}
	// checked steps: in memory, on disk, then told
	function add(device: string, bytes: Uint8Array[], c: Chained, from?: unknown) {
		keep(device, bytes, c)
		for (const b of bytes) save({ step: b })
		for (const t of told) t(device, c.steps, from)
	}

	return {
		device: me?.device,
		get lamport() {
			return lamport
		},
		// how many steps of each device's this log holds and can vouch for: up to the last signed
		// (this device's: all), so a peer sends again what came without its signature
		have(): Record<string, number> {
			const h: Record<string, number> = {}
			for (const [d, f] of feeds) h[d] = d === me?.device ? f.steps.length : f.top
			return h
		},
		count: (device: string) => feeds.get(device)?.steps.length ?? 0,
		steps: (device: string): readonly Uint8Array[] => feeds.get(device)?.steps ?? [],
		on(t: Told) {
			told.push(t)
			return () => void told.splice(told.indexOf(t), 1)
		},

		// a step of this device's, made now: lamport one past the highest seen
		write(s: Omit<Step, "device" | "n" | "before" | "lamport">): Step {
			if (!me) throw new Error("this log has no signer: it writes nothing")
			const f = feed(me.device), n = f.steps.length
			const step: Step = {
				...s,
				device: me.device,
				n: n + 1,
				before: n ? f.hashes[n - 1] : null,
				lamport: lamport + 1,
			}
			const bytes = encodeStep(step)
			add(me.device, [bytes], { steps: [step], hashes: [hashStep(bytes)] })
			return step
		},

		// a device's steps from n on, as many as fit in room bytes (one at least), ending at a signed
		// step; undefined: none signed from there. this device's are signed here, once at a time, and
		// signed again after a restart rather than kept
		async batch(device: string, from: number, room = Infinity): Promise<Batch | undefined> {
			const f = feeds.get(device)
			if (!f || from < 1 || from > f.steps.length) return undefined
			let end = from, size = f.steps[from - 1].length
			while (end < f.steps.length && size + f.steps[end].length <= room) {
				size += f.steps[end++].length
			}
			if (device === me?.device) {
				while (!f.sigs.has(end)) {
					const n = end
					signing ??= me.sign(f.hashes[n - 1]).then((sig) => {
						vouch(f, n, sig)
						signing = undefined
					})
					await signing
				}
			} else {
				// the furthest signed step that fits, else the nearest one past it
				let best = 0, past = 0
				for (const n of f.sigs.keys()) {
					if (n < from) continue
					if (n <= end) best = Math.max(best, n)
					else if (!past || n < past) past = n
				}
				end = best || past
				if (!end) return undefined
			}
			return { device, steps: f.steps.slice(from - 1, end), sig: f.sigs.get(end)! }
		},

		// another's steps: those already held are passed over (a new signature over them kept), the
		// rest must go on from the latest held. the steps added, or why not
		take(b: Batch, from?: unknown): Promise<{ added: number } | { refused: string }> {
			const run = async () => {
				if (!b.steps.length) return { added: 0 }
				// no feed is made for a device until its steps check out
				const f = feeds.get(b.device), held = f?.steps.length ?? 0
				const first = decodeStep(b.steps[0]).n, last = first + b.steps.length - 1
				if (first > held + 1) return { refused: "gap" }
				const fresh = b.steps.slice(held - first + 1)
				const c = fresh.length ? chain(b.device, fresh) : { steps: [], hashes: [] }
				if (!c) return { refused: "chain" }
				const h = c.hashes.length ? c.hashes[c.hashes.length - 1] : f!.hashes[last - 1]
				if (
					!fresh.length &&
					(f!.sigs.has(last) || !same(hashStep(b.steps[b.steps.length - 1]), h))
				) {
					return { added: 0 }
				}
				if (!(await verify(b.device, h, b.sig))) return { refused: "signature" }
				// held before the steps are told of, so they can be sent on; on disk after them, so load
				// has them when it reads it
				vouch(feed(b.device), last, b.sig)
				if (fresh.length) add(b.device, fresh, c, from)
				save({ device: b.device, n: last, sig: b.sig })
				return { added: fresh.length }
			}
			const p = taking.then(run, run)
			taking = p
			return p
		},

		// what the store holds, back in memory: chains checked, signatures trusted, up to the first
		// record that isn't one. the snapshot
		async load() {
			const { records, snapshot } = await store.load()
			type Record = { step?: Uint8Array; device?: string; n?: number; sig?: Uint8Array }
			for (const r of records) {
				let x: Record
				try {
					x = decode(r) as Record
					if (x.step) {
						const device = decodeStep(x.step).device, c = chain(device, [x.step])
						if (!c) break
						keep(device, [x.step], c)
					} else if (
						x.device && x.n && x.sig && x.n <= (feeds.get(x.device)?.steps.length ?? 0)
					) {
						vouch(feed(x.device), x.n, x.sig)
					}
				} catch {
					break
				}
			}
			return snapshot
		},
		snapshot: (bytes: Uint8Array) => (saving = saving.then(() => store.snapshot(bytes))),
		// every record on disk
		saved: () => saving,
	}
}
