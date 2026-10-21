// pack: nodes under (part, id) keys as one item in the canonical encoding (cbor.ts), and back.
// which nodes is the caller's; nothing is loaded or placed. places are never packed. symbols
// can't be carried.
//
// keys sorted by encoding, none twice; a node under several keys is one node again when read.
// node: {change, value?}. change: {time, actor?, reader?, external?,
// metadata?, op?}; external: sites {file, line, column?, function?}; metadata: a map (read from
// the old form too, a list of [key, value] pairs: of a key repeated, the first); op: {patches, undo}.
// whole numbers: time, range ends (safe); line, column, path numbers (int32); written as integers.
// absent fields are left out.
//
// written: {columns: bytes}, deflate.ts's deflate of a map of columns (empty ones left out):
//   ids       ids in first-named order: an ermine id as its bytes (18 or 34), others as text
//   parts     runs [[part, how many], …]
//   which     per key, its id's index
//   nodes     per key, 0 new, k + 1 node k again
//   has       per node, bits: 1 actor, 2 reader, 4 external, 8 metadata, 16 op, 32 value; 64 (cow,
//             a flag nodes no longer have) is read and dropped, never written
//   time      per node, first then zigzag deltas
//   actor, reader, external, metadata   runs [[it, how many], …] over nodes that have one
//   op        per node with an op, {patches, undo}
//   values    per node with a value
// which, nodes, has, time: varints, 7 bits a byte, low first.
// reading also takes the first form {keys: [[part, id, n], …], nodes: [...]}; unknown keys are
// skipped (loosyGoosy). an ermine id is read here by its code and length (ermine/ids' rules, not its
// code: encoding depends on no other package): 00 10 or 1e 10 and 16 bytes, ed 01 and 32. ids as
// bytes of any other shape (an old pack's 32): not a pack.
import * as cbor from "./cbor.ts"
import { deflate, DeflateError, inflate } from "./deflate.ts"
import createEntry, { type ChangeHeader, type Entry as NodeEntry } from "@ermine/node/entry"
import type { Patch, Target } from "@ermine/op/apply"
import type { FileLocation } from "@ermine/util/stacktrace"

export type Key = string | symbol

// a node under a key: what pack is given and unpack gives
export type Entry = readonly [part: Key, id: Key, node: NodeEntry<unknown>]

export type Options = {
	// false: a change's op (its latest patches and their undo) is not written. default true
	op?: boolean
}

export type Reading = {
	// a key no map of a pack has is passed over, in every map, not refused. default false
	loosyGoosy?: boolean
	// the most bytes the columns may inflate to; more: not-a-pack. default 1 GiB
	limit?: number
}

export type Code = "not-a-pack" | "not-a-node" | "cannot-carry" | "already-there"

export class PackError extends Error {
	// the key at fault, as far as there was one
	constructor(readonly code: Code, readonly part?: Key, readonly id?: Key) {
		super([code, part, id].filter((x) => x !== undefined).map(String).join(" "))
	}
}

type Fields = { [k: string]: cbor.Value }

function target(t: Target): Fields {
	const out: Fields = { path: t.path as cbor.Value }
	if (t.range !== undefined) out.range = t.range as cbor.Value
	return out
}

function patch(p: Patch): Fields {
	const out = target(p)
	if (p.value !== undefined) out.value = p.value as cbor.Value
	if (p.move !== undefined) out.move = target(p.move)
	return out
}

function site(s: FileLocation): Fields {
	const out: Fields = { file: s.file, line: s.line }
	if (s.column !== undefined) out.column = s.column
	if (s.function !== undefined) out.function = s.function
	return out
}

function change(h: ChangeHeader, o: Options): Fields {
	const out: Fields = { time: h.time }
	if (h.actor !== undefined) out.actor = h.actor as cbor.Value
	if (h.reader !== undefined) out.reader = h.reader
	if (h.external !== undefined) out.external = h.external.map(site)
	if (h.metadata !== undefined) out.metadata = h.metadata as cbor.Value
	if (h.op !== undefined && o.op !== false) {
		out.op = { patches: h.op.patches.map(patch), undo: h.op.undo.map(patch) }
	}
	return out
}

// a node as written
function written(n: NodeEntry<unknown>, o: Options): Fields {
	const out: Fields = { change: change(n.change, o) }
	if (n.value !== undefined) out.value = n.value as cbor.Value
	return out
}

// reading -------------------------------------------------------------------

const isFields = (x: unknown): x is Fields =>
	x !== null && typeof x === "object" && !Array.isArray(x) && !ArrayBuffer.isView(x) &&
	!(x instanceof cbor.Stand)

// a whole number C holds too: a safe integer (-0 is 0, written 00)
const whole = (x: unknown) => Number.isSafeInteger(x)

// a path's number, a site's line or column: whole, and one any C long holds
const small = (x: unknown) => whole(x) && (x as number) >= -(2 ** 31) && (x as number) < 2 ** 31

const isSpan = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every(whole)
const isPath = (x: unknown) => Array.isArray(x) && x.every((e) => typeof e === "string" || small(e))
const isEntry = (x: unknown) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string"
// metadata in the old form, a list of [key, value] pairs, as an object: of a key repeated, the first
function pairs(list: [string, unknown][]): Fields {
	const out: Fields = {}
	for (const [k, v] of list) {
		if (!Object.hasOwn(out, k)) {
			Object.defineProperty(out, k, {
				value: v,
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
	}
	return out
}

// how a map is read: every key of need there, and, unless loose, none but those of may
class Reader {
	constructor(readonly loose: boolean) {}

	only(x: Fields, need: string[], may: string[]): boolean {
		for (const k of need) if (!Object.hasOwn(x, k)) return false
		if (!this.loose) { for (const k of Object.keys(x)) if (!may.includes(k)) return false }
		return true
	}

	// a target's fields read, only those
	target(x: unknown, also: string[]): Target | undefined {
		if (!isFields(x) || !this.only(x, ["path"], ["path", "range", ...also])) return
		if (!isPath(x.path) || ("range" in x && !isSpan(x.range))) return
		const t: { path: Target["path"]; range?: Target["range"] } = {
			path: x.path as unknown as Target["path"],
		}
		if ("range" in x) t.range = x.range as unknown as Target["range"]
		return t
	}

	patch(x: unknown): Patch | undefined {
		const p: Patch | undefined = this.target(x, ["value", "move"])
		if (p === undefined) return
		const f = x as Fields
		if ("value" in f) p.value = f.value
		if ("move" in f) {
			const m = this.target(f.move, [])
			if (m === undefined) return
			p.move = m
		}
		return p
	}

	site(x: unknown): FileLocation | undefined {
		if (!isFields(x) || !this.only(x, ["file", "line"], ["file", "line", "column", "function"])) {
			return
		}
		if (typeof x.file !== "string" || !small(x.line)) return
		const s: FileLocation = { file: x.file, line: x.line as number }
		if ("column" in x) {
			if (!small(x.column)) return
			s.column = x.column as number
		}
		if ("function" in x) {
			if (typeof x.function !== "string") return
			s.function = x.function
		}
		return s
	}

	// each read by f; none when one is not
	all<T>(x: unknown, f: (e: unknown) => T | undefined): T[] | undefined {
		if (!Array.isArray(x)) return
		const out: T[] = []
		for (const e of x) {
			const t = f(e)
			if (t === undefined) return
			out.push(t)
		}
		return out
	}

	// a change as written; none when it is not one
	header(x: unknown): ChangeHeader | undefined {
		const may = ["time", "actor", "reader", "external", "metadata", "op"]
		if (!isFields(x) || !this.only(x, ["time"], may) || !whole(x.time)) return
		const h = { time: x.time as number } as ChangeHeader
		if ("actor" in x) h.actor = x.actor
		if ("reader" in x) {
			if (typeof x.reader !== "string") return
			h.reader = x.reader
		}
		if ("external" in x) {
			const sites = this.all(x.external, (e) => this.site(e))
			if (sites === undefined) return
			h.external = sites
		}
		if ("metadata" in x) {
			// a map; the old form, a list of pairs, read as one
			if (isFields(x.metadata)) h.metadata = x.metadata
			else if (Array.isArray(x.metadata) && x.metadata.every(isEntry)) {
				h.metadata = pairs(x.metadata as [string, unknown][])
			} else return
		}
		if ("op" in x) {
			const op = x.op
			if (!isFields(op) || !this.only(op, ["patches", "undo"], ["patches", "undo"])) return
			const patches = this.all(op.patches, (e) => this.patch(e))
			const undo = this.all(op.undo, (e) => this.patch(e))
			if (patches === undefined || undo === undefined) return
			h.op = { patches, undo }
		}
		return h
	}

	// a node as written, new; none when it is not one. cow: false, in what was written before
	// nodes lost it, is dropped
	node(x: unknown): NodeEntry<unknown> | undefined {
		if (!isFields(x) || !this.only(x, ["change"], ["change", "value", "cow"])) return
		if ("cow" in x && x.cow !== false) return
		const h = this.header(x.change)
		if (h === undefined) return
		return createEntry<unknown>(x.value, h)
	}
}

const STRICT = new Reader(false), LOOSE = new Reader(true)
const reader = (r: Reading) => r.loosyGoosy ? LOOSE : STRICT

// writing -------------------------------------------------------------------

// a node's encoding: anything not a value in it, or a change that is not one, is cannot-carry at
// the key given
function bytes(n: NodeEntry<unknown>, o: Options, part?: string, id?: string): Uint8Array {
	const w = written(n, o)
	if (STRICT.header(w.change) === undefined) throw new PackError("cannot-carry", part, id)
	try {
		return cbor.encode(w)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new PackError("cannot-carry", part, id)
		throw e
	}
}

function compare(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
	return a.length - b.length
}

// a key's encoding, its order; a string with a lone surrogate: cannot-carry
function keyed(part: string, id: string): Uint8Array {
	try {
		return cbor.encode([part, id])
	} catch (e) {
		if (e instanceof cbor.CborError) throw new PackError("cannot-carry", part, id)
		throw e
	}
}

// a head: major type, a count
function head(major: number, n: number): Uint8Array {
	const m = major << 5
	return n < 24
		? Uint8Array.of(m | n)
		: n < 0x100
		? Uint8Array.of(m | 24, n)
		: n < 0x10000
		? Uint8Array.of(m | 25, n >> 8, n & 0xff)
		: Uint8Array.of(m | 26, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
}

function cat(xs: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0))
	let at = 0
	for (const x of xs) out.set(x, at), at += x.length
	return out
}

const list = (items: Uint8Array[]) => cat([head(4, items.length), ...items])
const bytesOf = (b: Uint8Array) => cat([head(2, b.length), b])

// whole numbers, 7 bits a byte, the low first, the high bit on all but the last; exact past 2^53
// (a zigzag of a safe integer's difference is under 2^56)
class Varints {
	out: number[] = []
	put(x: number | bigint) {
		if (typeof x === "number" && x < 2 ** 31) {
			while (x >= 128) this.out.push((x & 127) | 128), x >>>= 7
			this.out.push(x)
			return
		}
		let b = BigInt(x)
		while (b >= 128n) this.out.push(Number(b & 127n) | 128), b >>= 7n
		this.out.push(Number(b))
	}
	// a difference, zigzag
	diff(a: number, before: number) {
		const d = BigInt(a) - BigInt(before)
		this.put(d >= 0n ? d * 2n : -d * 2n - 1n)
	}
	bytes() {
		return Uint8Array.from(this.out)
	}
}
function* varints(b: Uint8Array): Generator<bigint> {
	for (let at = 0; at < b.length;) {
		let x = 0n, shift = 0n
		for (;;) {
			if (at >= b.length || shift > 63n) throw new PackError("not-a-pack")
			const byte = b[at++]
			x |= BigInt(byte & 127) << shift
			if (byte < 128) break
			shift += 7n
		}
		yield x
	}
}
const unzig = (z: bigint) => z % 2n === 0n ? z / 2n : -(z + 1n) / 2n

// [it, how many] for each stretch of equal encodings
function runs(items: Uint8Array[]): Uint8Array {
	const out: Uint8Array[] = []
	for (let i = 0; i < items.length;) {
		let j = i + 1
		while (j < items.length && compare(items[j], items[i]) === 0) j++
		out.push(cat([head(4, 2), items[i], cbor.encode(j - i)]))
		i = j
	}
	return list(out)
}

// a map of what is given, its keys in the canonical order
function map(fields: [string, Uint8Array][]): Uint8Array {
	const ks = fields.map(([k, v]) => [cbor.encode(k), v] as const)
	ks.sort((a, b) => compare(a[0], b[0]))
	return cat([head(5, ks.length), ...ks.flatMap(([k, v]) => [k, v])])
}

// an ermine id's text: "ermine:" and the lowercase hex of its bytes; and its bytes
const ERMINE = /^ermine:(?:(?:0010|1e10)[0-9a-f]{32}|ed01[0-9a-f]{64})$/
const isId = (b: Uint8Array) =>
	(b.length === 18 && (b[0] === 0x00 || b[0] === 0x1e) && b[1] === 0x10) ||
	(b.length === 34 && b[0] === 0xed && b[1] === 0x01)
const HAS = { actor: 1, reader: 2, external: 4, metadata: 8, op: 16, value: 32 }

// a value's encoding; one that cannot be carried: cannot-carry at the key given
function carried(x: unknown, part?: string, id?: string): Uint8Array {
	try {
		return cbor.encode(x as cbor.Value)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new PackError("cannot-carry", part, id)
		throw e
	}
}

// the nodes under their keys, as one item; the same key twice with two nodes: already-there; a
// key with a symbol: cannot-carry, that key, the first given; a node that cannot be carried:
// cannot-carry, its first key
export function pack(entries: Iterable<Entry>, options: Options = {}): Uint8Array {
	type Row = { part: string; id: string; node: NodeEntry<unknown>; key: Uint8Array }
	const rows: Row[] = []
	for (const [part, id, node] of entries) {
		if (typeof part !== "string" || typeof id !== "string") {
			throw new PackError("cannot-carry", part, id)
		}
		rows.push({ part, id, node, key: keyed(part, id) })
	}
	rows.sort((a, b) => compare(a.key, b.key))
	const numbers = new Map<NodeEntry<unknown>, number>(), ids = new Map<string, number>()
	const idItems: Uint8Array[] = [], partItems: Uint8Array[] = []
	const which = new Varints(), named = new Varints(), has = new Varints(), time = new Varints()
	const actor: Uint8Array[] = [], reader: Uint8Array[] = [], external: Uint8Array[] = []
	const metadata: Uint8Array[] = [], op: Uint8Array[] = [], values: Uint8Array[] = []
	let last: Row | undefined, before = 0
	for (const r of rows) {
		if (last !== undefined && compare(last.key, r.key) === 0) {
			if (last.node !== r.node) throw new PackError("already-there", r.part, r.id)
			continue
		}
		last = r
		partItems.push(cbor.encode(r.part))
		let i = ids.get(r.id)
		if (i === undefined) {
			ids.set(r.id, i = idItems.length)
			idItems.push(
				ERMINE.test(r.id)
					? bytesOf(Uint8Array.from(r.id.slice(7).match(/../g)!, (h) => parseInt(h, 16)))
					: cbor.encode(r.id),
			)
		}
		which.put(i)
		const n = numbers.get(r.node)
		if (n !== undefined) {
			named.put(n + 1)
			continue
		}
		numbers.set(r.node, numbers.size)
		named.put(0)
		// the node as the first form writes it, checked as it would be
		const w = written(r.node, options)
		if (STRICT.header(w.change) === undefined) throw new PackError("cannot-carry", r.part, r.id)
		const c = w.change as Fields
		let bits = 0
		if ("actor" in c) bits |= HAS.actor, actor.push(carried(c.actor, r.part, r.id))
		if ("reader" in c) bits |= HAS.reader, reader.push(carried(c.reader, r.part, r.id))
		if ("external" in c) bits |= HAS.external, external.push(carried(c.external, r.part, r.id))
		if ("metadata" in c) bits |= HAS.metadata, metadata.push(carried(c.metadata, r.part, r.id))
		if ("op" in c) bits |= HAS.op, op.push(carried(c.op, r.part, r.id))
		if ("value" in w) bits |= HAS.value, values.push(carried(w.value, r.part, r.id))
		has.put(bits)
		time.diff(c.time as number, before)
		before = c.time as number
	}
	const fields: [string, Uint8Array][] = []
	const bytesColumn = (name: string, v: Varints) => {
		if (v.out.length) fields.push([name, bytesOf(v.bytes())])
	}
	if (idItems.length) fields.push(["ids", list(idItems)])
	if (partItems.length) fields.push(["parts", runs(partItems)])
	bytesColumn("which", which), bytesColumn("nodes", named), bytesColumn("has", has)
	bytesColumn("time", time)
	if (actor.length) fields.push(["actor", runs(actor)])
	if (reader.length) fields.push(["reader", runs(reader)])
	if (external.length) fields.push(["external", runs(external)])
	if (metadata.length) fields.push(["metadata", runs(metadata)])
	if (op.length) fields.push(["op", list(op)])
	if (values.length) fields.push(["values", list(values)])
	return cat([head(5, 1), cbor.encode("columns"), bytesOf(deflate(map(fields)))])
}

// one node alone, as a pack writes each node
export function encode(node: NodeEntry<unknown>, options: Options = {}): Uint8Array {
	return bytes(node, options)
}

function decoded(b: Uint8Array, code: Code): unknown {
	try {
		return cbor.decode(b)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new PackError(code)
		throw e
	}
}

// the nodes under their keys, in the keys' order, new nodes made with createEntry: one node for
// each written, under every key that names it. putting them in a table is the caller's
export function unpack(b: Uint8Array, reading: Reading = {}): Entry[] {
	const r = reader(reading)
	const x = decoded(b, "not-a-pack")
	if (isFields(x) && "columns" in x && r.only(x, ["columns"], ["columns"])) {
		return columns(x.columns, r, reading.limit ?? 2 ** 30)
	}
	return first(x, r)
}

const COLUMNS = [
	"ids",
	"parts",
	"which",
	"nodes",
	"has",
	"time",
	"actor",
	"reader",
	"external",
	"metadata",
	"op",
	"values",
]

function columns(z: unknown, r: Reader, limit: number): Entry[] {
	const no = () => new PackError("not-a-pack")
	if (!(z instanceof Uint8Array)) throw no()
	let inner: Uint8Array
	try {
		inner = inflate(z, limit)
	} catch (e) {
		if (e instanceof DeflateError) throw no()
		throw e
	}
	const c = decoded(inner, "not-a-pack")
	if (!isFields(c) || !r.only(c, [], COLUMNS)) throw no()
	const listOf = (k: string): unknown[] => {
		const v = k in c ? c[k] : []
		if (!Array.isArray(v)) throw no()
		return v
	}
	const numbers = (k: string): bigint[] => {
		const v = k in c ? c[k] : new Uint8Array(0)
		if (!(v instanceof Uint8Array)) throw no()
		return [...varints(v)]
	}
	// runs spread out: each [it, how many], how many whole and at least 1
	const spread = (k: string): unknown[] => {
		const out: unknown[] = []
		for (const run of listOf(k)) {
			if (!Array.isArray(run) || run.length !== 2 || !whole(run[1]) || run[1] < 1) throw no()
			if (out.length + (run[1] as number) > 2 ** 32) throw no()
			for (let i = 0; i < (run[1] as number); i++) out.push(run[0])
		}
		return out
	}
	const ids = listOf("ids").map((i) => {
		if (typeof i === "string" && !ERMINE.test(i)) return i
		if (i instanceof Uint8Array && isId(i)) {
			return "ermine:" + Array.from(i, (b) => b.toString(16).padStart(2, "0")).join("")
		}
		throw no()
	})
	const parts = spread("parts"), which = numbers("which"), named = numbers("nodes")
	const k = parts.length
	if (which.length !== k || named.length !== k) throw no()
	// ids in the order the keys first name them, each named
	let seen = 0
	for (const i of which) {
		if (i > BigInt(seen) || i >= BigInt(ids.length)) throw no()
		if (i === BigInt(seen)) seen++
	}
	if (seen !== ids.length) throw no()
	const has = numbers("has"), times = numbers("time")
	const m = has.length
	if (times.length !== m) throw no()
	const fields: Record<string, unknown[]> = {
		actor: spread("actor"),
		reader: spread("reader"),
		external: spread("external"),
		metadata: spread("metadata"),
		op: listOf("op"),
		values: listOf("values"),
	}
	const taken: Record<string, number> = {}
	const take = (name: string) => {
		const at = taken[name] ?? 0
		if (at >= fields[name].length) throw no()
		taken[name] = at + 1
		return fields[name][at]
	}
	const nodes: NodeEntry<unknown>[] = []
	let time = 0n
	for (let i = 0; i < m; i++) {
		const bits = has[i]
		if (bits > 127n) throw no()
		const b = Number(bits)
		time += unzig(times[i])
		const change: Fields = { time: Number(time) }
		if (b & HAS.actor) change.actor = take("actor") as cbor.Value
		if (b & HAS.reader) change.reader = take("reader") as cbor.Value
		if (b & HAS.external) change.external = take("external") as cbor.Value
		if (b & HAS.metadata) change.metadata = take("metadata") as cbor.Value
		if (b & HAS.op) change.op = take("op") as cbor.Value
		const w: Fields = { change }
		if (b & HAS.value) w.value = take("values") as cbor.Value
		const n = r.node(w)
		if (n === undefined) throw no()
		nodes.push(n)
	}
	for (const name of Object.keys(fields)) {
		if ((taken[name] ?? 0) !== fields[name].length) throw no()
	}
	const out: Entry[] = []
	let next = 0, last: Uint8Array | undefined
	for (let i = 0; i < k; i++) {
		const part = parts[i], id = ids[Number(which[i])]
		if (typeof part !== "string") throw no()
		const v = named[i]
		let n: number
		if (v === 0n) n = next++
		else if (v - 1n < BigInt(next)) n = Number(v - 1n)
		else throw no()
		if (n >= nodes.length) throw no()
		// sorted, none twice
		const key = cbor.encode([part, id])
		if (last !== undefined && compare(last, key) >= 0) throw no()
		last = key
		out.push([part, id, nodes[n]])
	}
	// every node under a key
	if (next !== nodes.length) throw no()
	return out
}

// the first form, {keys, nodes}
function first(x: unknown, r: Reader): Entry[] {
	const no = () => new PackError("not-a-pack")
	if (!isFields(x) || !r.only(x, ["keys", "nodes"], ["keys", "nodes"])) throw no()
	if (!Array.isArray(x.keys) || !Array.isArray(x.nodes)) throw no()
	const nodes: NodeEntry<unknown>[] = []
	for (const f of x.nodes) {
		const n = r.node(f)
		if (n === undefined) throw no()
		nodes.push(n)
	}
	const out: Entry[] = []
	let next = 0, last: Uint8Array | undefined
	for (const k of x.keys) {
		if (!Array.isArray(k) || k.length !== 3) throw no()
		const [part, id, n] = k
		if (typeof part !== "string" || typeof id !== "string") throw no()
		// numbered in the order first named
		if (typeof n !== "number" || !Number.isInteger(n)) throw no()
		if (n < 0 || n > next || n >= nodes.length) throw no()
		if (n === next) next++
		// sorted, none twice
		const key = cbor.encode([part, id])
		if (last !== undefined && compare(last, key) >= 0) throw no()
		last = key
		out.push([part, id, nodes[n]])
	}
	// every node under a key
	if (next !== nodes.length) throw no()
	return out
}

// one node back, as encode wrote it
export function decode(b: Uint8Array, reading: Reading = {}): NodeEntry<unknown> {
	const n = reader(reading).node(decoded(b, "not-a-node"))
	if (n === undefined) throw new PackError("not-a-node")
	return n
}
