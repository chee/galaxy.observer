// what a device keeps of a node's commits, whatever carries them (subduction.ts is one stack; a small
// device's, like playground/together/stacks/littlesync's, would be another): per document a history for each layer
// (history.ts), the seals taken in and the ones waiting on a parent's seal, what is refused, the
// snapshots that came as hints; and the device's own takes, sealed and handed to the stack. a stack hands
// what arrives to the mailroom (admit, pend, settle, member, hint, hear, stopped) and the mailroom hands the
// stack what goes out (Stack). the mailroom never reads a network, a storage or a lock. adapted from
// transport.ts, which composes it with the subduction stack
import { type Commit, CommitError, decode, name as nameOf } from "@ermine/encoding/commit"
import { type Added, createHistory, type History, type Judged, type Kept } from "./history.ts"
import { hex, unhex } from "./hex.ts"
import { kind } from "@ermine/ids"
import { matches, type Merges, type Tables } from "./replay.ts"
import { seal, type Signer, stored, unseal, utf8, type Verifier } from "./seal.ts"
import { tablesOf } from "./snapshot.ts"
import type { Taking } from "./transport_conformance_hook.ts"

export type { Taking }

export type Layer = "stored" | "ephemeral"

// a commit taken into a history from elsewhere (the network or storage), after it is taken in;
// heard: from a peer's ephemeral message. a device's own takes are not announced
export type Arrival = { doc: string; layer: Layer; kept: Kept; heard: boolean }

// the integration's: whether a commit whose parents are all taken in applies to its parent's node.
// called for commits from elsewhere only, never for this device's own takes. it may apply them as
// it looks. false: refused "patches"; a refusal: refused so ("merge": a rule not known here);
// "wait": not judged yet, judged again on changed(). a throw is a wait, and idle() throws it
export type Check = (
	doc: string,
	kept: Kept,
	commit: Commit,
	layer: Layer,
) => Judged

// why the mailroom or a stack refused a seal, a fragment or an ephemeral message before a history saw it.
// what a history refuses (lamport, patches, a parent) is the history's: history(doc).refused().
// boundary: a fragment's members, boundary or checkpoints not what Subduction's build makes them for
// its head. id: an envelope opened (a stack's: the id and what it carries) naming another id than the
// one followed (the refusal of a second id for a tree held is replaced by the envelope's id check), or
// a seal for another id (seal.ts)
export type Code = "lock" | "shape" | "signature" | "stored" | "parents" | "boundary" | "id"
// a refusal as it is noted: its code, and the text beside it (a lock's, or why an envelope's or a
// seal's id is not this one)
export type Refusal = { code: Code; why?: string }

// what a device holds for others at most, each letting go of its oldest past it (heard again, it
// comes in again). pending: a document's seals waiting on a parent's seal, and its stored commits
// waiting on a parent, and at the stack what waits on the lock (loose commits and fragments, each
// apart); refused: its refusals noted (each kind), and its snapshot hints; waiting: its ephemeral
// commits waiting on a parent
export type Limits = { pending: number; refused: number; waiting: number }
export const LIMITS: Limits = { pending: 65536, refused: 4096, waiting: 1024 }

export const by = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

// a document's id as its UTF-8 (what a seal and the lock bind). for now only an ermine id (of any
// kind: ermine/ids) is a document here: which nodes sync is sync's own question, and changes with
// its plan, not here
export function bytesOf(doc: string): Uint8Array {
	if (typeof doc !== "string" || kind(doc) === undefined) {
		throw new TypeError(`not a document id: ${doc}`)
	}
	return utf8(doc)
}

// noted in a map (or a set), the oldest let go of past most
export function note<K, V>(most: number, m: Map<K, V> | Set<K>, key: K, value?: V) {
	if (!m.has(key) && m.size >= most) m.delete(m.keys().next().value!)
	if (m instanceof Map) m.set(key, value!)
	else m.add(key)
}

// a refusal of that code, with the text a lock refused with beside it (none: no text)
export const refusal = (code: Code, why?: string): Refusal =>
	why === undefined ? { code } : { code, why }

// a seal's commit, as far as the mailroom reads it: its name, bytes, stored id, lamport, parents
export type Sealed = {
	name: Uint8Array
	bytes: Uint8Array
	stored: Uint8Array
	lamport: number
	parents: Uint8Array[]
}

// a taken-in seal: its commit's name, lamport and parents' names, its commit's bytes, its sealed
// bytes (none: a commit a pack's next vouched for, held without a seal), and the stored ids of the
// seals it was taken in over (the commit's parents; or, for a seal alone, every seal of each)
export type Seen = {
	name: string
	lamport: number
	parents: string[]
	bytes: Uint8Array
	sealed?: Uint8Array
	ids: string[]
}

// a fragment's member: its sealed bytes (none: vouched for by the next in its pack), and its commit
// as the mailroom reads it
export type Member = { sealed?: Uint8Array; it: Sealed }

// a loose commit, or a seal alone (a fragment's member), not yet handed to the histories: its parents
// not all here, or one refused. given: the commit's parents' stored ids, sorted
export type Pending = {
	commit: boolean
	it: Sealed
	sealed?: Uint8Array
	parents: string[]
	given: string[]
	waiting?: string[]
	stuck?: string[]
}

// a document as the mailroom holds it. a stack reads names and seen (what it builds from); it changes
// nothing here but through the mailroom's functions. bytes: its id's UTF-8 (what the lock binds;
// a seal binds the id). a stack files it under its own address (Subduction's: a tree id)
export type Doc = {
	id: string
	bytes: Uint8Array
	histories: Record<Layer, History>
	// what each history was given from elsewhere and has not taken in yet, by name: whether heard
	elsewhere: Record<Layer, Map<string, boolean>>
	// this device's own takes waiting on a parent, by name: sent once let in
	own: Record<Layer, Set<string>>
	// a taken-in seal's name to its stored ids (one: a stored id is of the id and the name, seal.ts)
	names: Map<string, string[]>
	seen: Map<string, Seen>
	// the snapshots fragments carried, packed, by their head's name, each checked (hint)
	snapshots: Map<string, Uint8Array>
	// the snapshots not checked yet, by their head's name; the heads checked
	hints: Map<string, Uint8Array>
	judged: Set<string>
	// by the commit's head, or the seal's stored id
	pending: Map<string, Pending>
	refused: Map<string, Refusal>
	// names of seals refused here
	bad: Set<string>
	// refused ephemeral commits: one the lock refused by the name of the bytes as they came (closed:
	// it could not be opened), one refused after (shape, signature) by the opened commit's
	heard: Map<string, Refusal>
}

// what a stack is to the mailroom: the mailroom hands it what this device made, and what to say
export type Stack = {
	// a document made (first named): the stack may file it under its own address
	made?(d: Doc): void
	// an own take, taken into the histories, going out: a stored one sealed and stored, an
	// ephemeral one published. called one at a time in the order made, so a commit's parents are
	// stored before it
	send(d: Doc, layer: Layer, kept: Kept): Promise<void>
	// a stop message for the table: this device's standing ephemeral commit there ends. in the
	// order of the sends
	stop(d: Doc, table: string): Promise<void>
	// a seal taken in at the document (own or not): the stack may count what it needs of it
	handed?(d: Doc, stored: Uint8Array): void
	// what the stack holds back or refuses at the document before the mailroom (the stored layer's), added
	// to the mailroom's own in Taking
	taking?(d: Doc): Taking
}

// the part of a device the mailroom is: what sync calls that no stack has a say in
export type Held = {
	// default "stored". the ephemeral one holds every stored commit too
	history(doc: string, layer?: Layer): History
	// a commit this device made, its bytes: into the layer's history at once, synchronously, with no
	// check (it has applied here already). then, queued in the order made: stored ones sealed, added
	// as a loose commit, sent; ephemeral ones published unsealed. one waiting on a parent is queued
	// once the parent lets it in. answers as the history does
	take(
		doc: string,
		bytes: Uint8Array,
		layer: Layer,
		made?: { commit: Commit; name: Uint8Array },
	): Added
	arrived(listener: (a: Arrival) => void): () => void
	// told a document's id each time what is held back or refused there may have changed: after
	// what came for it is taken in or refused, a commit of this device's is handed over, or changed()
	// tried it again
	moved(listener: (doc: string) => void): () => void
	// what is held back or refused at the document before its histories, as
	// transport_conformance_hook_taking says; the stored layer's by default
	taking(doc: string, layer?: Layer): Taking
	// told each ephemeral commit heard on a followed document whose signer is the sender, new or
	// heard before (sent again), after any arrival it made: the document, the sender's key (its
	// multikey, as lowercase hex), the commit's name. what keeps another device's ephemeral commits
	// standing
	heard(listener: (doc: string, from: string, name: Uint8Array) => void): () => void
	// an ephemeral commit of this device's (in the ephemeral history, not a stored one) published
	// again, queued as a take is; false: no such commit
	again(doc: string, name: Uint8Array): boolean
	// an ephemeral commit (not a stored one) let go of: out of the ephemeral history and whatever
	// was kept for it, as if never heard; heard again, it comes in again. false: none such, or
	// something goes on it
	forget(doc: string, name: Uint8Array): boolean
	// this device's standing ephemeral commit at the document's table ends: a stop message on the
	// document's ephemeral topic, {stop: table} as CBOR, queued as a take is. the message carries no
	// name: a receiver drops whatever stands for its sender at that table. it travels as the ephemeral
	// commits do, signed by the transport with the sender's key (what hear checks a commit's signer
	// against), so no other device can send one for this device. forgets nothing here: the
	// integration forgets what stood
	stop(doc: string, table: string): void
	// told each stop heard on a followed document: the document, the sender's key (its multikey, as
	// lowercase hex), the table. one for nothing standing from that sender is the integration's to
	// ignore
	stopped(listener: (doc: string, from: string, table: string) => void): () => void
	// the tables at a commit, when a fragment headed by it carried a snapshot that a replay to it
	// matched (or this device made): new objects each time
	snapshot(doc: string, name: Uint8Array): Tables | undefined
	// nothing left to take in, build, seal, store or send; throws what one of them threw
	idle(): Promise<void>
}

// the mailroom. signer: its seals; verifiers: signature algorithms beyond the built in Ed25519, for the
// seals taken in (seal.ts); check: default everything applies; merges: the rules a snapshot from
// elsewhere is checked with (a replay to its head), default none; limits: default LIMITS
export function createMailroom(
	options: {
		signer: Signer
		verifiers?: readonly Verifier[]
		check?: Check
		merges?: Merges
		limits?: Partial<Limits>
	},
) {
	const check: Check = options.check ?? (() => true)
	const limits: Limits = { ...LIMITS, ...options.limits }
	const documents = new Map<string, Doc>()
	let stack: Stack | undefined
	// taking in and building, one at a time, in the order asked
	let tail: Promise<unknown> = Promise.resolve()
	let busy = 0
	const trouble: unknown[] = []
	function run<T>(f: () => Promise<T>): Promise<T> {
		busy++
		const p = tail.then(f)
		tail = p.then(() => {}, () => {}).then(() => {
			busy--
		})
		return p
	}
	// work nobody awaits: what it throws waits for idle
	function later(f: () => Promise<void>) {
		run(f).catch((e) => trouble.push(e))
	}
	// what take queued: sent by the stack, one at a time in the order made, so a commit's parents are
	// stored before it
	let out: Promise<void> = Promise.resolve()
	let sending = 0
	function outgoing(f: () => Promise<void>) {
		sending++
		out = out.then(f).catch((e) => void trouble.push(e)).finally(() => void sending--)
	}
	const send = (d: Doc, layer: Layer, kept: Kept) => outgoing(() => stack!.send(d, layer, kept))

	// ---- taking in

	const listeners = new Set<(a: Arrival) => void>()
	const movers = new Set<(doc: string) => void>()
	function moved(d: Doc) {
		for (const fn of [...movers]) {
			try {
				fn(d.id)
			} catch (e) {
				trouble.push(e)
			}
		}
	}
	const hearers = new Set<(doc: string, from: string, name: Uint8Array) => void>()
	const stoppers = new Set<(doc: string, from: string, table: string) => void>()
	// arrivals the histories' taken listeners told, told on after the add that let them in, so a
	// listener never runs inside a history's add
	const told: Arrival[] = []
	function tell() {
		for (let a; (a = told.shift()) !== undefined;) {
			for (const l of [...listeners]) {
				try {
					l(a)
				} catch (e) {
					trouble.push(e)
				}
			}
		}
		for (let r; (r = released.shift()) !== undefined;) send(r.d, r.layer, r.kept)
		for (let j; (j = judging.shift()) !== undefined;) judge(j.d, j.name)
	}
	// heads with a snapshot hint, taken in by an add: checked by tell, after it
	const judging: { d: Doc; name: string }[] = []
	// own takes that waited, let in by an add: sent by tell, after what let them in
	const released: { d: Doc; layer: Layer; kept: Kept }[] = []

	// a document by its id, made when first named (the stack told, so it files it under its own
	// address). an id is compared as its bytes: two ids, two documents
	function named(id: string): Doc {
		let d = documents.get(id)
		if (d) return d
		const bytes = bytesOf(id)
		// own takes and the check: everything from elsewhere is marked in elsewhere before its
		// history's add, and stays marked until taken in. the history's check asks the integration's
		// only for a marked commit; one not marked is this device's own take (or a seal of it, handed
		// over after), which applied here already, so passes unchecked and is not announced. a commit
		// from elsewhere that waited, let in by an own take, is still marked: checked, and announced
		const elsewhere: Record<Layer, Map<string, boolean>> = {
			stored: new Map(),
			ephemeral: new Map(),
		}
		const own: Record<Layer, Set<string>> = { stored: new Set(), ephemeral: new Set() }
		const make = (layer: Layer) => {
			const from = elsewhere[layer]
			const history = createHistory((kept, commit) => {
				if (!from.has(hex(kept.name))) return true
				try {
					return check(id, kept, commit, layer)
				} catch (e) {
					trouble.push(e)
					return "wait"
				}
			}, {
				most: layer === "ephemeral" ? limits.waiting : limits.pending,
				dropped: (n) => (from.delete(n), own[layer].delete(n)),
			})
			history.taken((kept) => {
				const n = hex(kept.name), heard = from.get(n)
				if (layer === "stored" && d!.hints.has(n)) judging.push({ d: d!, name: n })
				if (heard === undefined) {
					if (own[layer].delete(n)) released.push({ d: d!, layer, kept })
					return
				}
				from.delete(n)
				told.push({ doc: id, layer, kept, heard })
			})
			return history
		}
		d = {
			id,
			bytes,
			histories: { stored: make("stored"), ephemeral: make("ephemeral") },
			elsewhere,
			own,
			names: new Map(),
			seen: new Map(),
			snapshots: new Map(),
			hints: new Map(),
			judged: new Set(),
			pending: new Map(),
			refused: new Map(),
			bad: new Set(),
			heard: new Map(),
		}
		documents.set(id, d)
		stack?.made?.(d)
		return d
	}

	// a commit from elsewhere, added to the layer's history, marked until taken in. what a stack with
	// no seals around its commits hands over; a seal's commit goes by pend and settle
	function admit(d: Doc, layer: Layer, bytes: Uint8Array, name: Uint8Array, heard: boolean) {
		const from = d.elsewhere[layer], n = hex(name)
		const was = from.get(n)
		if (was === undefined) from.set(n, heard)
		const added = d.histories[layer].add(bytes)
		// refused, or here already (not waiting from before): nothing comes of the mark
		if (typeof added === "object" && "refused" in added) from.delete(n)
		else if (added === "passed" && was === undefined) from.delete(n)
	}

	// handed to the histories: its seal is taken in here. own: a seal of this device's own take,
	// which its histories hold already
	function hand(
		d: Doc,
		it: Sealed,
		sealed: Uint8Array | undefined,
		ids: string[],
		own = false,
	) {
		const n = hex(it.name), s = hex(it.stored)
		d.names.set(n, [...d.names.get(n) ?? [], s])
		d.bad.delete(n)
		d.refused.delete(s)
		const parents = it.parents.map(hex)
		d.seen.set(s, { name: n, lamport: it.lamport, parents, bytes: it.bytes, sealed, ids })
		stack?.handed?.(d, it.stored)
		if (own) return
		admit(d, "stored", it.bytes, it.name, false)
		// the ephemeral layer's history holds every stored commit too
		admit(d, "ephemeral", it.bytes, it.name, false)
		tell()
	}

	// a seal, or a loose commit, refused: its key (the commit's head, or the seal's stored id), the
	// name of its commit when that is not to be had from another seal (a parent of what waits)
	function refuse(d: Doc, key: string, code: Code, name?: string, why?: string) {
		d.pending.delete(key)
		note(limits.refused, d.refused, key, refusal(code, why))
		if (name !== undefined) note(limits.refused, d.bad, name)
	}

	// a refusal at the key let go of, when the stack has the commit in hand again and it waits
	function clear(d: Doc, key: string) {
		d.refused.delete(key)
	}

	// for each pending seal, until none moves: stuck while a parent is refused or stuck, waiting while
	// a parent's seal is not here; else a commit's parents each one of its commit's parents' stored
	// ids, and each of them one of the commit's (refused, parents), or handed to the histories
	function settle(d: Doc) {
		for (let moved = true; moved;) {
			moved = false
			const gone = new Set(d.bad)
			for (const p of d.pending.values()) if (p.stuck) gone.add(hex(p.it.name))
			for (const [head, p] of [...d.pending].sort(([a], [b]) => by(a, b))) {
				const missing = p.parents.filter((x) => !d.names.has(x))
				const stuck = missing.filter((x) => gone.has(x))
				const before = p.stuck?.join()
				p.stuck = stuck.length ? stuck : undefined
				p.waiting = stuck.length || !missing.length ? undefined : missing
				if (p.stuck?.join() !== before) moved = true
				if (missing.length) continue
				const of = p.parents.map((x) => d.names.get(x)!)
				const match = !p.commit ||
					(p.given.every((g) => of.some((ids) => ids.includes(g))) &&
						of.every((ids) => p.given.some((g) => ids.includes(g))))
				if (!match) refuse(d, head, "parents", hex(p.it.name))
				else {
					d.pending.delete(head)
					hand(d, p.it, p.sealed, p.commit ? p.given : of.flat())
				}
				moved = true
			}
		}
	}

	// a seal opened and checked, in its document: its commit, as the mailroom reads it. a SealError:
	// refused
	async function opened(d: Doc, sealed: Uint8Array): Promise<Sealed> {
		const u = await unseal(sealed, d.id, options.verifiers)
		const { lamport, parents } = u.commit
		return { name: u.name, bytes: u.bytes, stored: u.stored, lamport, parents }
	}

	// pending, the oldest let go of past limits.pending (heard again, it comes in again). a refusal
	// at its key is let go of
	function pend(d: Doc, key: string, p: Pending) {
		d.refused.delete(key)
		if (!d.pending.has(key) && d.pending.size >= limits.pending) {
			d.pending.delete(d.pending.keys().next().value!)
		}
		d.pending.set(key, p)
	}

	// a seal taken in as a fragment's member, unsealed: no commit around it
	function member(d: Doc, m: Member) {
		const s = hex(m.it.stored)
		if (d.seen.has(s)) return
		pend(d, s, {
			commit: false,
			it: m.it,
			sealed: m.sealed,
			parents: m.it.parents.map(hex),
			given: [],
		})
	}

	// a snapshot a fragment carried is a hint, checked once: once its head is taken in, the tables
	// are replayed to it, and it is kept only if they are the same; one that is not is let go of, and
	// so is any after it for that head. own: made here, kept as it is. once there is auth: snapshots
	// signed by the fragment's builder (Subduction's issuer), kept if the builder may edit
	function hint(d: Doc, name: string, bytes: Uint8Array, own = false) {
		if (d.judged.has(name)) return
		if (own) {
			d.judged.add(name)
			d.snapshots.set(name, bytes)
			return
		}
		if (d.hints.has(name)) return
		note(limits.refused, d.hints, name, bytes)
		judge(d, name)
	}

	// a hint checked, when its head is taken in (replay.ts's matches)
	function judge(d: Doc, name: string) {
		const bytes = d.hints.get(name), n = unhex(name)
		if (bytes === undefined || d.histories.stored.get(n) === undefined) return
		d.hints.delete(name)
		d.judged.add(name)
		const history = d.histories.stored
		if (matches(history, n, bytes, (x) => snapshotOf(d, x), options.merges)) {
			d.snapshots.set(name, bytes)
		}
	}

	// the tables at a commit, from a snapshot kept here
	function snapshotOf(d: Doc, name: Uint8Array): Tables | undefined {
		if (d.snapshots.size === 0) return undefined
		const bytes = d.snapshots.get(hex(name))
		return bytes === undefined ? undefined : tablesOf(bytes)
	}

	// an ephemeral commit that arrived, opened (never sealed, no commit steps), from the device with
	// that key (its multikey): decode (shape), its signer the sender's (signature); then handed to
	// the ephemeral history; never stored
	function hear(d: Doc, open: Uint8Array, from: Uint8Array) {
		const name = nameOf(open), key = hex(name)
		let c: Commit
		try {
			c = decode(open)
		} catch (e) {
			if (!(e instanceof CommitError)) throw e
			note(limits.refused, d.heard, key, refusal("shape"))
			return
		}
		if (hex(c.signer) !== hex(from)) {
			note(limits.refused, d.heard, key, refusal("signature"))
			return
		}
		d.heard.delete(key)
		admit(d, "ephemeral", open, name, true)
		tell()
		for (const fn of [...hearers]) {
			try {
				fn(d.id, hex(c.signer), name)
			} catch (e) {
				trouble.push(e)
			}
		}
	}

	// an ephemeral commit refused before it could be opened (by its name), noted
	function unheard(d: Doc, name: Uint8Array, code: Code, why?: string) {
		note(limits.refused, d.heard, hex(name), refusal(code, why))
	}

	// a stop heard from a device (the sender's key, a multikey as lowercase hex): told
	function stopped(d: Doc, from: string, table: string) {
		for (const fn of [...stoppers]) {
			try {
				fn(d.id, from, table)
			} catch (e) {
				trouble.push(e)
			}
		}
	}

	// ---- own takes

	// a stored commit of this device's: sealed, and its stored id. named already, its signer this one
	async function sealed(d: Doc, kept: Kept) {
		const sealed = await seal(kept.bytes, options.signer, d.id, { name: kept.name })
		return { sealed, stored: stored(sealed) }
	}

	// its seal handed over (taken in already), in the queue, behind the parents' seals handed over
	// before it: the parents' stored ids
	function handed(d: Doc, kept: Kept, sealed: Uint8Array, s: Uint8Array): Promise<Uint8Array[]> {
		return run(() => {
			const ids = kept.parents.map((p) => {
				const of = d.names.get(hex(p))
				if (of === undefined) throw new Error("a parent is not taken in")
				return unhex(of[0])
			})
			if (!d.seen.has(hex(s))) {
				const { name, bytes, lamport } = kept
				const it = { name, bytes, stored: s, lamport, parents: kept.parents }
				hand(d, it, sealed, ids.map(hex).sort(by), true)
				// a seal from elsewhere may wait on this one
				settle(d)
				moved(d)
			}
			return Promise.resolve(ids)
		})
	}

	// whether a commit waits on a parent: a seal held here for its parents' seals, or a commit in the
	// stored history
	const waits = (d: Doc) =>
		[...d.pending.values()].some((p) => p.waiting) || d.histories.stored.waiting().length > 0

	// what is held back or refused at the document, before its histories (Taking), and at the stack
	function taking(d: Doc, layer: Layer): Taking {
		if (layer === "ephemeral") {
			return {
				waiting: [],
				refused: [...d.heard].sort(([a], [b]) => by(a, b)).map(([commit, r]) => ({
					commit,
					...shown(r),
				})),
			}
		}
		const waiting: Taking["waiting"] = []
		const refused: Taking["refused"] = []
		for (const [commit, p] of d.pending) {
			if (p.waiting) waiting.push({ commit, waiting: p.waiting })
			else if (p.stuck) refused.push({ commit, stuck: p.stuck })
		}
		for (const [commit, r] of d.refused) refused.push({ commit, ...shown(r) })
		const more = stack?.taking?.(d)
		if (more) waiting.push(...more.waiting), refused.push(...more.refused)
		const key = (r: Taking["refused"][number]) => "fragment" in r ? r.fragment : r.commit
		const id = (w: Taking["waiting"][number]) => "fragment" in w ? w.fragment : w.commit
		return {
			waiting: waiting.sort((a, b) => by(id(a), id(b))),
			refused: refused.sort((a, b) => by(key(a), key(b))),
		}
	}

	// a refusal as a row shows it: its code, and the text beside it when it has one
	const shown = (r: Refusal) => ({
		refused: r.code,
		...(r.why !== undefined ? { why: r.why } : {}),
	})

	// the histories judged again (the check changed), what that let in told
	function retry(d: Doc) {
		for (const layer of ["stored", "ephemeral"] as const) d.histories[layer].again()
		tell()
		moved(d)
	}

	const device: Held = {
		history: (doc, layer = "stored") => named(doc).histories[layer],
		take(doc, bytes, layer, made) {
			const d = named(doc)
			const history = d.histories[layer]
			const added = history.add(bytes, made)
			if (layer === "stored") d.histories.ephemeral.add(bytes, made)
			// only what is taken goes out: one passed is here already, one refused would be refused
			// by a receiver too, one waiting on a parent goes once it is let in
			const name = made?.name ?? nameOf(bytes)
			if (added === "taken") send(d, layer, history.get(name)!)
			else if (typeof added === "object" && "waiting" in added) d.own[layer].add(hex(name))
			// an own take may let in what waited on it: from elsewhere, told; its own, sent after it
			tell()
			return added
		},
		arrived(listener) {
			listeners.add(listener)
			return () => void listeners.delete(listener)
		},
		moved(listener) {
			movers.add(listener)
			return () => void movers.delete(listener)
		},
		taking: (doc, layer = "stored") => taking(named(doc), layer),
		heard(listener) {
			hearers.add(listener)
			return () => void hearers.delete(listener)
		},
		again(doc, name) {
			const d = named(doc)
			const kept = d.histories.ephemeral.get(name)
			if (kept === undefined || d.histories.stored.get(name) !== undefined) return false
			send(d, "ephemeral", kept)
			return true
		},
		forget(doc, name) {
			const d = named(doc), n = hex(name)
			if (d.histories.stored.get(name) !== undefined) return false
			if (!d.histories.ephemeral.forget(name)) return false
			d.elsewhere.ephemeral.delete(n)
			d.own.ephemeral.delete(n)
			d.heard.delete(n)
			return true
		},
		stop(doc, table) {
			const d = named(doc)
			outgoing(() => stack!.stop(d, table))
		},
		stopped(listener) {
			stoppers.add(listener)
			return () => void stoppers.delete(listener)
		},
		snapshot: (doc, name) => snapshotOf(named(doc), name),
		async idle() {
			while (busy > 0 || sending > 0) await Promise.all([tail, out])
			if (trouble.length) throw trouble.shift()
		},
	}

	return {
		device,
		// the stack the mailroom hands what goes out to: before anything is taken
		attach(k: Stack) {
			stack = k
			for (const d of documents.values()) k.made?.(d)
		},
		// the queue taking in and building go through, one at a time; what a stack's work throws
		// waits in trouble for idle
		run,
		later,
		trouble,
		documents,
		named,
		moved,
		admit,
		refuse,
		clear,
		settle,
		opened,
		pend,
		member,
		hint,
		hear,
		unheard,
		stopped,
		sealed,
		handed,
		waits,
		retry,
	}
}
export type Mailroom = ReturnType<typeof createMailroom>
