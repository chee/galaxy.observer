// packer: a pack of sealed commits as columns: it packs consecutive sealed commits for any stack to carry
// (a Subduction fragment is one use). a commit the next in the pack
// goes on alone, by the same signer, is vouched for by that one's signature: its own is left out,
// its stored id goes in ids. unpack gives back each commit's exact bytes, stored id and sealed
// bytes. deterministic: the same commits give the same bytes on any device.
//
// columns:
//   table, actor, reader, external, metadata, signer: runs [value, how many]
//   time, nonce, lamport: first, then differences, zigzag varints in one byte string
//   parents: null when exactly the commit before's name; else refs
//   base: a ref, null when none
//   merge: runs of the rule's name, null when none; only when a commit is a merge by a rule
//   bytes: per commit, null or its exact bytes; only when a commit's bytes are not what its columns
//     encode to (a field a later device made, the commit's decode leaves out). the columns are still
//     written; unpack checks they say the same commit as the bytes
//   patches: a string when one insert (no replaces) continuing the commit before's text; else the
//     patches
//   headers: runs of each signature's varsig header (seal.ts); empty: none read; null: vouched
//   id: runs of the id each signed one is sealed for (seal.ts); null: vouched
//   signatures: each signed one's bytes after its header, in order
//   ids: each vouched one's stored id, in order: only said (a reader that knows the id works it out
//     from the id and the commit's name, seal.ts, and checks it: the subduction stack's door does)
// ref: a place earlier in the pack, else a name. unpack takes any spelling that says the commits;
// only pack's is canonical.
// changing: each commit is named and signed alone; a pack only carries them. a commit field this pack
// doesn't know goes whole in bytes (it packs badly until the columns learn it); a new column is an
// unknown key to an older unpack, so it waits until every device reads it.
//
// refused (PackError code, column), the first that fails:
//   not-a-pack    not CBOR, not a map, or an unknown key
//   count        n not a whole number
//   signatures   not a list of byte strings, one per commit with a header
//   runs         a runs column not [value, how many ≥ 1] summing to n; headers not bytes; an id
//                not a string where there is a header, or not null where there is none
//   differences  not bytes, a number cut short or over 8 bytes, bytes left over, past 2^53 - 1
//   parents      not a list of n; or one not a list of refs, or null for the first
//   patches      not a list of n; or one not a list or a string
//   ref          a place not below the commit's own
//   insert       a string with no insert before it
//   ids          not a list of 32-byte strings, one per commit with no header
//   commit       not a commit (commit.ts)
//   vouched      a headerless commit the next does not go on alone, by its signer
//   size         over the most bytes for this pack
// order: the first five, then per commit: parents, patches, base, commit, vouched, size. commits
// are given one at a time, so a reader can check each signature and stop.
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, decode, encode, name as nameOf, type Patch } from "@ermine/encoding/commit"
import { hex } from "./hex.ts"
import { headerLength, stored } from "./seal.ts"

export type Code =
	| "not-a-pack"
	| "count"
	| "signatures"
	| "runs"
	| "differences"
	| "parents"
	| "patches"
	| "ref"
	| "insert"
	| "ids"
	| "commit"
	| "vouched"
	| "size"

export class PackError extends Error {
	constructor(readonly code: Code, readonly column?: string) {
		super(column === undefined ? code : `${code} (${column})`)
	}
}

const COLUMNS: ReadonlySet<string> = new Set([
	"n",
	"table",
	"actor",
	"reader",
	"external",
	"metadata",
	"signer",
	"time",
	"nonce",
	"lamport",
	"parents",
	"base",
	"merge",
	"bytes",
	"patches",
	"headers",
	"id",
	"signatures",
	"ids",
])
const utf8 = new TextEncoder()
// canonical order: shorter first, then bytewise
function canonical(a: string, b: string): number {
	const x = utf8.encode(a), y = utf8.encode(b)
	if (x.length !== y.length) return x.length - y.length
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
	return 0
}

type Ref = number | Uint8Array

// [value, how many] for each stretch of equal values; equal: the same encoding
function runs(values: unknown[]): [unknown, number][] {
	const out: [unknown, number][] = []
	let was = ""
	for (const v of values) {
		const k = hex(cbor.encode(v as cbor.Value))
		if (out.length && k === was) out[out.length - 1][1]++
		else out.push([v, 1])
		was = k
	}
	return out
}
function unruns(r: unknown, n: number, column: string): unknown[] {
	if (!Array.isArray(r)) throw new PackError("runs", column)
	const out: unknown[] = []
	for (const pair of r) {
		// counted before it is spread: a run's count is no bigger than n
		if (
			!Array.isArray(pair) || pair.length !== 2 || !Number.isSafeInteger(pair[1]) ||
			pair[1] < 1 || out.length + pair[1] > n
		) {
			throw new PackError("runs", column)
		}
		for (let i = 0; i < pair[1]; i++) out.push(pair[0])
	}
	if (out.length !== n) throw new PackError("runs", column)
	return out
}

// whole numbers as the first, then each one's difference from the one before, each zigzag (0, -1,
// 1, -2 … to 0, 1, 2, 3 …) and seven bits a byte, the high bit set on all but the last. a
// difference is at most 2^53 - 1 either way, so its zigzag at most 2^54 - 2: 8 bytes. past 2^52 a
// float would round it (2d + 1), so it is worked out whole
function deltas(xs: number[]): Uint8Array {
	const out: number[] = []
	xs.forEach((x, i) => {
		const d = i === 0 ? x : x - xs[i - 1]
		if (Math.abs(d) < 2 ** 52) {
			let z = d >= 0 ? 2 * d : -2 * d - 1
			while (z >= 128) {
				out.push(z % 128 + 128)
				z = Math.floor(z / 128)
			}
			out.push(z)
			return
		}
		let z = d >= 0 ? 2n * BigInt(d) : -2n * BigInt(d) - 1n
		while (z >= 128n) {
			out.push(Number(z % 128n) + 128)
			z /= 128n
		}
		out.push(Number(z))
	})
	return Uint8Array.from(out)
}
function undeltas(b: unknown, n: number, column: string): number[] {
	if (!(b instanceof Uint8Array)) throw new PackError("differences", column)
	const out: number[] = []
	let at = 0
	for (let i = 0; i < n; i++) {
		// seven bytes as a float, exactly (49 bits); an eighth, whole
		let z = 0, scale = 1, big: bigint | undefined
		for (let k = 0;; k++) {
			if (at >= b.length || k >= 8) throw new PackError("differences", column)
			const byte = b[at++]
			if (k < 7) z += (byte % 128) * scale
			else big = BigInt(z) + BigInt(byte % 128) * 2n ** 49n
			if (byte < 128) break
			scale *= 128
		}
		let d: number
		if (big === undefined) d = z % 2 === 0 ? z / 2 : -(z + 1) / 2
		else {
			const w = big % 2n === 0n ? big / 2n : -(big + 1n) / 2n
			if (w > 2n ** 53n || w < -(2n ** 53n)) throw new PackError("differences", column)
			d = Number(w)
		}
		const x = i === 0 ? d : out[i - 1] + d
		if (!Number.isSafeInteger(x)) throw new PackError("differences", column)
		out.push(x)
	}
	if (at !== b.length) throw new PackError("differences", column)
	return out
}

const points = (s: string) => [...s].length
const samePath = (a: readonly unknown[], b: readonly unknown[]) =>
	a.length === b.length && a.every((x, i) => x === b[i])
const isInsert = (p: Patch | undefined): p is Patch & { range: [number, number]; value: string } =>
	p !== undefined && p.move === undefined && typeof p.value === "string" &&
	p.range !== undefined &&
	p.range[0] === p.range[1]

// the patch a string stands for: one insert going on from before's last, or undefined: none can
function after(before: Commit | undefined): Patch | undefined {
	const last = before?.patches[before.patches.length - 1]
	if (!isInsert(last)) return
	const at = last.range[0] + points(last.value)
	return { path: [...last.path], range: [at, at] }
}

// what a pack is made of: a sealed commit, or a commit vouched for by the next one in the pack (held
// without a seal of its own), its bytes and its stored id
export type Member = Uint8Array | { commit: Uint8Array; stored: Uint8Array }

// what unpack gives for each commit: its bytes, name and stored id; sealed: its sealed bytes, when it
// is signed in the pack (none: vouched for by the next)
export type Unpacked = {
	commit: Uint8Array
	name: Uint8Array
	stored: Uint8Array
	sealed?: Uint8Array
}

const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i])

// the commits, in the pack's order, as columns: one vouched for by the next is written without its
// signature (a member given without a seal must be). an Error: a member that is neither, or one
// that must be signed given without a seal
export function pack(members: readonly Member[]): Uint8Array {
	const commits: Commit[] = [],
		raw: (Uint8Array | null)[] = [],
		names: string[] = [],
		seals: (Uint8Array | undefined)[] = [],
		ids: Uint8Array[] = []
	for (const m of members) {
		let bytes: Uint8Array, id: Uint8Array
		if (m instanceof Uint8Array) {
			const o = cbor.decode(m) as { commit: Uint8Array }
			bytes = o.commit, id = stored(m)
			seals.push(m)
		} else {
			bytes = m.commit, id = m.stored
			seals.push(undefined)
		}
		const c = decode(bytes)
		commits.push(c)
		// bytes that are not what the columns say: kept as they are
		raw.push(same(encode(c), bytes) ? null : bytes)
		names.push(hex(nameOf(bytes)))
		ids.push(id)
	}
	// each one the next goes on alone, by the same signer
	const vouched = commits.map((c, i) => {
		const next = commits[i + 1]
		return next !== undefined && next.parents.length === 1 &&
			hex(next.parents[0]) === names[i] && same(next.signer, c.signer)
	})
	const headers: (Uint8Array | null)[] = [], signatures: Uint8Array[] = [], kept: Uint8Array[] = []
	const docs: (string | null)[] = []
	commits.forEach((_, i) => {
		if (vouched[i]) {
			headers.push(null)
			docs.push(null)
			kept.push(ids[i])
			return
		}
		const s = seals[i]
		if (s === undefined) throw new Error("a commit not vouched for has no seal")
		const o = cbor.decode(s) as { id: string; signature: Uint8Array }
		const h = headerLength(o.signature)
		headers.push(o.signature.slice(0, h))
		docs.push(o.id)
		signatures.push(o.signature.slice(h))
	})
	// each commit's first place; a ref only ever to one before it, as unpack reads them in order
	const place = new Map<string, number>()
	names.forEach((n, i) => place.has(n) || place.set(n, i))
	const ref = (p: Uint8Array, i: number): Ref => {
		const j = place.get(hex(p))
		return j !== undefined && j < i ? j : p
	}
	const columns: Record<string, unknown> = {
		n: commits.length,
		table: runs(commits.map((c) => c.table)),
		actor: runs(commits.map((c) => c.actor)),
		reader: runs(commits.map((c) => c.reader ?? null)),
		external: runs(commits.map((c) => c.external ?? null)),
		metadata: runs(commits.map((c) => c.metadata ?? null)),
		signer: runs(commits.map((c) => c.signer)),
		time: deltas(commits.map((c) => c.time)),
		nonce: deltas(commits.map((c) => c.nonce)),
		lamport: deltas(commits.map((c) => c.lamport)),
		parents: commits.map((c, i) =>
			i > 0 && c.parents.length === 1 && hex(c.parents[0]) === names[i - 1]
				? null
				: c.parents.map((p) => ref(p, i))
		),
		base: runs(commits.map((c, i) => c.base === undefined ? null : ref(c.base, i))),
		patches: commits.map((c, i) => {
			const p = c.patches[0], want = after(commits[i - 1])
			if (
				// a string is the insert alone: one that replaces something goes whole
				c.patches.length === 1 && want !== undefined && isInsert(p) && !("replaces" in p) &&
				samePath(p.path, want.path!) &&
				p.range[0] === want.range![0]
			) return p.value
			return c.patches
		}),
		signatures,
		ids: kept,
	}
	columns.headers = runs(headers)
	columns.id = runs(docs)
	if (commits.some((c) => c.merge !== undefined)) {
		columns.merge = runs(commits.map((c) => c.merge ?? null))
	}
	if (raw.some((b) => b !== null)) columns.bytes = raw
	return cbor.encode(columns as cbor.Value)
}

// the pack's commits back, each its exact bytes, and its seal's when it is signed. PackError: not a pack
export function unpack(bytes: Uint8Array): Unpacked[] {
	return [...each(bytes)]
}

// how many bytes of commits a pack of this many bytes may give: a pack saves about four fifths of
// typing, and a value the same on every commit is written once, so 64 times, and a MiB
export const most = (length: number) => 64 * length + 2 ** 20

// the pack's commits, one at a time, in order. PackError: not a pack, as far as it is read
export function* each(bytes: Uint8Array): Generator<Unpacked, void, undefined> {
	let x: unknown
	try {
		x = cbor.decode(bytes)
	} catch {
		throw new PackError("not-a-pack")
	}
	if (x === null || typeof x !== "object" || Array.isArray(x) || ArrayBuffer.isView(x)) {
		throw new PackError("not-a-pack")
	}
	const o = x as Record<string, unknown>
	const stray = Object.keys(o).filter((k) => !COLUMNS.has(k)).sort(canonical)
	if (stray.length) throw new PackError("not-a-pack", stray[0])
	const n = o.n
	if (!Number.isSafeInteger(n) || (n as number) < 0) throw new PackError("count")
	const count = n as number
	const signatures = o.signatures, ids = o.ids
	if (!Array.isArray(signatures) || !signatures.every((x) => x instanceof Uint8Array)) {
		throw new PackError("signatures")
	}
	if (!Array.isArray(ids) || !ids.every((x) => x instanceof Uint8Array && x.length === 32)) {
		throw new PackError("ids")
	}
	const table = unruns(o.table, count, "table"),
		actor = unruns(o.actor, count, "actor"),
		reader = unruns(o.reader, count, "reader")
	const external = unruns(o.external, count, "external"),
		metadata = unruns(o.metadata, count, "metadata")
	const signer = unruns(o.signer, count, "signer"), base = unruns(o.base, count, "base")
	const merge = "merge" in o ? unruns(o.merge, count, "merge") : undefined
	const headers = unruns(o.headers, count, "headers")
	const exact = o.bytes
	if (
		exact !== undefined &&
		(!Array.isArray(exact) || exact.length !== count ||
			!exact.every((b) => b === null || b instanceof Uint8Array))
	) throw new PackError("runs", "bytes")
	if (!headers.every((h) => h instanceof Uint8Array || h === null)) {
		throw new PackError("runs", "headers")
	}
	const docs = unruns(o.id, count, "id")
	if (!docs.every((x, i) => headers[i] === null ? x === null : typeof x === "string")) {
		throw new PackError("runs", "id")
	}
	const signed = headers.filter((h) => h !== null).length
	if (signatures.length !== signed) throw new PackError("signatures")
	if (ids.length !== count - signed) throw new PackError("ids")
	const time = undeltas(o.time, count, "time"),
		nonce = undeltas(o.nonce, count, "nonce"),
		lamport = undeltas(o.lamport, count, "lamport")
	if (!Array.isArray(o.parents) || o.parents.length !== count) throw new PackError("parents")
	if (!Array.isArray(o.patches) || o.patches.length !== count) throw new PackError("patches")
	const names: Uint8Array[] = [], commits: Commit[] = []
	const room = most(bytes.length)
	let size = 0, sig = 0, id = 0
	// one with no header, until the next shows it vouched for
	let held: Unpacked | undefined
	const deref = (r: unknown, i: number): Uint8Array => {
		if (r instanceof Uint8Array) return r
		if (!Number.isSafeInteger(r) || (r as number) < 0 || (r as number) >= i) {
			throw new PackError("ref")
		}
		return names[r as number]
	}
	for (let i = 0; i < count; i++) {
		const ps = o.parents[i]
		let parents: Uint8Array[]
		if (ps === null && i > 0) parents = [names[i - 1]]
		else if (Array.isArray(ps)) parents = ps.map((r) => deref(r, i))
		else throw new PackError("parents")
		let patches: Patch[]
		const p = o.patches[i]
		if (typeof p === "string") {
			const want = after(commits[i - 1])
			if (want === undefined) throw new PackError("insert")
			patches = [{ ...want, value: p }]
		} else if (Array.isArray(p)) patches = p as Patch[]
		else throw new PackError("patches")
		const c: Commit = {
			table: table[i] as string,
			actor: actor[i],
			time: time[i],
			signer: signer[i] as Uint8Array,
			nonce: nonce[i],
			parents,
			lamport: lamport[i],
			patches,
		}
		if (reader[i] !== null) c.reader = reader[i] as string
		if (external[i] !== null) c.external = external[i] as Commit["external"]
		if (metadata[i] !== null) c.metadata = metadata[i] as Commit["metadata"]
		if (base[i] !== null) c.base = deref(base[i], i)
		if (merge !== undefined && merge[i] !== null) c.merge = merge[i] as string
		let b: Uint8Array
		try {
			b = encode(c)
			const given = exact?.[i] as Uint8Array | null | undefined
			if (given) {
				// the commit as the bytes have it, the columns' and no other
				if (!same(encode(decode(given)), b)) throw new PackError("commit")
				b = given
			}
		} catch (e) {
			if (e instanceof PackError) throw e
			throw new PackError("commit")
		}
		const name = nameOf(b)
		if (held !== undefined) {
			const before = commits[i - 1]
			if (
				parents.length !== 1 || !same(parents[0], held.name) ||
				!same(c.signer, before.signer)
			) throw new PackError("vouched")
			yield held
			held = undefined
		}
		commits.push(c)
		names.push(name)
		size += b.length
		const header = headers[i] as Uint8Array | null
		let out: Unpacked
		if (header === null) out = { commit: b, name, stored: ids[id++] as Uint8Array }
		else {
			const tail = signatures[sig++] as Uint8Array
			const signature = new Uint8Array(header.length + tail.length)
			signature.set(header)
			signature.set(tail, header.length)
			const sealed = cbor.encode({ id: docs[i] as string, commit: b, signature })
			size += sealed.length
			out = { commit: b, name, stored: stored(sealed), sealed }
		}
		if (size > room) throw new PackError("size")
		if (header === null) held = out
		else yield out
	}
	// the last one vouched for by none
	if (held !== undefined) throw new PackError("vouched")
}
