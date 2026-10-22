// the log: every device's steps this device holds, in order, and the signatures over their runs
// (WIRE.md, runs). the steps' bytes stay in its store, appended, with now and then a snapshot; in
// memory only each step's hash. it knows nothing of the graph: galaxy holds logs with no graph
//
//   const log = createLog({ store, writes: true })   // its key is the store's, made on first load
//   await log.load()
//   log.write({ node, part, patches, when })     // a step of this device's
//   await log.run(device, n)                     // the run with step n in it, from n on
//   await log.take(run)                          // another's run, checked: chain and signature
//   log.on((device, steps, from) => ...)         // steps added, and the link they came on
import { decode, encode } from "@ermine/encoding/cbor"
import { decodeStep, encodeStep, hashStep, same, type Step } from "./step.ts"
import { createSigner, type Signer, verify } from "./sign.ts"

// a device's steps from some n on, to the end of their run, and its signature over the last
export type Run = { device: string; steps: Uint8Array[]; sig: Uint8Array }

// a step's place: its device and n
export type At = [device: string, n: number]

// where a log keeps itself: records appended in order, the steps among them got again by place,
// one snapshot, replaced, and the key of the device that writes here
export type Store = {
	// each record, in order, given to read, which says which are steps to get later. the snapshot
	load(read: (record: Uint8Array) => At | undefined): Promise<Uint8Array | undefined>
	// a record at the end, after every one before it; at: the step it is
	append(record: Uint8Array, at?: At): Promise<void>
	// a step appended or loaded, as its bytes
	get(device: string, n: number): Uint8Array
	snapshot(bytes: Uint8Array): Promise<void>
	// the key this store's device signs with: the one it holds, else seed, held from now on
	key(seed: Uint8Array): Promise<Uint8Array>
	// every record appended so far on disk, through a power cut
	sync?(): Promise<void>
	// what it holds open, let go
	close?(): void
}

export function createMemoryStore(): Store {
	const records: Uint8Array[] = []
	let steps = new Map<string, Uint8Array[]>(), snap: Uint8Array | undefined, key: Uint8Array
	const hold = (r: Uint8Array, [d, n]: At) => {
		let list = steps.get(d)
		if (!list) steps.set(d, list = [])
		list[n - 1] = r
	}
	return {
		load(read) {
			steps = new Map()
			for (const r of records) {
				const at = read(r)
				if (at) hold(r, at)
			}
			return Promise.resolve(snap)
		},
		append(r, at) {
			records.push(r)
			if (at) hold(r, at)
			return Promise.resolve()
		},
		get: (d, n) => steps.get(d)![n - 1],
		snapshot: (b) => (snap = b, Promise.resolve()),
		key: (seed) => Promise.resolve(key ??= seed),
	}
}

// a run is closed at this many steps, or bytes of them
const EVERY = 32, BYTES = 2048
// the most a batch's lamports may go past the highest held
const JUMP = 2 ** 20

// a device's step hashes (how many: its count) and the signatures over them, by n; top: the
// highest signed
type Feed = { hashes: Uint8Array[]; sigs: Map<number, Uint8Array>; top: number }
type Chained = { steps: Step[]; hashes: Uint8Array[] }
// from: the link they came on; none: written here
type Told = (device: string, steps: Step[], from?: unknown) => void

export type Log = ReturnType<typeof createLog>

// writes: this log writes steps of its own, under its store's key; seed: the key a fresh store
// starts with (a store with another throws at load). neither: it only carries others' (a relay)
export function createLog(o: { store?: Store; writes?: boolean; seed?: Uint8Array } = {}) {
	const store = o.store ?? createMemoryStore()
	let me: Signer | undefined
	const feeds = new Map<string, Feed>()
	const told: Told[] = []
	let lamport = 0
	let saving: Promise<unknown> = Promise.resolve()
	let taking: Promise<unknown> = Promise.resolve()
	let signing: Promise<unknown> = Promise.resolve()
	// this device's highest step asked to be signed, and the bytes written since
	let asked = 0, loose = 0
	const save = (record: Uint8Array, at?: At) => {
		saving = Promise.all([saving, store.append(record, at)])
	}
	const feed = (d: string) => {
		let f = feeds.get(d)
		if (!f) feeds.set(d, f = { hashes: [], sigs: new Map(), top: 0 })
		return f
	}
	const count = (d: string) => feeds.get(d)?.hashes.length ?? 0

	// steps that go on from a feed's latest, each naming the one before, with their hashes
	function chain(device: string, bytes: Uint8Array[]): Chained | undefined {
		const f = feeds.get(device)
		let n = f?.hashes.length ?? 0, before = n ? f!.hashes[n - 1] : null
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
	// checked steps, counted
	function keep(device: string, c: Chained) {
		feed(device).hashes.push(...c.hashes)
		for (const s of c.steps) lamport = Math.max(lamport, s.lamport)
	}
	// checked steps: counted, in the store, then told. a listener that throws stops no other
	function add(device: string, bytes: Uint8Array[], c: Chained, from?: unknown) {
		const n = count(device)
		keep(device, c)
		bytes.forEach((b, i) => save(b, [device, n + i + 1]))
		for (const t of told) {
			try {
				t(device, c.steps, from)
			} catch {
				// its own
			}
		}
	}

	// this device's step n signed, after any signing asked before it: kept, and saved. a sign that
	// fails fails this call only
	function sign(n: number): Promise<void> {
		const device = me!.device, f = feed(device)
		if (n === f.hashes.length) loose = 0
		asked = Math.max(asked, n)
		const p = signing.then(async () => {
			if (f.sigs.has(n)) return
			const sig = await me!.sign(f.hashes[n - 1])
			vouch(f, n, sig)
			save(encode({ device, n, sig }))
		})
		signing = p.catch(() => {})
		return p
	}

	return {
		get device() {
			return me?.device
		},
		get lamport() {
			return lamport
		},
		// how many steps of each device's this log holds and can vouch for: up to the last signed
		// (this device's: all), so a peer sends again what came without its signature
		have(): Record<string, number> {
			const h: Record<string, number> = {}
			for (const [d, f] of feeds) h[d] = d === me?.device ? f.hashes.length : f.top
			return h
		},
		count,
		// a step's bytes, from the store
		step: (device: string, n: number) => store.get(device, n),
		// every step of a device's, from the store
		steps: (device: string): Uint8Array[] =>
			Array.from({ length: count(device) }, (_, i) => store.get(device, i + 1)),
		on(t: Told) {
			told.push(t)
			return () => void told.splice(told.indexOf(t), 1)
		},

		// a step of this device's, made now: lamport one past the highest seen. one that isn't a
		// step as decodeStep takes one throws, and is never sent
		write(s: Omit<Step, "device" | "n" | "before" | "lamport">): Step {
			if (!me) throw new Error("this log writes nothing, or is not loaded")
			if (lamport >= Number.MAX_SAFE_INTEGER) throw new RangeError("lamport is at its end")
			const f = feed(me.device), n = f.hashes.length + 1
			const step: Step = {
				...s,
				device: me.device,
				n,
				before: n > 1 ? f.hashes[n - 2] : null,
				lamport: lamport + 1,
			}
			const bytes = encodeStep(step)
			decodeStep(bytes)
			add(me.device, [bytes], { steps: [step], hashes: [hashStep(bytes)] })
			loose += bytes.length
			if (n - asked >= EVERY || loose >= BYTES) sign(n).catch(() => {})
			return step
		},

		// the run with step n in it, from n on; undefined: none held, or none closed. this device's
		// run still open is closed now (someone is waiting for it), once its steps are in the store
		async run(device: string, from: number): Promise<Run | undefined> {
			const f = feeds.get(device), held = count(device)
			if (!f || from < 1 || from > held) return undefined
			// this device's runs closed already are signed first, so none is mistaken for open; and its
			// steps are on disk before any leave, so a power cut can't make another step with their n
			if (device === me?.device) {
				await signing
				if (!await saving.then(() => store.sync?.()).then(() => true, () => false)) {
					return undefined
				}
			}
			let end = from
			while (end <= held && !f.sigs.has(end)) end++
			if (end > held) {
				if (device !== me?.device) return undefined
				if (!await sign(held).then(() => true, () => false)) return undefined
				end = held
			}
			const steps = Array.from({ length: end - from + 1 }, (_, i) => store.get(device, from + i))
			return { device, steps, sig: f.sigs.get(end)! }
		},

		// another's run: steps already held are passed over (a new signature over them kept), the rest
		// must go on from the latest held, and keep lamport near what is held. never this device's own:
		// what it wrote is in its store. the steps added, or why not
		take(b: Run, from?: unknown): Promise<{ added: number } | { refused: string }> {
			const run = async () => {
				if (b.device === me?.device) return { refused: "own" }
				if (!b.steps.length) return { added: 0 }
				// no feed is made for a device until its steps check out
				const f = feeds.get(b.device), held = count(b.device)
				const first = decodeStep(b.steps[0]).n, last = first + b.steps.length - 1
				if (first > held + 1) return { refused: "gap" }
				const fresh = b.steps.slice(held - first + 1)
				const c = chain(b.device, fresh)
				if (!c) return { refused: "chain" }
				if (c.steps.some((s) => s.lamport > lamport + JUMP)) return { refused: "lamport" }
				const hash = (n: number) => n <= held ? f!.hashes[n - 1] : c.hashes[n - held - 1]
				if (
					!fresh.length &&
					(f!.sigs.has(last) || !same(hashStep(b.steps[b.steps.length - 1]), hash(last)))
				) {
					return { added: 0 }
				}
				if (!(await verify(b.device, hash(last), b.sig))) return { refused: "signature" }
				// held before the steps are told of, so they can be sent on; on disk after them, so load
				// has them when it reads it
				vouch(feed(b.device), last, b.sig)
				if (fresh.length) add(b.device, fresh, c, from)
				save(encode({ device: b.device, n: last, sig: b.sig }))
				return { added: fresh.length }
			}
			const p = taking.then(run, run)
			taking = p
			return p
		},

		// the key, and what the store holds, back in memory: each step's chain checked, signatures
		// trusted; a record that is neither, or doesn't go on from what is held, is passed over. the
		// snapshot
		async load() {
			if (o.writes || o.seed) {
				const key = await store.key(o.seed ?? crypto.getRandomValues(new Uint8Array(32)))
				if (o.seed && !same(key, o.seed)) throw new Error("this store has a key of its own")
				me = await createSigner(key)
			}
			const snapshot = await store.load((r) => {
				try {
					const x = decode(r) as { device?: string; n?: number; sig?: Uint8Array }
					if (x.sig !== undefined) {
						const f = feeds.get(x.device!)
						if (f && x.sig instanceof Uint8Array && x.n! >= 1 && x.n! <= f.hashes.length) {
							vouch(f, x.n!, x.sig)
						}
						return
					}
					const s = decodeStep(r), c = chain(s.device, [r])
					if (!c) return
					keep(s.device, c)
					return [s.device, s.n]
				} catch {
					return
				}
			})
			if (me) asked = feeds.get(me.device)?.top ?? 0
			return snapshot
		},
		snapshot: (bytes: Uint8Array) => (saving = saving.then(() => store.snapshot(bytes))),
		// every record on disk
		saved: () => saving,
		// every record on disk, and the store let go
		async close() {
			await saving
			store.close?.()
		},
	}
}
