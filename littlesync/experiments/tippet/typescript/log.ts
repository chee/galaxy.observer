// the log: every device's steps this device holds, in order, kept in its store as the runs they
// came in (WIRE.md, runs), packed, each with its signature. in memory, per device, only how many
// steps it holds and the last one's hash: what the next step must name. it knows nothing of the
// graph: galaxy holds logs with no graph
//
//   const log = createLog({ store, writes: true })   // its key is the store's, made on first load
//   await log.load()
//   log.write({ node, part, patches, when })     // a step of this device's
//   await log.run(device, n)                     // the run with step n in it, from n on
//   await log.take(run)                          // another's run, checked: chain and signature
//   log.on((device, steps, from) => ...)         // steps added, and the link they came on
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { decodeStep, encodeStep, hashStep, hex, same, type Step, unhex } from "./step.ts"
import { createSigner, type Signer, verify } from "./sign.ts"
import { pack, type Packed, unpack } from "./pack.ts"

// a device's steps from some n on, to the end of their run, and its signature over the last.
// message: the run message they are, as kept or as they came; sent and kept as it is
export type Run = { device: string; steps: Uint8Array[]; sig: Uint8Array; message?: Uint8Array }

// a run's place in a store: its device, and the n of its first step and of its last
export type At = [device: string, first: number, last: number]

// a run as a store keeps it: its run message (WIRE.md, messages), as it came or as it goes, so it
// goes on as it is. this device's steps not yet in a closed run are kept alone, each its bytes
const record = (device: string, sig: Uint8Array, p: Packed) =>
	encode(["run", unhex(device), sig, p] as Value)
// a run's record: a message, an array of 4; a step's: an array of 8 or 9
export const isRun = (record: Uint8Array) => record[0] === 0x84
const opened = (record: Uint8Array) => decode(record) as [string, Uint8Array, Uint8Array, Packed]

// where a log keeps itself: records appended in order, the steps among them got again by place,
// one snapshot, replaced, and the key of the device that writes here
export type Store = {
	// each record, in order, given to read, which says which hold steps to get later. the snapshot
	load(read: (record: Uint8Array) => At | undefined): Promise<Uint8Array | undefined>
	// a record at the end, after every one before it; at: the steps it holds, in place of any
	// held that it covers
	append(record: Uint8Array, at?: At): Promise<void>
	// the record holding step n, and the n of its first step and its last
	run(device: string, n: number): { record: Uint8Array; first: number; last: number } | undefined
	// step n's bytes, as if kept alone: out of its run, unpacked
	get(device: string, n: number): Uint8Array
	snapshot(bytes: Uint8Array): Promise<void>
	// the key this store's device signs with: the one it holds, else seed, held from now on
	key(seed: Uint8Array): Promise<Uint8Array>
	// every record appended so far on disk, through a power cut
	sync?(): Promise<void>
	// what it holds open, let go
	close?(): void
	// forgetting (history.ts): the records holding device's steps through n no longer got: how many
	drop?(device: string, n: number): number
}

// what both stores keep in memory: per device, each record holding steps, in order, as [first,
// last, where]; and the last run read, unpacked, so reading its steps in turn unpacks it once
export function createIndex<W>(read: (where: W) => Uint8Array) {
	let runs = new Map<string, [number, number, W][]>()
	let last: { device: string; first: number; steps: Uint8Array[] } | undefined
	const find = (device: string, n: number) => {
		const list = runs.get(device) ?? []
		let lo = 0, hi = list.length
		while (lo < hi) {
			const mid = (lo + hi) >> 1
			if (list[mid][0] <= n) lo = mid + 1
			else hi = mid
		}
		const r = list[lo - 1]
		return r && n <= r[1] ? r : undefined
	}
	return {
		clear: () => void (runs = new Map(), last = undefined),
		hold([device, first, end]: At, where: W) {
			let list = runs.get(device)
			if (!list) runs.set(device, list = [])
			let i = list.length
			while (i > 0 && list[i - 1][0] >= first) i--
			let j = i
			while (j < list.length && list[j][1] <= end) j++
			list.splice(i, j - i, [first, end, where])
		},
		run(device: string, n: number) {
			const r = find(device, n)
			return r && { record: read(r[2]), first: r[0], last: r[1] }
		},
		get(device: string, n: number): Uint8Array {
			const l = last
			if (l?.device === device && n >= l.first && n < l.first + l.steps.length) {
				return l.steps[n - l.first]
			}
			const r = find(device, n)
			if (!r) throw new RangeError(`step ${n} is not held`)
			const record = read(r[2])
			if (!isRun(record)) return record
			last = { device, first: r[0], steps: unpack(opened(record)[3]) }
			return last.steps[n - r[0]]
		},
		// forgetting: only where they are; their bytes stay
		drop(device: string, n: number) {
			const list = runs.get(device) ?? [], kept = list.filter((r) => r[1] > n)
			runs.set(device, kept)
			return list.length - kept.length
		},
	}
}

export function createMemoryStore(): Store {
	const records: Uint8Array[] = []
	const index = createIndex<Uint8Array>((r) => r)
	let snap: Uint8Array | undefined, key: Uint8Array
	return {
		load(read) {
			index.clear()
			for (const r of records) {
				const at = read(r)
				if (at) index.hold(at, r)
			}
			return Promise.resolve(snap)
		},
		append(r, at) {
			records.push(r)
			if (at) index.hold(at, r)
			return Promise.resolve()
		},
		run: index.run,
		get: index.get,
		snapshot: (b) => (snap = b, Promise.resolve()),
		key: (seed) => Promise.resolve(key ??= seed),
		drop: index.drop,
	}
}

// a run is closed at this many steps, or bytes of them
const EVERY = 32, BYTES = 2048
// the most a batch's lamports may go past the highest held
const JUMP = 2 ** 20

// a device's: how many steps held, and the last one's hash
type Feed = { count: number; last: Uint8Array | null }
// steps that go on from a feed's latest, and the last one's hash
type Chained = { steps: Step[]; last: Uint8Array | null }
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
	// this device's highest step asked to be closed into a run, the highest closed, and the bytes
	// written since the last asked
	let asked = 0, closed = 0, loose = 0
	const save = (record: Uint8Array, at?: At) => {
		saving = Promise.all([saving, store.append(record, at)])
	}
	const count = (d: string) => feeds.get(d)?.count ?? 0

	// steps that go on from a device's latest, those held already passed over, the rest each naming
	// the one before; gap: they start past the latest + 1
	function chain(device: string, bytes: Uint8Array[]): Chained | "gap" | "chain" {
		const f = feeds.get(device)
		let n = f?.count ?? 0, before = f?.last ?? null
		const first = decodeStep(bytes[0]).n, steps: Step[] = []
		if (first > n + 1) return "gap"
		for (const b of bytes.slice(n - first + 1)) {
			const s = decodeStep(b)
			if (s.device !== device || s.n !== n + 1 || !same(s.before, before)) return "chain"
			steps.push(s), before = hashStep(b)
			n++
		}
		return { steps, last: before }
	}
	// checked steps, counted
	function keep(device: string, c: Chained) {
		if (!c.steps.length) return
		feeds.set(device, { count: count(device) + c.steps.length, last: c.last })
		for (const s of c.steps) lamport = Math.max(lamport, s.lamport)
	}
	// checked steps: counted, their record in the store, then told. a listener that throws stops
	// no other
	function add(device: string, record: Uint8Array, c: Chained, from?: unknown) {
		const n = count(device)
		keep(device, c)
		save(record, [device, n + 1, n + c.steps.length])
		for (const t of told) {
			try {
				t(device, c.steps, from)
			} catch {
				// its own
			}
		}
	}

	// this device's steps through n closed: runs of at most EVERY, each signed and kept as its
	// record in place of the steps alone, after any closing asked before. a sign that fails fails
	// this call only
	function close(n: number): Promise<void> {
		const device = me!.device
		if (n === count(device)) loose = 0
		asked = Math.max(asked, n)
		const p = signing.then(async () => {
			for (let first = closed + 1; first <= n; first = closed + 1) {
				const last = Math.min(n, first + EVERY - 1)
				const steps = Array.from(
					{ length: last - first + 1 },
					(_, i) => store.get(device, first + i),
				)
				const sig = await me!.sign(hashStep(steps[steps.length - 1]))
				save(record(device, sig, pack(steps)), [device, first, last])
				closed = last
			}
		})
		signing = p.catch(() => {})
		return p
	}

	// forgetting (history.ts, a try-out): a record ["drop", device, n] says the store lets device's
	// steps through n go, so a load lets them go as it comes to it. true: r is one
	function dropped(r: Uint8Array) {
		if (r[0] !== 0x83) return false
		const [t, d, n] = decode(r) as [string, Uint8Array, number]
		if (t === "drop") store.drop?.(hex(d), n)
		return true
	}

	return {
		get device() {
			return me?.device
		},
		get lamport() {
			return lamport
		},
		// how many steps of each device's this log holds: another's all signed, this device's all
		have(): Record<string, number> {
			const h: Record<string, number> = {}
			for (const [d, f] of feeds) h[d] = f.count
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
		// step as decodeStep takes one throws, and is never sent. kept alone until its run closes
		write(s: Omit<Step, "device" | "n" | "before" | "lamport">): Step {
			if (!me) throw new Error("this log writes nothing, or is not loaded")
			if (lamport >= Number.MAX_SAFE_INTEGER) throw new RangeError("lamport is at its end")
			const n = count(me.device) + 1
			const step: Step = {
				...s,
				device: me.device,
				n,
				before: feeds.get(me.device)?.last ?? null,
				lamport: lamport + 1,
			}
			const bytes = encodeStep(step)
			decodeStep(bytes)
			add(me.device, bytes, { steps: [step], last: hashStep(bytes) })
			loose += bytes.length
			if (n - asked >= EVERY || loose >= BYTES) close(n).catch(() => {})
			return step
		},

		// the run with step n in it, from n on; undefined: none held, or none closed. this device's
		// run still open is closed now (someone is waiting for it), once its steps are in the store
		async run(device: string, from: number): Promise<Run | undefined> {
			if (from < 1 || from > count(device)) return undefined
			// this device's runs asked to close are closed first, so none is mistaken for open; and its
			// steps are on disk before any leave, so a power cut can't make another step with their n
			if (device === me?.device) {
				await signing
				if (!await saving.then(() => store.sync?.()).then(() => true, () => false)) {
					return undefined
				}
				if (from > closed && !await close(count(device)).then(() => true, () => false)) {
					return undefined
				}
			}
			const r = store.run(device, from)
			if (!r || !isRun(r.record)) return undefined
			const [, , sig, p] = opened(r.record)
			const steps = unpack(p).slice(from - r.first)
			return { device, steps, sig, ...(from === r.first && { message: r.record }) }
		},

		// another's run: steps already held are passed over, the rest must go on from the latest
		// held, and keep lamport near what is held. never this device's own: what it wrote is in its
		// store. kept as it came when every step is new, else what is new packed again. the steps
		// added, or why not
		take(b: Run, from?: unknown): Promise<{ added: number } | { refused: string }> {
			const run = async () => {
				if (b.device === me?.device) return { refused: "own" }
				if (!b.steps.length) return { added: 0 }
				// no feed is made for a device until its steps check out
				const c = chain(b.device, b.steps)
				if (typeof c === "string") return { refused: c }
				if (c.steps.some((s) => s.lamport > lamport + JUMP)) return { refused: "lamport" }
				if (!c.steps.length) return { added: 0 }
				if (!(await verify(b.device, c.last!, b.sig))) return { refused: "signature" }
				const fresh = b.steps.slice(b.steps.length - c.steps.length)
				const kept = fresh.length === b.steps.length && b.message
				add(b.device, kept || record(b.device, b.sig, pack(fresh)), c, from)
				return { added: c.steps.length }
			}
			const p = taking.then(run, run)
			taking = p
			return p
		},

		// the key, and what the store holds, back in memory: each step's chain checked, signatures
		// trusted; a record that is neither, or doesn't go on from what is held, is passed over. a step
		// kept alone is this device's only. the snapshot
		async load() {
			if (o.writes || o.seed) {
				const key = await store.key(o.seed ?? crypto.getRandomValues(new Uint8Array(32)))
				if (o.seed && !same(key, o.seed)) throw new Error("this store has a key of its own")
				me = await createSigner(key)
			}
			const snapshot = await store.load((r): At | undefined => {
				try {
					if (dropped(r)) return
					const steps = isRun(r) ? unpack(opened(r)[3]) : [r]
					const s = decodeStep(steps[0]), c = chain(s.device, steps)
					if (typeof c === "string" || (!isRun(r) && s.device !== me?.device)) return
					keep(s.device, c)
					const last = s.n + steps.length - 1
					if (isRun(r) && s.device === me?.device) closed = Math.max(closed, last)
					return [s.device, s.n, last]
				} catch {
					return
				}
			})
			asked = closed
			return snapshot
		},
		snapshot: (bytes: Uint8Array) => (saving = saving.then(() => store.snapshot(bytes))),
		// forgetting: each device's steps through n no longer got from the store, and so never sent
		drop(through: Record<string, number>) {
			for (const [d, n] of Object.entries(through)) {
				if (n > 0 && store.drop?.(d, n)) save(encode(["drop", unhex(d), n]))
			}
		},
		// every record on disk
		saved: () => saving,
		// every record on disk, and the store let go
		async close() {
			await saving
			store.close?.()
		},
	}
}
