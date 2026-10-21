// ermine ids: a node's id that syncs, as bytes, and its text (c/ids.h the same in C).
//   fresh    00 10 + 16 random bytes (18)
//   hashed   1e 10 + the first 16 bytes of BLAKE3(domain, inputs) (18)
//   key      ed 01 + an Ed25519 key's 32 bytes (34): read, never made
// the first two bytes (multiformats codes) say what format the rest is, never what the node is for.
// anything else (another code, another length) is not an ermine id.
// text: "ermine:" + the bytes in lowercase hex; nothing else is (no upper case, no "//").
// the tree id Subduction files a node under is the Subduction stack's own (treeOf), made from the id's
// text, not here.
// an id given to kind and bytes: its bytes or its text
import { blake3 } from "@ermine/blake3"

export type Id = Uint8Array
export type Kind = "fresh" | "hashed" | "key"

// the domains of hashed's ids, one per maker below
export const domains = {
	child: "ermine/v1/id/child",
	outside: "ermine/v1/id/outside",
} as const

const encoder = new TextEncoder()
// a string's UTF-8; a string with a lone surrogate has none (TextEncoder would make it U+FFFD,
// and two strings one id)
function utf8(s: string): Uint8Array {
	if (!s.isWellFormed()) throw new TypeError("not well-formed UTF-16: a lone surrogate")
	return encoder.encode(s)
}

// a length as an unsigned varint
function varint(n: number): number[] {
	const out = []
	do out.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0)), n = Math.floor(n / 0x80)
	while (n > 0)
	return out
}

// BLAKE3 of the domain, then the inputs, each a piece: its length (an unsigned varint), then its
// bytes, so no two lists of pieces join alike
function digest(domain: string, inputs: (Uint8Array | string)[]): Uint8Array {
	const parts = [utf8(domain), ...inputs.map((x) => typeof x === "string" ? utf8(x) : x)]
	const all: number[] = []
	for (const p of parts) all.push(...varint(p.length), ...p)
	return blake3(Uint8Array.from(all))
}

export function fresh(): Id {
	const id = new Uint8Array(18)
	id[1] = 0x10
	crypto.getRandomValues(id.subarray(2))
	return id
}

// strings as their UTF-8
export function hashed(domain: string, ...inputs: (Uint8Array | string)[]): Id {
	const id = new Uint8Array(18)
	id[0] = 0x1e, id[1] = 0x10
	id.set(digest(domain, inputs).subarray(0, 16), 2)
	return id
}

// a child's id: its parent's bytes (they say their own length), then its name
export function child(parent: Id | string, name: string): Id {
	const p = bytes(parent)
	if (p === undefined) throw new TypeError("child: the parent is not an ermine id")
	return hashed(domains.child, p, name)
}
// an outside id's (automerge's): its bytes, or a string's UTF-8
export const outside = (id: Uint8Array | string): Id => hashed(domains.outside, id)

export function kind(id: Id | string): Kind | undefined {
	const b = typeof id === "string" ? parse(id) : id
	if (b === undefined) return
	if (b.length === 18 && b[0] === 0x00 && b[1] === 0x10) return "fresh"
	if (b.length === 18 && b[0] === 0x1e && b[1] === 0x10) return "hashed"
	if (b.length === 34 && b[0] === 0xed && b[1] === 0x01) return "key"
}

// the id's bytes: bytes as given (shared), text parsed; undefined when not an ermine id
export function bytes(id: Id | string): Id | undefined {
	if (typeof id === "string") return parse(id)
	return kind(id) === undefined ? undefined : id
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))

export function text(id: Id): string | undefined {
	if (kind(id) === undefined) return
	let s = "ermine:"
	for (const b of id) s += HEX[b]
	return s
}

const DIGIT = /^[0-9a-f]*$/
export function parse(text: string): Id | undefined {
	if (!text.startsWith("ermine:")) return
	const h = text.slice(7)
	if ((h.length !== 36 && h.length !== 68) || !DIGIT.test(h)) return
	const b = new Uint8Array(h.length / 2)
	for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16)
	return kind(b) === undefined ? undefined : b
}
