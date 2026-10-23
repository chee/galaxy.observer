// one entry change, as one item in the canonical encoding (cbor.ts), and back: what sync stores
// and sends for a node (extensions/subduction/plan.org, Rewrite for the new shape). the shape only:
// no hashing but its name, no signing, no parents looked up. replaces blop: the table is named (no
// object per name), there is no node id (a commit is kept in its node's sedimentree), and the
// change header goes as the graph has it (time, actor, reader, external, metadata; never op)
import { blake3 } from "@ermine/blake3"
import * as cbor from "@ermine/encoding/cbor"
import type { FileLocation } from "@ermine/util/stacktrace"
import type { Metadata } from "@ermine/node/entry"

export type Key = string | number
export type Place = { path: readonly Key[]; range?: readonly [number, number] }
// replaces: the names of the writes at or under its path its writer held and means to replace,
// ascending (as parents). absent: ancestry decides (an older commit's); empty: none
export type Patch = Place & { value?: unknown; move?: Place; replaces?: Uint8Array[] }

// an optional field absent, or undefined, is left out; null is a value
export type Commit = {
	// the table the change is to
	table: string
	actor: unknown
	reader?: string
	external?: FileLocation[]
	// a map, any keys (canonical: sorted); decoded from the old form too, a list of [key, value]
	// pairs: an object, of a key repeated the first
	metadata?: Metadata
	// whole seconds since 1970, as the change header has it
	time: number
	// the device's key, a multikey: the unsigned varint of its multicodec code, then the raw key
	// (Ed25519: 0xed 0x01, then 32 bytes). its did:key is "did:key:z" and its base58btc
	signer: Uint8Array
	// a count, the signer's own: two commits otherwise the same are told apart. counted up one a
	// commit, so a run of them packs to almost nothing (packer.ts)
	nonce: number
	// the node's heads it was made on, by name (a multihash, below), ascending
	parents: Uint8Array[]
	// with several parents: the one its patches are over (a merge says what it keeps in them). none
	// needed when every patch is a key patch (keyPatch)
	base?: Uint8Array
	// with several parents and no base: a merge rule's name. its patches are over the merge of its
	// parents by that rule; a device that doesn't know the rule can't read it
	merge?: string
	lamport: number
	patches: Patch[]
}

export type Code = "cannot-carry" | "not-a-commit"

export class CommitError extends Error {
	constructor(readonly code: Code, readonly field?: string) {
		super(field === undefined ? code : `${code} (${field})`)
	}
}

// the table's order: the first field that says no is the one named
const FIELDS = [
	"table",
	"actor",
	"reader",
	"external",
	"metadata",
	"time",
	"signer",
	"nonce",
	"parents",
	"base",
	"merge",
	"lamport",
	"patches",
] as const
const KNOWN: ReadonlySet<string> = new Set(FIELDS)
const OPTIONAL: ReadonlySet<string> = new Set(["reader", "external", "metadata", "base", "merge"])

type Fields = { [k: string]: unknown }

const utf8 = new TextEncoder()
function canonical(a: string, b: string): number {
	const x = utf8.encode(a), y = utf8.encode(b)
	if (x.length !== y.length) return x.length - y.length
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]
	return 0
}

const isFields = (x: unknown): x is Fields => {
	if (x === null || typeof x !== "object" || Array.isArray(x)) return false
	const p = Object.getPrototypeOf(x)
	return p === Object.prototype || p === null
}
// an integer from 0 to 2^53 - 1
const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0
// a list's index, a site's line or column: an integer from 0 to 2^31 - 1, what any C long holds
const small = (n: unknown): n is number => whole(n) && n < 2 ** 31
const isKey = (k: unknown) => typeof k === "string" || small(k)
const isRange = (r: unknown) => Array.isArray(r) && r.length === 2 && r.every(whole)
// a multikey is a varint code (shortest form, 1 to 7 bytes) then a key of 1 byte or more, MULTIKEY_MAX
// bytes in all. only its code says what a key is; whether it is one is for whoever verifies
const MULTIKEY_MAX = 1024
const multikey = (b: unknown): b is Uint8Array => {
	if (!(b instanceof Uint8Array) || b.length > MULTIKEY_MAX) return false
	let i = 0
	while (i < b.length && i < 7 && b[i] & 0x80) i++
	if (i >= b.length || i >= 7 || i > 0 && b[i] === 0) return false
	return i + 1 < b.length
}
// a key's code and the raw key, from a multikey; none for one that is not
export function splitKey(b: Uint8Array): { code: number; key: Uint8Array } | undefined {
	if (!multikey(b)) return undefined
	let code = 0, i = 0
	for (; b[i] & 0x80; i++) code += (b[i] & 0x7f) * 2 ** (7 * i)
	code += b[i] * 2 ** (7 * i)
	return { code, key: b.subarray(i + 1) }
}
// a multikey, from the code and the raw key
export function joinKey(code: number, key: Uint8Array): Uint8Array {
	const head: number[] = []
	for (; code >= 0x80; code = Math.floor(code / 0x80)) head.push(code % 0x80 | 0x80)
	head.push(code)
	const out = new Uint8Array(head.length + key.length)
	out.set(head)
	out.set(key, head.length)
	return out
}

// a name is a multihash: the varint of the hash's multicodec code, the varint of its digest's length,
// then the digest. the hashes known: code to digest length (BLAKE3 0x1e, 32 bytes); a name of any
// other code, or whose length is not its code's, is no name. each varint in its shortest form
const HASHES: ReadonlyMap<number, number> = new Map([[0x1e, 32]])
const BLAKE3 = 0x1e
// a name's code and digest, from a name; none for one that is not
export function splitName(b: unknown): { code: number; digest: Uint8Array } | undefined {
	if (!(b instanceof Uint8Array)) return undefined
	const read = (at: number): [number, number] | undefined => {
		let n = 0
		for (let k = 0; k < 7 && at + k < b.length; k++) {
			const byte = b[at + k]
			n += (byte & 0x7f) * 2 ** (7 * k)
			if (byte < 0x80) return k > 0 && byte === 0 ? undefined : [n, at + k + 1]
		}
	}
	const code = read(0)
	if (code === undefined || !HASHES.has(code[0])) return undefined
	const length = read(code[1])
	if (length === undefined || length[0] !== HASHES.get(code[0])) return undefined
	return b.length === length[1] + length[0]
		? { code: code[0], digest: b.subarray(length[1]) }
		: undefined
}
// a name, from the hash's code and the digest
export function joinName(code: number, digest: Uint8Array): Uint8Array {
	const out = new Uint8Array(2 + digest.length)
	out[0] = code, out[1] = digest.length
	out.set(digest, 2)
	return out
}
const isName = (b: unknown): b is Uint8Array => splitName(b) !== undefined

export function compare(a: Uint8Array, b: Uint8Array): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
	return a.length - b.length
}

// names, ascending and each once: parents, replaces
function names(v: unknown): boolean {
	if (!Array.isArray(v) || !v.every(isName)) return false
	for (let i = 1; i < v.length; i++) if (compare(v[i - 1], v[i]) >= 0) return false
	return true
}

function place(x: unknown, keys: ReadonlySet<string>): boolean {
	if (!isFields(x)) return false
	for (const k of Object.keys(x)) if (!keys.has(k)) return false
	if (!Array.isArray(x.path) || !x.path.every(isKey)) return false
	return !("range" in x) || isRange(x.range)
}
const PATCH: ReadonlySet<string> = new Set(["path", "range", "value", "move", "replaces"])
const MOVE: ReadonlySet<string> = new Set(["path", "range"])
// a key patch: a set or a delete at a path of keys, no range, move or list index
const keyPatch = (p: unknown) =>
	isFields(p) && !("range" in p) && !("move" in p) && Array.isArray(p.path) &&
	p.path.every((k) => typeof k === "string")

function site(x: unknown): boolean {
	if (!isFields(x) || typeof x.file !== "string" || !small(x.line)) return false
	for (const k of Object.keys(x)) {
		if (k !== "file" && k !== "line" && k !== "column" && k !== "function") return false
	}
	if ("column" in x && !small(x.column)) return false
	return !("function" in x) || typeof x.function === "string"
}

// each field's own rule, given the commit for base's
const RULES: { [k in typeof FIELDS[number]]: (v: unknown, c: Fields) => boolean } = {
	table: (v) => typeof v === "string" && v.length > 0,
	actor: () => true,
	reader: (v) => typeof v === "string",
	external: (v) => Array.isArray(v) && v.every(site),
	metadata: isFields,
	time: whole,
	signer: multikey,
	nonce: whole,
	parents: (v) => names(v),
	base: (v, c) =>
		isName(v) && Array.isArray(c.parents) && c.parents.length >= 2 &&
		c.parents.some((p) => p instanceof Uint8Array && compare(p, v) === 0),
	// a rule's name, with several parents and no base
	merge: (v, c) =>
		typeof v === "string" && v.length > 0 && Array.isArray(c.parents) &&
		c.parents.length >= 2 && !("base" in c),
	lamport: (v) => whole(v) && v >= 1,
	patches: (v) =>
		Array.isArray(v) &&
		v.every((p) =>
			place(p, PATCH) && (!("move" in p) || !("value" in p) && place(p.move, MOVE)) &&
			(!("replaces" in p) || names(p.replaces))
		),
}

// a key not listed (when strict: encode), then the first field that says no, in the table's order;
// none: a commit. decode is not strict: a field this device does not know is left out of what it
// gives, a later device's, and its signature and name are over the bytes, which are kept as they are
function check(c: Fields, strict: boolean): string | undefined {
	// of several keys not listed, the first in canonical order: shorter first, then bytewise
	const stray = Object.keys(c).filter((k) => !KNOWN.has(k)).sort(canonical)
	if (strict && stray.length > 0) return stray[0]
	for (const k of FIELDS) {
		if (!(k in c)) {
			// base: with several parents, no merge and a patch not a key patch
			const needed = !OPTIONAL.has(k) ||
				k === "base" && Array.isArray(c.parents) && c.parents.length >= 2 && !("merge" in c) &&
					!(Array.isArray(c.patches) && c.patches.every(keyPatch))
			if (needed) return k
		} else if (!RULES[k](c[k], c)) return k
	}
}

// the commit's bytes
export function encode(commit: Commit): Uint8Array {
	if (!isFields(commit)) throw new CommitError("not-a-commit")
	// a field with nothing is left out
	const c: Fields = {}
	for (const [k, v] of Object.entries(commit)) if (v !== undefined) c[k] = v
	const field = check(c, true)
	if (field !== undefined) throw new CommitError("not-a-commit", field)
	try {
		return cbor.encode(c as cbor.Value)
	} catch (e) {
		if (!(e instanceof cbor.CborError)) throw e
		// which: each again, only when one failed
		for (const k of FIELDS) {
			if (!(k in c)) continue
			try {
				cbor.encode(c[k] as cbor.Value)
			} catch {
				throw new CommitError("cannot-carry", k)
			}
		}
		throw new CommitError("cannot-carry")
	}
}

// metadata in the old form, a list of [key, value] pairs, as an object: of a key repeated, the
// first. anything else as it is, for check to refuse
function pairs(list: unknown[]): unknown {
	if (!list.every((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string")) {
		return list
	}
	const out: Fields = {}
	for (const [k, v] of list as [string, unknown][]) {
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

// the commit back, a field not known left out (never encode it again to hash, check or send: keep
// its bytes), its byte fields Uint8Arrays: new objects every time, shared with nothing
export function decode(b: Uint8Array): Commit {
	let x: unknown
	try {
		x = cbor.decode(b)
	} catch (e) {
		if (e instanceof cbor.CborError) throw new CommitError("not-a-commit")
		throw e
	}
	if (!isFields(x)) throw new CommitError("not-a-commit")
	if (Array.isArray(x.metadata)) x.metadata = pairs(x.metadata)
	const field = check(x, false)
	if (field !== undefined) throw new CommitError("not-a-commit", field)
	for (const k of Object.keys(x)) if (!KNOWN.has(k)) delete x[k]
	return x as Commit
}

// the commit's name on every device: the BLAKE3 hash of its bytes, as a multihash (34 bytes)
export function name(b: Uint8Array): Uint8Array {
	return joinName(BLAKE3, blake3(b))
}
