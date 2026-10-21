// the subduction stack: commits over Subduction (extensions/subduction/plan.org, Rewrite for the new
// shape, 7): stored ones, sealed, as loose commits and fragments, each fragment with a snapshot of
// the tables at its head; ephemeral ones, never sealed, as its ephemeral messages; and what a device
// checks of what arrives before the mailroom's histories see it, and before Subduction stores it (only
// what is taken in is). what a device holds for others is bounded (Limits). one sedimentree per
// node: a commit names no node, it is the node's whose sedimentree it came on. adapted from the old
// stack's transport.ts (now in ermine-graveyard/extensions/subduction), which carries blops. the lock
// is together's (../../../typescript/lock.ts). the mailroom (mailroom.ts) holds the histories and what
// is taken in; this hands it what arrives (pend, settle, member, hint, hear, stopped) and is its
// Stack (made, send, stop, handed, taking).
//
// the envelope: what this stack stores and sends of a node, before the lock closes it: a map of the
// node's id and what it carries. {id, sealed}: a loose commit, its seal; {id, commit}: an ephemeral
// commit, never sealed; {id, run, snapshot?} (or {id, members, snapshot?}, as first written): a
// fragment. relays see only the tree id.
//
// the door: what Subduction is about to store under a name (a loose commit's stored id, a fragment's
// head) is read first, the lock opened: the envelope's id must make this tree, a seal in it must be
// for that id, and the stored id of that id and the commit's name (seal.ts) must be the name given (a
// fragment: its head one of its members, each member's stored id its own, its members and boundary
// closed, as closure says); no signature is checked for this. one that fails is passed over: not
// stored, noted in the document's status when the document is followed and the name not held. a
// tree not named yet (unnamed) gets the same door, its id read from the envelope (the lock opened
// with no id); one the lock cannot open so is stored as it came. a followed document's commit that
// passes the door is checked whole (its signature, its lock, its shape) and refused when it is not
// good: not stored, noted the same (one already held: not noted). the storage never throws
// (Subduction would drop the connection, and a relay every follower with it): every save it does
// not store returns as if it had. Subduction 0.23 adds what it was given to its own tree in memory
// whether the save stored it or not, pushes it to a peer subscribed, and until it restarts does not
// ask a peer for that name again
//
// the tree id: the first 16 bytes of BLAKE3 of the pieces "ermine/v1/tree" and the id's UTF-8 (each
// its length as an unsigned varint, then its bytes), then 16 zero bytes (galaxy's Keyhive rule)
import * as sd from "npm:@automerge/subduction@0.23.0"
import { type Lock, unlocked } from "../../../typescript/lock.ts"
import {
	each as unpacking,
	pack as packing,
	PackError,
	type Unpacked,
} from "../../../typescript/packer.ts"
import { hex, unhex } from "../../../typescript/hex.ts"
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import * as cbor from "@ermine/encoding/cbor"
import { CommitError, decode, name as nameOf, splitKey } from "@ermine/encoding/commit"
import { build, depth, type Fragment } from "./fragment.ts"
import type { Kept } from "../../../typescript/history.ts"
import {
	by,
	type Code,
	type Doc,
	type Limits,
	type Mailroom,
	type Member,
	note,
	type Refusal,
	refusal,
	type Sealed,
} from "../../../typescript/mailroom.ts"
import {
	ED25519,
	ed25519Key,
	ELSEWHERE,
	SealError,
	type Signer,
	stored,
	utf8,
	varint,
} from "../../../typescript/seal.ts"
import { tablesOf } from "../../../typescript/snapshot.ts"
import type { Taking } from "../../../typescript/transport_conformance_hook.ts"

export type { Fragment }

// the lock (../../../typescript/lock.ts): the stack calls it; together owns it
export { type Lock, type Opened, unlocked } from "../../../typescript/lock.ts"

// Subduction drops an ephemeral payload over this; a closed commit over it is sent as parts of at
// most PART bytes
export const LIMIT = 65536
export const PART = 60000

// what a device holds for others at most, besides the mailroom's (mailroom.ts's Limits), each letting go of
// its oldest past it (heard again, it comes in again). joins: the ephemeral payloads being joined;
// parts: the parts one may have (so one is at most PART × parts bytes)
export type Joining = { joins: number; parts: number }
export const JOINING: Joining = { joins: 64, parts: 1024 }

// the part of a device the stack is: what reaches the network and the storage
export type Wired = {
	ready(): Promise<void>
	connect(transport: sd.Transport, initiator: boolean): Promise<void>
	// a server by its WebSocket url, by discovery (the service name its url's host, unless given)
	connectDiscover(url: string, service?: string): Promise<void>
	// every connection to the peer with that key (a multikey)
	disconnect(key: Uint8Array): Promise<void>
	follow(doc: string): Promise<void>
	// bytes to whoever listens on a topic (a string, named by hash so it is never a document's):
	// ephemeral, kept nowhere, not heard here. over LIMIT: sent as parts, joined at the other end
	send(topic: string, bytes: Uint8Array): Promise<void>
	// fn told each message on the topic: the sender's key (its multikey, as lowercase hex), the bytes.
	// subscribes as needed (queued: idle() waits for it); gives back the stop, which only removes fn
	listen(topic: string, fn: (from: string, bytes: Uint8Array) => void): () => void
	stored(doc: string): Promise<Uint8Array[]>
	fragments(doc: string): Fragment[]
	// how many trees the storage holds whose id is not named yet: listed, not taken in
	unnamed(): number
	// the lock's or the check's changed(): what waited on the lock, or on the check, is tried again
	changed(): Promise<void>
	// an ephemeral payload's parts not joined yet are dropped now, as the setting would in time
	expire(): void
	close(): Promise<void>
}

const commitId = (b: Uint8Array) => new sd.CommitId(b)

// what the door makes of a save: stored; or not stored (passed over or refused), nothing thrown
type Door = "store" | "pass"

const TREE = new TextEncoder().encode("ermine/v1/tree")

// the tree id Subduction files a node under: made from its id (above)
export function treeOf(id: string): Uint8Array {
	const all: number[] = []
	for (const p of [TREE, utf8(id)]) all.push(...varint(p.length), ...p)
	const out = new Uint8Array(32)
	out.set(blake3(Uint8Array.from(all)).subarray(0, 16))
	return out
}

// an envelope's bytes: the id and what it carries (above), canonical CBOR. an id not well-formed:
// refused (shape)
export function envelope(id: string, carries: { [key: string]: cbor.Value }): Uint8Array {
	utf8(id)
	return cbor.encode({ ...carries, id })
}

// why an envelope for another id is refused, beside the code id
export const OTHER = "the envelope is for another id"

// an envelope read: its id, and what it carries (its id taken off), when its keys are id and those
// of one of the forms (each a list of keys; a key ending "?" may be left out); else shape
function envelopeOf(
	open: Uint8Array,
	...forms: string[][]
): { id: string; carries: { [key: string]: cbor.Value } } | "shape" {
	let x: cbor.Value
	try {
		x = cbor.decode(open)
	} catch (e) {
		if (e instanceof cbor.CborError) return "shape"
		throw e
	}
	if (x === null || typeof x !== "object" || Array.isArray(x) || ArrayBuffer.isView(x)) {
		return "shape"
	}
	const { id, ...rest } = x as { [key: string]: cbor.Value }
	if (typeof id !== "string") return "shape"
	const keys = Object.keys(rest)
	const fits = forms.some((f) => {
		const need = f.filter((k) => !k.endsWith("?")), may = f.map((k) => k.replace(/\?$/, ""))
		return need.every((k) => k in rest) && keys.every((k) => may.includes(k))
	})
	return fits ? { id, carries: rest } : "shape"
}

// an envelope opened, for the document: what it carries; not one (shape), or for another id (other:
// refused id, with OTHER)
function opens(
	d: Doc,
	open: Uint8Array,
	...forms: string[][]
): { [key: string]: cbor.Value } | "shape" | "other" {
	const e = envelopeOf(open, ...forms)
	if (e === "shape") return e
	return e.id === d.id ? e.carries : "other"
}

// a seal's id and its commit's name, unchecked; undefined: not a seal's shape (unseal says so)
function sealOf(sealed: Uint8Array): { id: string; name: Uint8Array } | undefined {
	let o: cbor.Value
	try {
		o = cbor.decode(sealed)
	} catch {
		return
	}
	const { id, commit } = (o ?? {}) as { [key: string]: cbor.Value }
	if (typeof id !== "string" || !(commit instanceof Uint8Array)) return
	return { id, name: nameOf(commit) }
}

// a fragment's members as the door reads them, no signature checked: {id, run} unpacked, or {id,
// members} each seal read; each with the stored id its pack, or its seal, says. a pack that is not
// one, or a member that is no seal: shape
function listed(o: { [key: string]: cbor.Value }): Unpacked[] | "shape" {
	try {
		if ("run" in o) return o.run instanceof Uint8Array ? [...unpacking(o.run)] : "shape"
		if (!Array.isArray(o.members)) return "shape"
		const out: Unpacked[] = []
		for (const m of o.members) {
			const s = m instanceof Uint8Array ? sealOf(m) : undefined
			if (s === undefined || !(m instanceof Uint8Array)) return "shape"
			const commit = (cbor.decode(m) as { commit: Uint8Array }).commit
			out.push({ commit, name: s.name, stored: stored(s.id, s.name), sealed: m })
		}
		return out
	} catch (e) {
		if (e instanceof PackError || e instanceof SealError) return "shape"
		throw e
	}
}

// the door's check of a fragment's members, for the id: each one's stored id that id's and its
// commit's name (a seal for another id: id; one a pack claims for a commit it vouches for: stored),
// and the head, when given, one of them (stored); undefined: they pass
function names(id: string, members: Unpacked[], head?: Uint8Array): Code | undefined {
	for (const m of members) {
		if (!same(stored(id, m.name), m.stored)) return m.sealed ? "id" : "stored"
	}
	if (head !== undefined && !members.some((m) => same(m.stored, head))) return "stored"
}

// the door's check of a fragment's closure, for the id: each member's parent a member, or one of the
// head's depth or more and in the boundary (the walk stops there); one of less depth not a member was
// taken out as a member of a fragment below (Subduction's build does so), so only with a boundary.
// none such: the boundary is those parents, no more. a commit that does not decode is the seals'
// check's. closure: it fails; undefined: it passes
function closure(
	id: string,
	members: Unpacked[],
	head: Uint8Array,
	boundary: Uint8Array[],
): "closure" | undefined {
	const top = depth(head), ids = new Set(members.map((m) => hex(m.stored)))
	const given = new Set(boundary.map(hex)), reached = new Set<string>()
	let below = false
	for (const m of members) {
		let parents: Uint8Array[]
		try {
			parents = decode(m.commit).parents
		} catch (e) {
			if (e instanceof CommitError) return
			throw e
		}
		for (const p of parents) {
			const s = stored(id, p), k = hex(s)
			if (ids.has(k)) continue
			if (depth(s) < top) below = true
			else if (given.has(k)) reached.add(k)
			else return "closure"
		}
	}
	if (below ? given.size === 0 : reached.size !== given.size) return "closure"
}

const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i])

// a fragment as Subduction's storage is given it: checkpoints as their first 12 bytes
type Saved = {
	head: sd.CommitId
	boundary: sd.CommitId[]
	checkpoints: Uint8Array[]
	blob: Uint8Array
}

// what waits on the lock, as it arrived: a fragment's boundary (a loose commit's: none), and the
// opening again. queued: changed has queued it (once, however often it is told before it runs)
type Held = { boundary: string[]; again(): Promise<void>; queued?: true }

// what the stack holds of a document, besides the mailroom's: its tree and topic, the fragments made or
// taken in, those refused whole (by head, with the text a lock refused with), what waits on the lock
// (by head, tried again by changed: loose commits and fragments, each at most limits.pending, the
// oldest let go of past it; stored still, it comes in again as the device starts), and how many
// taken-in seals have a depth, so a build with none is skipped
type Tree = {
	tree: sd.SedimentreeId
	topic: sd.Topic
	fragments: Map<string, Fragment>
	broken: Map<string, Refusal>
	locked: { commits: Map<string, Held>; fragments: Map<string, Held> }
	deep: number
}

// the stack over the mailroom. signer: Subduction's, its key must be Ed25519: Subduction's peer keys are.
// limits: the mailroom's and the stack's, whole. join: how long, in ms, the parts of an ephemeral payload
// may wait for the rest; storage: where Subduction keeps what it saves (taken in on save as ever),
// default in memory; lazy: what the storage holds is taken in as each document is followed, not at
// the start; snapshotOf: the integration's, the tables at a fragment's head, packed (snapshot.ts),
// for its snapshot, undefined: none for this one (the integration decides when one is worth it)
export function createSubduction(
	mailroom: Mailroom,
	options: {
		signer: Signer
		lock?: Lock
		service?: string
		join?: number
		storage?: sd.SedimentreeStorage
		lazy?: boolean
		snapshotOf?: (doc: string, head: Kept) => Uint8Array | undefined
		limits: Limits & Joining
	},
) {
	const lock = options.lock ?? unlocked
	const service = options.service ?? "ermine"
	const join = options.join ?? 30000
	const limits = options.limits
	const lazy = options.lazy === true
	const { run, later, trouble, named } = mailroom
	const { moved, refuse, clear, settle, opened, pend, member, hint } = mailroom
	const trees = new WeakMap<Doc, Tree>()
	// the documents by their tree id's hex: which id made this tree id. none for a tree until its
	// document is named (a hash can't be turned back into an id): what comes for it is unnamed
	const docs = new Map<string, Doc>()
	const document = (tree: Uint8Array): Doc | undefined => docs.get(hex(tree))
	function of(d: Doc): Tree {
		let t = trees.get(d)
		if (t === undefined) {
			const id = treeOf(d.id)
			docs.set(hex(id), d)
			t = {
				tree: sd.SedimentreeId.fromBytes(id),
				topic: sd.Topic.fromBytes(id),
				fragments: new Map(),
				broken: new Map(),
				locked: { commits: new Map(), fragments: new Map() },
				deep: 0,
			}
			trees.set(d, t)
		}
		return t
	}
	// the documents followed, by their tree id's hex
	const followed = new Set<string>()
	// the trees the storage held at the start not taken in then (their id not named yet, or lazy),
	// by hex, and those taken in since: each taken in when its document is followed
	const held = new Set<string>()
	const taken = new Set<string>()
	const peers = new Map<string, sd.PeerId>()
	// topics listened on, by their hash's hex: the Topic and who is told
	const topics = new Map<
		string,
		{ topic: sd.Topic; fns: Set<(from: string, bytes: Uint8Array) => void> }
	>()

	// ---- taking in

	// this device's own loose commits being added, by stored id: their closed bytes
	const owned = new Map<string, Uint8Array>()

	// a loose commit's steps, the lock, the door (the envelope's id, the seal's, its stored id), then
	// the seal: what the lock opened and its commit; "wait": the lock cannot open it yet; "passed": it
	// failed the door (not the commit named); "refused": not good. noted (note): either, at the head
	async function opening(
		d: Doc,
		h: string,
		blob: Uint8Array,
		note = true,
	): Promise<{ sealed: Uint8Array; it: Sealed } | "wait" | "passed" | "refused"> {
		const no = (to: "passed" | "refused", code: Code, why?: string, name?: string) => {
			if (note) refuse(d, h, code, name, why), settle(d)
			return to
		}
		const open = await lock.open(d.bytes, blob)
		if (!(open instanceof Uint8Array)) {
			if ("wait" in open) return "wait"
			return no("refused", "lock", open.refused)
		}
		const got = opens(d, open, ["sealed"])
		if (got === "other") return no("passed", "id", OTHER)
		if (got === "shape" || !(got.sealed instanceof Uint8Array)) return no("refused", "shape")
		const sealed = got.sealed, peek = sealOf(sealed)
		if (peek !== undefined) {
			if (peek.id !== d.id) return no("passed", "id", ELSEWHERE)
			if (hex(stored(d.id, peek.name)) !== h) {
				return no("passed", "stored", undefined, hex(peek.name))
			}
		}
		let it: Sealed
		try {
			it = await opened(d, sealed)
		} catch (e) {
			if (!(e instanceof SealError)) throw e
			return no("refused", e.code, e.code === "id" ? e.reason : undefined)
		}
		return { sealed, it }
	}

	// the steps of a loose commit, in order: the lock, the door, the seal, then pending
	async function commit(d: Doc, head: Uint8Array, parents: Uint8Array[], blob: Uint8Array) {
		const h = hex(head)
		if (d.seen.has(h)) return
		of(d).locked.commits.delete(h)
		const got = await opening(d, h, blob)
		if (got === "passed" || got === "refused") return
		if (got === "wait") {
			clear(d, h)
			note(limits.pending, of(d).locked.commits, h, {
				boundary: [],
				again: () => commit(d, head, parents, blob),
			})
			return
		}
		pend(d, h, {
			commit: true,
			it: got.it,
			sealed: got.sealed,
			parents: got.it.parents.map(hex),
			given: parents.map(hex).sort(by),
		})
		settle(d)
	}

	// what Subduction may store of a loose commit in a followed document (its admission): "store", one
	// that passes the door and opens to a good seal, or waits on the lock; "pass", any other: one that
	// fails the door (stored, it would stand under the name of a commit it isn't), or is not good (the
	// lock refusing it too). what is passed over or refused is noted with its code, as taking it in
	// notes it, and told (moved) now, as a take tells (a name held: not noted, that one is here)
	async function allows(d: Doc, head: Uint8Array, blob: Uint8Array): Promise<Door> {
		const h = hex(head), mine = owned.get(h)
		if (mine !== undefined && same(mine, blob)) return "store"
		const here = d.seen.has(h)
		const got = await opening(d, h, blob, !here)
		if (got !== "passed" && got !== "refused") return "store"
		if (!here) moved(d)
		return "pass"
	}

	// the door for a tree not named yet (above): a loose commit's or a fragment's envelope (a fragment's:
	// its boundary given), its id read from it. one the lock cannot open without its id: stored as it
	// came
	async function stranger(
		tree: Uint8Array,
		head: Uint8Array,
		blob: Uint8Array,
		boundary?: Uint8Array[],
	): Promise<Door> {
		const open = await lock.open(new Uint8Array(0), blob)
		if (!(open instanceof Uint8Array)) return "store"
		const e = boundary
			? envelopeOf(open, ["run", "snapshot?"], ["members", "snapshot?"])
			: envelopeOf(open, ["sealed"])
		if (e === "shape") return "pass"
		let mine: boolean
		try {
			mine = same(treeOf(e.id), tree)
		} catch (x) {
			if (!(x instanceof SealError)) throw x
			mine = false
		}
		if (!mine) return "pass"
		if (boundary) {
			const members = listed(e.carries)
			if (members === "shape" || names(e.id, members, head) !== undefined) return "pass"
			return closure(e.id, members, head, boundary) === undefined ? "store" : "pass"
		}
		const s = e.carries.sealed instanceof Uint8Array ? sealOf(e.carries.sealed) : undefined
		return s !== undefined && s.id === e.id && same(stored(e.id, s.name), head) ? "store" : "pass"
	}

	// a fragment's envelope opened: {id, run: its members as a pack (packer.ts), snapshot?: packed
	// tables}, or {id, members: [sealed…], snapshot?} as it was first written (a pack that is not one,
	// or comes to too much: shape). first the door's checks (names; head: one of them; with the
	// boundary, closure), then each member unsealed in order: the first that is not good ends it, and
	// the fragment is refused whole with its code. one a pack's next vouches for is taken once that
	// one's signature is good. the snapshot dropped when it does not read back
	async function contents(
		d: Doc,
		open: Uint8Array,
		head?: Uint8Array,
		boundary?: Uint8Array[],
	): Promise<{ members: Member[]; snapshot?: Uint8Array } | Code | "other" | "closure"> {
		const o = opens(d, open, ["run", "snapshot?"], ["members", "snapshot?"])
		if (typeof o === "string") return o
		const items = listed(o)
		if (items === "shape") return items
		const wrong = names(d.id, items, head) ??
			(head && boundary ? closure(d.id, items, head, boundary) : undefined)
		if (wrong !== undefined) return wrong
		const members: Member[] = [], vouched: Member[] = []
		try {
			for (const item of items) {
				if (item.sealed === undefined) {
					const c = decode(item.commit)
					const it = { name: item.name, bytes: item.commit, stored: item.stored, ...c }
					vouched.push({ it: { ...it, lamport: c.lamport, parents: c.parents } })
				} else {
					const it = await opened(d, item.sealed)
					members.push(...vouched.splice(0), { sealed: item.sealed, it })
				}
			}
		} catch (e) {
			if (e instanceof SealError) return e.code
			throw e
		}
		const snapshot = o.snapshot
		if (snapshot === undefined) return { members }
		if (!(snapshot instanceof Uint8Array)) return "shape"
		try {
			tablesOf(snapshot)
		} catch {
			return { members }
		}
		return { members, snapshot }
	}

	// a fragment's contents, checked against what Subduction says of it: its head one of its members,
	// and its members and boundary closed (the door's, in contents); its head of depth 1 or more,
	// every other member of less depth, and reached from the head along parents among the members; its
	// boundary of the head's depth or more and none of its members; its checkpoints (their first 12
	// bytes; given as Subduction keeps them, or none said) each member but the head with a depth. a
	// head here whose fragment Subduction's build makes here (its walk, less the members of every
	// fragment below): its members and boundary that fragment's. a code: not taken
	async function checked(
		d: Doc,
		head: Uint8Array,
		boundary: Uint8Array[],
		checkpoints: Uint8Array[] | undefined,
		open: Uint8Array,
	): Promise<{ members: Member[]; snapshot?: Uint8Array } | Code | "other" | "closure"> {
		const got = await contents(d, open, head, boundary)
		if (typeof got === "string") return got
		const h = hex(head), top = depth(head)
		const ids = new Set(got.members.map((m) => hex(m.it.stored)))
		if (top === 0 || reach(head, got.members).size !== ids.size) return "boundary"
		for (const m of got.members) {
			if (hex(m.it.stored) !== h && depth(m.it.stored) >= top) return "boundary"
		}
		for (const b of boundary) if (depth(b) < top || ids.has(hex(b))) return "boundary"
		if (checkpoints !== undefined) {
			const want = new Set<string>()
			for (const id of ids) if (id !== h && depth(unhex(id)) > 0) want.add(id.slice(0, 24))
			const given = new Set(checkpoints.map((c) => hex(c.subarray(0, 12))))
			if (want.size !== given.size || [...want].some((c) => !given.has(c))) return "boundary"
		}
		if (d.seen.has(h)) {
			// built again here: the head's own fragment here is left out
			const known = (x: Uint8Array) => hex(x) === h ? undefined : of(d).fragments.get(hex(x))
			const w = build([head], lookupOf(d), known).find((f) => same(f.head, head))
			const set = (xs: Uint8Array[]) => [...new Set(xs.map(hex))].sort(by).join()
			if (
				w && (set(w.members) !== [...ids].sort(by).join() || set(w.boundary) !== set(boundary))
			) {
				return "boundary"
			}
		}
		return got
	}

	// a commit's parents, by stored id, as fragments are walked
	const lookupOf = (d: Doc) => (id: Uint8Array) => d.seen.get(hex(id))?.ids.map(unhex)

	// the stored ids of the members reached from the head, along each one's parents (by name) among
	// the members
	function reach(head: Uint8Array, members: Member[]): Set<string> {
		const byName = new Map<string, Member[]>()
		for (const m of members) {
			const n = hex(m.it.name)
			byName.set(n, [...byName.get(n) ?? [], m])
		}
		const reached = new Set<string>(), todo = members.filter((m) => same(m.it.stored, head))
		for (let m; (m = todo.pop()) !== undefined;) {
			const s = hex(m.it.stored)
			if (reached.has(s)) continue
			reached.add(s)
			for (const p of m.it.parents) todo.push(...byName.get(hex(p)) ?? [])
		}
		return reached
	}

	// what Subduction may store of a fragment in a followed document (its admission), as allows: one
	// that opens and is checked, or waits on the lock, stored; any other not: one that fails the door
	// (an envelope for another id, a member's stored id not its own, the head none of them, a member's
	// parent left out or a boundary not the members' own) passed over, one not good otherwise (the
	// lock refusing it too) refused. one whose head is not here yet is noted refused whole with its
	// code, and told (moved) now, as a take tells
	async function allowsFragment(
		d: Doc,
		head: Uint8Array,
		boundary: Uint8Array[],
		checkpoints: Uint8Array[] | undefined,
		blob: Uint8Array,
	): Promise<Door> {
		const h = hex(head)
		const open = await lock.open(d.bytes, blob)
		if (!(open instanceof Uint8Array)) {
			if ("wait" in open) return "store"
			if (!d.seen.has(h)) broke(d, h, "lock", open.refused)
			moved(d)
			return "pass"
		}
		const got = await checked(d, head, boundary, checkpoints, open)
		if (typeof got !== "string") return "store"
		if (!d.seen.has(h)) broke(d, h, ...noted(got))
		moved(d)
		return "pass"
	}

	// a fragment's refusal as it is noted: another id's envelope (other) is id, with OTHER; a member
	// sealed for another id, id with ELSEWHERE; one not closed (closure), boundary
	const noted = (got: Code | "other" | "closure"): [Code, string?] =>
		got === "other"
			? ["id", OTHER]
			: got === "closure"
			? ["boundary"]
			: [got, got === "id" ? ELSEWHERE : undefined]

	// a fragment refused whole, by head, with the text a lock refused it with
	function broke(d: Doc, h: string, code: Code, why?: string) {
		note(limits.refused, of(d).broken, h, refusal(code, why))
	}

	// a fragment taken in: its members (each checked) as seals alone, its snapshot a hint. one whose
	// head is here already has its members checked too, and is only noted
	async function fragment(
		d: Doc,
		head: Uint8Array,
		boundary: Uint8Array[],
		checkpoints: Uint8Array[] | undefined,
		blob: Uint8Array,
	) {
		const h = hex(head)
		const here = d.seen.get(h)
		if (here && of(d).fragments.has(h) && d.judged.has(here.name)) return
		of(d).locked.fragments.delete(h)
		const open = await lock.open(d.bytes, blob)
		if (!(open instanceof Uint8Array)) {
			if (here) {
				if (!of(d).fragments.has(h)) {
					of(d).fragments.set(h, { head, members: [], boundary, checkpoints: [] })
				}
			} else if ("wait" in open) {
				note(limits.pending, of(d).locked.fragments, h, {
					boundary: boundary.map(hex),
					again: () => fragment(d, head, boundary, checkpoints, blob),
				})
			} else broke(d, h, "lock", open.refused)
			return
		}
		const got = await checked(d, head, boundary, checkpoints, open)
		if (typeof got === "string") {
			if (!here) broke(d, h, ...noted(got))
			return
		}
		of(d).broken.delete(h)
		for (const m of got.members) member(d, m)
		if (!of(d).fragments.has(h)) {
			const members = got.members.map((m) => m.it.stored)
			of(d).fragments.set(h, { head, members, boundary, checkpoints: [] })
		}
		const top = got.members.find((m) => hex(m.it.stored) === h)!.it.name
		if (got.snapshot !== undefined) hint(d, hex(top), got.snapshot)
		settle(d)
	}

	// an ephemeral commit heard from a device with that key (never sealed): the lock's open, then the
	// mailroom's hear (decode, its signer the sender's); never stored, no commit steps
	async function hear(d: Doc, blob: Uint8Array, from: Uint8Array) {
		const open = await lock.open(d.bytes, blob)
		if (!(open instanceof Uint8Array)) {
			if (!("wait" in open)) mailroom.unheard(d, nameOf(blob), "lock", open.refused)
			return
		}
		const got = opens(d, open, ["commit"])
		if (got === "other") return mailroom.unheard(d, nameOf(blob), "id", OTHER)
		if (got === "shape" || !(got.commit instanceof Uint8Array)) {
			return mailroom.unheard(d, nameOf(blob), "shape")
		}
		mailroom.hear(d, got.commit, ed25519Key(from))
	}

	// ---- parts of an ephemeral payload over Subduction's limit

	// by document, sender and whole: the parts here, from when the first came
	const joining = new Map<
		string,
		{
			from: Uint8Array
			whole: Uint8Array
			parts: number
			got: Map<number, Uint8Array>
			at: number
		}
	>()
	const expire = (all = false) => {
		const now = Date.now()
		for (const [k, j] of [...joining]) if (all || now - j.at >= join) joining.delete(k)
	}

	// a payload that is a map: its keys and values; undefined: not one (a commit, or no map)
	function mapOf(payload: Uint8Array): { [key: string]: cbor.Value } | undefined {
		let x: cbor.Value
		try {
			x = cbor.decode(payload)
		} catch (e) {
			if (e instanceof cbor.CborError) return
			throw e
		}
		if (x === null || typeof x !== "object" || Array.isArray(x) || ArrayBuffer.isView(x)) {
			return
		}
		return x as { [key: string]: cbor.Value }
	}

	// a payload that is a stop (Device.stop): a map of exactly stop, a string: the table. undefined:
	// not one
	function stopOf(payload: Uint8Array): string | undefined {
		const m = mapOf(payload)
		if (m === undefined || Object.keys(m).join() !== "stop" || typeof m.stop !== "string") return
		return m.stop
	}

	// a payload that is a part: a map of exactly whole, part, parts and bytes. undefined: not one
	// (a commit, or no map); null: one, but its values are not (dropped)
	function partOf(payload: Uint8Array) {
		const m = mapOf(payload)
		if (m === undefined) return
		const keys = Object.keys(m).sort()
		if (keys.join() !== "bytes,part,parts,whole") return
		const { whole, part, parts, bytes } = m
		if (
			!(whole instanceof Uint8Array) || whole.length !== 32 ||
			!(bytes instanceof Uint8Array) ||
			bytes.length > PART || typeof part !== "number" || typeof parts !== "number" ||
			!Number.isInteger(part) || !Number.isInteger(parts) || part < 0 || part >= parts ||
			parts > limits.parts
		) return null
		return { whole, part, parts, bytes }
	}

	// one part from a sender: kept with its whole's; when all are here, joined, the hash checked,
	// and what they make given to done as a payload (a bad hash: dropped). where: the document's id
	// or the topic's hex, to mailroom the parts of one apart from another's
	async function gather(
		where: string,
		p: NonNullable<ReturnType<typeof partOf>>,
		from: Uint8Array,
		done: (all: Uint8Array) => Promise<void>,
	) {
		expire()
		const k = where + " " + hex(from) + " " + hex(p.whole)
		let j = joining.get(k)
		if (!j) {
			if (joining.size >= limits.joins) joining.delete(joining.keys().next().value!)
			joining.set(
				k,
				j = { from, whole: p.whole, parts: p.parts, got: new Map(), at: Date.now() },
			)
		}
		if (j.parts !== p.parts) return
		if (!j.got.has(p.part)) j.got.set(p.part, p.bytes)
		if (j.got.size < j.parts) return
		joining.delete(k)
		const all = new Uint8Array(
			[...Array(j.parts).keys()].reduce((n, i) => n + j!.got.get(i)!.length, 0),
		)
		let at = 0
		for (let i = 0; i < j.parts; i++) all.set(j.got.get(i)!, at), at += j.got.get(i)!.length
		if (hex(blake3(all)) !== hex(p.whole)) return
		await done(all)
	}

	// ---- building

	// the fragments not built yet, walked from these heads; none given: from every head. each one's
	// blob: its members' seals, in lamport order, and the tables at its head, packed, when the
	// integration gives them
	async function building(d: Doc, from?: Uint8Array[]) {
		if (of(d).deep === 0) return
		const lookup = lookupOf(d)
		let heads = from
		if (heads === undefined) {
			const covered = new Set<string>()
			for (const s of d.seen.keys()) for (const p of lookup(unhex(s)) ?? []) covered.add(hex(p))
			heads = [...d.seen.keys()].filter((s) => !covered.has(s)).map(unhex)
		}
		const fresh = build(heads, lookup, (head) => of(d).fragments.get(hex(head)))
		for (const f of fresh) of(d).fragments.set(hex(f.head), f)
		for (const f of fresh) {
			const ms = f.members.map((m) => ({ id: m, ...d.seen.get(hex(m))! }))
			ms.sort((a, b) => a.lamport - b.lamport || by(a.name, b.name))
			const top = d.seen.get(hex(f.head))!.name
			// "run": the blob's key, as stored
			const blob: { run: Uint8Array; snapshot?: Uint8Array } = {
				run: packing(ms.map((m) => m.sealed ?? { commit: m.bytes, stored: m.id })),
			}
			const kept = d.histories.stored.get(unhex(top))
			const snapshot = kept && options.snapshotOf?.(d.id, kept)
			if (snapshot) {
				blob.snapshot = snapshot
				hint(d, top, snapshot, true)
			}
			const bytes = envelope(d.id, blob)
			const names = f.boundary.map((b) => unhex(d.seen.get(hex(b))!.name))
				.sort((a, b) => by(hex(a), hex(b)))
			const closed = await lock.close(d.bytes, nameOf(bytes), names, bytes)
			await sub.addFragment(
				of(d).tree,
				commitId(f.head),
				f.boundary.map(commitId),
				f.checkpoints.map(commitId),
				closed,
			)
			await compact(d, f.head)
		}
	}

	// a fragment stored: the loose commits it stands for let go from storage (sedimentree's minimal
	// form, on disk too): the pack holds them, about 40 bytes each against about 280. only the members
	// of the fragment the storage holds for that head (Subduction keeps one a head), checked, and
	// reached from its head: whatever is let go of comes back from it
	async function compact(d: Doc, head: Uint8Array) {
		const f = await memory.loadFragment(of(d).tree, commitId(head))
		if (!f) return
		const open = await lock.open(d.bytes, f.blob)
		if (!(open instanceof Uint8Array)) return
		const got = await contents(d, open)
		if (typeof got === "string") return
		for (const id of reach(head, got.members)) {
			await memory.deleteCommit(of(d).tree, commitId(unhex(id)))
		}
	}

	// what Subduction's storage is asked to save, taken in; then fragments built
	async function save(
		tree: sd.SedimentreeId,
		commits: { id: sd.CommitId; parents: sd.CommitId[]; blob: Uint8Array }[],
		fragments: Saved[],
	) {
		const d = document(tree.toBytes())!
		const deep = of(d).deep
		for (const c of commits) {
			await commit(d, c.id.toBytes(), c.parents.map((p) => p.toBytes()), c.blob)
		}
		for (const f of fragments) {
			const head = f.head.toBytes()
			await fragment(d, head, f.boundary.map((b) => b.toBytes()), f.checkpoints, f.blob)
			if (of(d).fragments.get(hex(head))?.members.length) later(() => compact(d, head))
		}
		moved(d)
		// only a commit taken in that can head a fragment (a leading zero byte), or a fragment, makes
		// one to build: walking every commit after each would make n commits cost n²
		if (fragments.length || of(d).deep !== deep) await building(d)
	}

	// ---- sending what take queued

	// a stored commit of this device's: sealed, its seal handed over (taken in already), added as a
	// loose commit; a fragment built when Subduction asks for one (FragmentRequested), from it
	async function store(d: Doc, kept: Kept) {
		// this device's own: named already, its signer this one
		const { sealed, stored: s } = await mailroom.sealed(d, kept)
		const blob = await lock.close(d.bytes, kept.name, kept.parents, envelope(d.id, { sealed }))
		const parents = await mailroom.handed(d, kept, sealed, s)
		// its own bytes pass the door unopened (an own commit is never opened)
		owned.set(hex(s), blob)
		try {
			const r = await sub.addCommit(of(d).tree, commitId(s), parents.map(commitId), blob)
			if (r) await run(() => building(d, [s]))
		} finally {
			owned.delete(hex(s))
		}
	}

	// an ephemeral commit of this device's: closed, published, as parts when over LIMIT
	async function publish(d: Doc, kept: Kept) {
		const blob = await lock.close(
			d.bytes,
			kept.name,
			kept.parents,
			envelope(d.id, { commit: kept.bytes }),
		)
		if (blob.length <= LIMIT) return await sub.publishEphemeral(of(d).topic, blob)
		const whole = blake3(blob), parts = Math.ceil(blob.length / PART)
		for (let i = 0; i < parts; i++) {
			const bytes = blob.subarray(i * PART, (i + 1) * PART)
			await sub.publishEphemeral(of(d).topic, cbor.encode({ whole, part: i, parts, bytes }))
		}
	}

	// ---- Subduction

	const memory = options.storage ?? new sd.MemoryStorage()
	// a fragment's checkpoints, as their first 12 bytes
	const checkpointsOf = (f: sd.Fragment) =>
		(f.checkpoints as unknown as { toBytes(): Uint8Array }[]).map((c) => c.toBytes())

	// a save for a tree whose id is not named yet, past the door (stranger): stored, the tree listed;
	// taken in, each checked whole, when its document is followed
	async function unnamed<T>(tree: sd.SedimentreeId, put: () => Promise<T>): Promise<T> {
		const r = await put()
		held.add(hex(tree.toBytes()))
		return r
	}

	// Subduction's storage, wrapped: it stores only what passes the door (allows, allowsFragment; a
	// tree not named yet, stranger), and what it stores of a followed document is then taken in. one
	// passed over or refused is not stored, and the save returns as if it were: never a throw
	const storage = new Proxy(memory as sd.MemoryStorage, {
		get(target, key) {
			const f = (target as unknown as Record<string | symbol, unknown>)[key]
			if (typeof f !== "function") return f
			if (key === "saveCommit") {
				return async (
					tree: sd.SedimentreeId,
					id: sd.CommitId,
					signed: sd.SignedLooseCommit,
					blob: Uint8Array,
				) => {
					const parents = signed.payload.parents
					const d = document(tree.toBytes())
					if (d === undefined) {
						if (await stranger(tree.toBytes(), id.toBytes(), blob) === "pass") return
						return await unnamed(tree, () => target.saveCommit(tree, id, signed, blob))
					}
					if (await allows(d, id.toBytes(), blob) === "pass") return
					await target.saveCommit(tree, id, signed, blob)
					later(() => save(tree, [{ id, parents, blob }], []))
				}
			}
			if (key === "saveFragment") {
				return async (
					tree: sd.SedimentreeId,
					head: sd.CommitId,
					signed: sd.SignedFragment,
					blob: Uint8Array,
				) => {
					const { boundary } = signed.payload, checkpoints = checkpointsOf(signed.payload)
					const d = document(tree.toBytes()), b = boundary.map((x) => x.toBytes())
					if (d === undefined) {
						if (await stranger(tree.toBytes(), head.toBytes(), blob, b) === "pass") return
						return await unnamed(tree, () => target.saveFragment(tree, head, signed, blob))
					}
					if (await allowsFragment(d, head.toBytes(), b, checkpoints, blob) === "pass") return
					await target.saveFragment(tree, head, signed, blob)
					later(() => save(tree, [], [{ head, boundary, checkpoints, blob }]))
				}
			}
			if (key === "saveBatchAll") {
				return async (
					tree: sd.SedimentreeId,
					commits: {
						commitId: sd.CommitId
						signedCommit: sd.SignedLooseCommit
						blob: Uint8Array
					}[],
					fragments: {
						fragmentHead: sd.CommitId
						signedFragment: sd.SignedFragment
						blob: Uint8Array
					}[],
				) => {
					const d = document(tree.toBytes())
					// what does not get in is left out
					const okCommits: typeof commits = [], okFragments: typeof fragments = []
					for (const c of commits) {
						const id = c.commitId.toBytes()
						const door = d === undefined
							? await stranger(tree.toBytes(), id, c.blob)
							: await allows(d, id, c.blob)
						if (door === "store") okCommits.push(c)
					}
					for (const f of fragments) {
						const p = f.signedFragment.payload, head = f.fragmentHead.toBytes()
						const b = p.boundary.map((x) => x.toBytes())
						const door = d === undefined
							? await stranger(tree.toBytes(), head, f.blob, b)
							: await allowsFragment(d, head, b, checkpointsOf(p), f.blob)
						if (door === "store") okFragments.push(f)
					}
					if (d === undefined) {
						return await unnamed(
							tree,
							() => target.saveBatchAll(tree, okCommits as never, okFragments as never),
						)
					}
					const cs = okCommits.map((c) => ({
						id: c.commitId,
						parents: c.signedCommit.payload.parents,
						blob: c.blob,
					}))
					const fs = okFragments.map((f) => ({
						head: f.fragmentHead,
						boundary: f.signedFragment.payload.boundary,
						checkpoints: checkpointsOf(f.signedFragment.payload),
						blob: f.blob,
					}))
					const n = await target.saveBatchAll(tree, okCommits as never, okFragments as never)
					later(() => save(tree, cs, fs))
					return n
				}
			}
			return f.bind(target)
		},
	}) as unknown as sd.SedimentreeStorage

	const own = splitKey(options.signer.key)
	if (own?.code !== ED25519) throw new Error("a device's key is Ed25519")
	const sub = new sd.Subduction({
		signer: { sign: (m) => options.signer.sign(m), verifyingKey: () => own.key },
		storage,
		onEphemeral: (topic: sd.Topic, from: sd.PeerId, payload: Uint8Array) => {
			const t = topic.toBytes(), k = hex(t), d = docs.get(k)
			const part = partOf(payload)
			// a channel topic (hashed, so never a document's) goes to its listeners
			const c = topics.get(k)
			if (c && !d) {
				const who = hex(ed25519Key(from.toBytes()))
				const tell = (bytes: Uint8Array) => {
					for (const fn of [...c.fns]) fn(who, bytes)
					return Promise.resolve()
				}
				if (part === undefined) tell(payload)
				else if (part) later(() => gather(k, part, from.toBytes(), tell))
				return
			}
			if (!d || !followed.has(k)) return
			// a stop: told in its turn, after the ephemeral commits heard before it
			const stop = part === undefined ? stopOf(payload) : undefined
			if (stop !== undefined) {
				const who = hex(ed25519Key(from.toBytes()))
				later(() => {
					mailroom.stopped(d, who, stop)
					return Promise.resolve()
				})
			} else if (part === undefined) later(() => hear(d, payload, from.toBytes()))
			else if (part) {
				later(() => gather(d.id, part, from.toBytes(), (all) => hear(d, all, from.toBytes())))
			}
		},
	})

	// a tree the storage holds, taken in: its fragments, then its loose commits, as saves are, then
	// its fragments built. read from the storage itself, not through the wrapper, so nothing is saved
	// again. ephemeral commits are never stored, so none come back
	async function load(tree: sd.SedimentreeId) {
		const d = document(tree.toBytes())!
		for (const f of await memory.loadAllFragments(tree)) {
			const signed = f.signed
			await fragment(
				d,
				signed.payload.head.toBytes(),
				signed.payload.boundary.map((b: sd.CommitId) => b.toBytes()),
				checkpointsOf(signed.payload),
				f.blob,
			)
		}
		for (const c of await memory.loadAllCommits(tree)) {
			const signed = c.signed
			await commit(
				d,
				signed.payload.commitId.toBytes(),
				signed.payload.parents.map((p: sd.CommitId) => p.toBytes()),
				c.blob,
			)
		}
		await building(d)
	}

	// starting: what the storage holds, taken in before any connection, for the trees whose id is
	// named already; the others (a hash can't be turned back into an id), and all when lazy, only
	// listed, each taken in when its document is followed
	const loaded = run(async () => {
		for (const tree of await memory.loadAllSedimentreeIds()) {
			const k = hex(tree.toBytes())
			held.add(k)
			if (lazy || document(tree.toBytes()) === undefined) continue
			taken.add(k)
			await load(tree)
		}
	})
	loaded.catch(() => {})

	// a followed document's tree taken in from the storage, once, before anything else of it
	async function loadFollowed(d: Doc) {
		const k = hex(of(d).tree.toBytes())
		if (!held.has(k) || taken.has(k)) return
		taken.add(k)
		await run(() => load(of(d).tree))
	}

	// a channel's topic: BLAKE3 of "ermine/v0/topic" then the topic's CBOR, so never a document's
	function channelTopic(name: string) {
		const prefix = new TextEncoder().encode("ermine/v0/topic"), tail = cbor.encode(name)
		const id = blake3(Uint8Array.from([...prefix, ...tail])), k = hex(id)
		let c = topics.get(k)
		if (!c) topics.set(k, c = { topic: sd.Topic.fromBytes(id), fns: new Set() })
		return c
	}

	// every ephemeral topic this device has subscribed to, by its bytes: subscribed again on each
	// connection made after (a subscription reaches only the connections there when it is made)
	const wanted = new Map<string, sd.Topic>()
	async function subscribe(t: sd.Topic) {
		const k = hex(t.toBytes())
		if (wanted.has(k)) return
		wanted.set(k, t)
		await sub.subscribeEphemeral([t])
	}
	const again = async () => {
		if (wanted.size) await sub.subscribeEphemeral([...wanted.values()])
	}

	// the document fetched from every peer, subscribed; then once more subscribed: what was added
	// while the first was out (or before it was asked) is in neither its answer nor a push
	async function fetched(d: Doc) {
		await sub.syncWithAllPeers(of(d).tree, true)
		await sub.syncWithAllPeers(of(d).tree, true)
	}

	// a followed document asked for again, a while later each time: the server pushes a commit to its
	// subscribers before it stores it, so an ask that lands between is answered without it and hears
	// no push. asked twice more whatever it holds, then on while it holds nothing or a commit waits
	// on a parent; after the last step, every last step while a commit waits
	const backoff = [250, 500, 1000, 2000, 4000, 8000, 16000]
	const timers = new Set<ReturnType<typeof setTimeout>>()
	let closed = false
	const worth = (d: Doc, i: number) => {
		const h = d.histories.stored
		return i < 2 || (i < backoff.length && h.all().length === 0) || mailroom.waits(d)
	}
	function asking(d: Doc, i = 0) {
		if (closed || !worth(d, i)) return
		const t = setTimeout(() => {
			timers.delete(t)
			if (closed || !worth(d, i)) return
			fetched(d).catch((e) => trouble.push(e)).finally(() => asking(d, i + 1))
		}, backoff[Math.min(i, backoff.length - 1)])
		timers.add(t)
	}

	const device: Wired = {
		ready: () => loaded,
		async connect(transport, initiator) {
			await loaded
			const peer = initiator
				? await sub.connectTransport(transport, service)
				: await sub.acceptTransport(transport, service)
			peers.set(hex(peer.toBytes()), peer)
			await again()
			for (const doc of followed) await fetched(docs.get(doc)!)
		},
		async connectDiscover(url, service) {
			await loaded
			const peer = service === undefined
				? await sub.connectDiscover(new URL(url))
				: await sub.connectDiscover(new URL(url), service)
			peers.set(hex(peer.toBytes()), peer)
			await again()
			for (const doc of followed) await fetched(docs.get(doc)!)
		},
		async disconnect(key) {
			// the peer by its Ed25519 key: the multikey's
			const raw = splitKey(key)?.key
			if (raw === undefined) return
			const peer = peers.get(hex(raw)) ?? new sd.PeerId(raw)
			peers.delete(hex(raw))
			await sub.disconnectFromPeer(peer)
		},
		async follow(doc) {
			await loaded
			const d = named(doc)
			followed.add(hex(of(d).tree.toBytes()))
			await loadFollowed(d)
			await subscribe(of(d).topic)
			await fetched(d)
			asking(d)
		},
		async send(topic, bytes) {
			const t = channelTopic(topic).topic
			// a server relays a publish only from a subscriber of its topic
			await subscribe(t)
			if (bytes.length <= LIMIT && partOf(bytes) === undefined) {
				return await sub.publishEphemeral(t, bytes)
			}
			// a payload that looks like a part is sent as parts too, so it arrives as it was sent
			const whole = blake3(bytes), parts = Math.max(1, Math.ceil(bytes.length / PART))
			for (let i = 0; i < parts; i++) {
				const part = bytes.subarray(i * PART, (i + 1) * PART)
				await sub.publishEphemeral(t, cbor.encode({ whole, part: i, parts, bytes: part }))
			}
		},
		listen(topic, fn) {
			const c = channelTopic(topic)
			c.fns.add(fn)
			later(() => subscribe(c.topic))
			return () => void c.fns.delete(fn)
		},
		async stored(doc) {
			const cs = await sub.getCommits(of(named(doc)).tree)
			return (cs ?? []).map((c) => c.commitId.toBytes())
		},
		fragments: (doc) => [...of(named(doc)).fragments.values()],
		unnamed: () => [...held].filter((k) => !docs.has(k)).length,
		async changed() {
			for (const d of mailroom.documents.values()) {
				const { commits, fragments } = of(d).locked
				for (const held of [commits, fragments]) {
					for (const [h, l] of [...held]) {
						if (l.queued) continue
						l.queued = true
						// passed over unless held still as queued: one taken in or let go of since needs
						// nothing, one held again was opened since (the next changed opens it again)
						await run(() => held.get(h) === l ? l.again() : Promise.resolve())
					}
				}
				await run(() => {
					mailroom.retry(d)
					return Promise.resolve()
				})
				await run(() => building(d))
			}
		},
		expire: () => expire(true),
		async close() {
			closed = true
			for (const t of timers) clearTimeout(t)
			timers.clear()
			await mailroom.device.idle().catch(() => {})
			await sub.disconnectAll()
		},
	}
	mailroom.attach({
		made: (d) => void of(d),
		send: (d, layer, kept) => layer === "stored" ? store(d, kept) : publish(d, kept),
		stop: (d, table) => sub.publishEphemeral(of(d).topic, cbor.encode({ stop: table })),
		// a seal taken in: a depth makes it worth building. a loose commit of it waiting on the lock
		// waits no more (it got in another way: a fragment's member)
		handed(d, s) {
			if (depth(s) > 0) of(d).deep++
			of(d).locked.commits.delete(hex(s))
		},
		// what waits on the lock, and the fragments refused whole
		taking(d) {
			const { locked, broken } = of(d)
			const waiting: Taking["waiting"] = [], refused: Taking["refused"] = []
			for (const head of locked.commits.keys()) waiting.push({ commit: head, waiting: [] })
			for (const [head, f] of locked.fragments) {
				waiting.push({ fragment: head, boundary: f.boundary })
			}
			for (const [head, r] of broken) {
				refused.push({
					fragment: head,
					refused: r.code,
					...(r.why !== undefined ? { why: r.why } : {}),
				})
			}
			return { waiting, refused }
		},
	})
	return {
		device,
		// the puts the conformance hooks make (transport_conformance_hook.ts): Subduction's addCommit
		// and addFragment as given
		inside: {
			async put(doc: string, head: Uint8Array, parents: Uint8Array[], blob: Uint8Array) {
				const d = named(doc)
				const r = await sub.addCommit(of(d).tree, commitId(head), parents.map(commitId), blob)
				if (r) await run(() => building(d))
			},
			async putFragment(
				doc: string,
				head: Uint8Array,
				boundary: Uint8Array[],
				checkpoints: Uint8Array[],
				blob: Uint8Array,
			) {
				const d = named(doc)
				await sub.addFragment(
					of(d).tree,
					commitId(head),
					boundary.map(commitId),
					checkpoints.map(commitId),
					blob,
				)
				await run(() => building(d))
			},
		},
	}
}
