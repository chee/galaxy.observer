// the canonical encoding of values: RFC 8949 core deterministic, typed arrays as RFC 8746. this
// header is the rule (vectors.json in ermine/encoding/conformance/cbor holds its bytes).
// - whole numbers: integers, major type 0 or 1 in the shortest head; past 64 bits a bignum, tag 2
//   or 3 over its bytes, big-endian, no leading zero. -0 is 0. a number or a bigint: the same bytes
// - other numbers: the shortest float that holds them exactly; the one NaN f97e00; the infinities
//   f97c00, f9fc00
// - read back: a number while |n| <= 2^53 - 1, a bigint past that (5n is read back as 5)
// - bytes major type 2, strings 3, lists 4, maps 5; map keys strings, sorted bytewise by encoding
// - typed arrays: tag over little-endian bytes (uint16 69 … float64 86); NaN elements quiet, no
//   payload; -0 elements kept; no uint8 kind (tag 64 never written)
// - stand-ins: tag 0x12345678 over the kind; live values and symbols have no encoding
// - at most DEPTH nested containers
// bytes: any Uint8Array view in, a fresh one out. a stand-in is the class Stand; a function, Map,
// ArrayBuffer (for now) or other class object is live. decoding accepts exactly what encoding
// gives: never a float holding a whole number, an integer in a longer head, or a bignum a plain
// integer holds.

/** A value as this codec holds it. */
export type Value =
	| null
	| boolean
	| number
	| bigint
	| string
	| Uint8Array
	| Typed
	| Stand
	| readonly Value[]
	| { readonly [key: string]: Value }

export type Typed =
	| Int8Array
	| Int16Array
	| Uint16Array
	| Int32Array
	| Uint32Array
	| BigInt64Array
	| BigUint64Array
	| Float32Array
	| Float64Array

/** What a live value is sent as: tag 0x12345678 over its `kind`, any value. */
export class Stand {
	constructor(readonly kind: Value) {}
}

const STAND = 0x12345678

/** What cannot be encoded, or bytes that are not an encoding. */
export class CborError extends Error {
	override name = "CborError"
}

// Each kind: its class, its tag, its element size.
type Kind = { tag: number; size: number; make: new (n: number) => Typed }
const KINDS: Kind[] = [
	{ tag: 69, size: 2, make: Uint16Array },
	{ tag: 70, size: 4, make: Uint32Array },
	{ tag: 71, size: 8, make: BigUint64Array },
	{ tag: 72, size: 1, make: Int8Array },
	{ tag: 77, size: 2, make: Int16Array },
	{ tag: 78, size: 4, make: Int32Array },
	{ tag: 79, size: 8, make: BigInt64Array },
	{ tag: 85, size: 4, make: Float32Array },
	{ tag: 86, size: 8, make: Float64Array },
]
const BY_CLASS = new Map<unknown, Kind>(KINDS.map((k) => [k.make, k]))
const BY_TAG = new Map<number, Kind>(KINDS.map((k) => [k.tag, k]))

const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
const utf8 = new TextEncoder()
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

// encoding -------------------------------------------------------------------

class Out {
	buf = new Uint8Array(256)
	view = new DataView(this.buf.buffer)
	n = 0
	room(k: number) {
		if (this.n + k <= this.buf.length) return
		let size = this.buf.length * 2
		while (size < this.n + k) size *= 2
		const next = new Uint8Array(size)
		next.set(this.buf.subarray(0, this.n))
		this.buf = next
		this.view = new DataView(next.buffer)
	}
	byte(b: number) {
		this.room(1)
		this.buf[this.n++] = b
	}
	bytes(b: Uint8Array) {
		this.room(b.length)
		this.buf.set(b, this.n)
		this.n += b.length
	}
	/** A head: the major type and its argument, in the fewest bytes. */
	head(major: number, arg: number) {
		const m = major << 5
		this.room(9)
		const n = this.n
		if (arg < 24) {
			this.buf[n] = m | arg
			this.n = n + 1
		} else if (arg < 0x100) {
			this.buf[n] = m | 24
			this.buf[n + 1] = arg
			this.n = n + 2
		} else if (arg < 0x10000) {
			this.buf[n] = m | 25
			this.view.setUint16(n + 1, arg)
			this.n = n + 3
		} else if (arg < 0x100000000) {
			this.buf[n] = m | 26
			this.view.setUint32(n + 1, arg)
			this.n = n + 5
		} else {
			this.buf[n] = m | 27
			this.view.setUint32(n + 1, Math.floor(arg / 0x100000000))
			this.view.setUint32(n + 5, arg >>> 0)
			this.n = n + 9
		}
	}
}

const f32 = new DataView(new ArrayBuffer(4))

/** The bits of x as a half float, if a half float holds it exactly. */
function half(x: number): number | undefined {
	if (Math.fround(x) !== x) return
	f32.setFloat32(0, x)
	const bits = f32.getUint32(0)
	const sign = (bits >>> 16) & 0x8000
	const exp = (bits >>> 23) & 0xff
	const mant = bits & 0x7fffff
	if (exp === 0xff) return mant === 0 ? sign | 0x7c00 : undefined // the infinities
	if (exp === 0) return mant === 0 ? sign : undefined // zeros; float32 subnormals are too small
	const e = exp - 127
	if (e > 15) return
	if (e >= -14) return (mant & 0x1fff) === 0 ? sign | ((e + 15) << 10) | (mant >>> 13) : undefined
	if (e < -24) return
	const sig = 0x800000 | mant, shift = -(e + 1) // a subnormal: sig * 2^(e+1) units of 2^-24
	return (sig & ((1 << shift) - 1)) === 0 ? sign | (sig >>> shift) : undefined
}

const TWO64 = 2 ** 64, EXACT = 2n ** 53n

/** A bigint's magnitude as bytes, big-endian, no leading zero. */
function magnitude(m: bigint): Uint8Array {
	let h = m.toString(16)
	if (h.length & 1) h = "0" + h
	const b = new Uint8Array(h.length / 2)
	for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16)
	return b
}

/** A whole number past what a double's head math holds exactly, as a bigint. */
function integer(out: Out, x: bigint) {
	const negative = x < 0n, m = negative ? -1n - x : x
	if (m < 0x10000000000000000n) {
		out.room(9)
		out.buf[out.n] = (negative ? 0x20 : 0) | 27
		out.view.setBigUint64(out.n + 1, m)
		out.n += 9
		return
	}
	const b = magnitude(m)
	out.byte(negative ? 0xc3 : 0xc2)
	out.head(2, b.length)
	out.bytes(b)
}

function number(out: Out, x: number) {
	if (Number.isInteger(x)) {
		// -0 is 0; a negative's argument -1 - x is exact up to 2^53, a bigint's past it
		if (x >= 0 && x < TWO64) return out.head(0, x === 0 ? 0 : x)
		if (x < 0 && x >= -(2 ** 53)) return out.head(1, -1 - x)
		return integer(out, BigInt(x))
	}
	out.room(9)
	const n = out.n
	if (x !== x) {
		out.buf[n] = 0xf9
		out.buf[n + 1] = 0x7e
		out.buf[n + 2] = 0
		out.n = n + 3
		return
	}
	const h = half(x)
	if (h !== undefined) {
		out.buf[n] = 0xf9
		out.view.setUint16(n + 1, h)
		out.n = n + 3
	} else if (Math.fround(x) === x) {
		out.buf[n] = 0xfa
		out.view.setFloat32(n + 1, x)
		out.n = n + 5
	} else {
		out.buf[n] = 0xfb
		out.view.setFloat64(n + 1, x)
		out.n = n + 9
	}
}

function hasNaN(t: Typed, kind: Kind): boolean {
	if (kind.tag !== 85 && kind.tag !== 86) return false
	const f = t as Float32Array | Float64Array
	for (let i = 0; i < f.length; i++) if (f[i] !== f[i]) return true
	return false
}

/** A typed array's elements, little-endian, each NaN the quiet NaN with no payload. */
function elements(t: Typed, kind: Kind): Uint8Array {
	const raw = new Uint8Array(t.buffer, t.byteOffset, t.byteLength)
	const b = new Uint8Array(t.byteLength)
	if (LITTLE || kind.size === 1) b.set(raw)
	else {
		for (let i = 0; i < raw.length; i += kind.size) {
			for (let j = 0; j < kind.size; j++) b[i + j] = raw[i + kind.size - 1 - j]
		}
	}
	if (kind.tag === 85 || kind.tag === 86) {
		const v = new DataView(b.buffer)
		for (let i = 0; i < t.length; i++) {
			if (!Number.isNaN(t[i] as number)) continue
			if (kind.size === 4) v.setUint32(i * 4, 0x7fc00000, true)
			else v.setBigUint64(i * 8, 0x7ff8000000000000n, true)
		}
	}
	return b
}

const size = (arg: number) =>
	arg < 24 ? 1 : arg < 0x100 ? 2 : arg < 0x10000 ? 3 : arg < 0x100000000 ? 5 : 9

/** A string as text, its UTF-8 written in place; a string with a lone surrogate has none. */
function text(out: Out, s: string) {
	const length = s.length
	if (length < 24) {
		// short and ASCII: byte by byte
		out.room(1 + length)
		const buf = out.buf, n = out.n
		let i = 0
		for (; i < length; i++) {
			const c = s.charCodeAt(i)
			if (c >= 0x80) break
			buf[n + 1 + i] = c
		}
		if (i === length) {
			buf[n] = 0x60 | length
			out.n = n + 1 + length
			return
		}
	}
	if (!s.isWellFormed()) throw new CborError("a string with a lone surrogate has no encoding")
	const most = length * 3, guess = size(most)
	// room for the head too: growing copies only what is written
	out.room(9 + most)
	const n = out.n
	const written = utf8.encodeInto(s, out.buf.subarray(n + guess)).written
	const real = size(written)
	if (real !== guess) out.buf.copyWithin(n + real, n + guess, n + guess + written)
	out.head(3, written)
	out.n = n + real + written
}

// keys' encodings, made once: keys repeat
const keys = new Map<string, Uint8Array>()
function key(k: string): Uint8Array {
	let b = keys.get(k)
	if (b === undefined) {
		const o = new Out()
		text(o, k)
		b = o.buf.slice(0, o.n)
		if (keys.size > 4096) keys.clear()
		keys.set(k, b)
	}
	return b
}

function compare(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length)
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
	return a.length - b.length
}

// containers deeper than this are tracked: a value holding itself is found within one turn of it
const SHALLOW = 64

/** How many containers a value nests at most, one inside the next (cbor.h's CBOR_DEPTH). */
export const DEPTH = 1024
const tooDeep = `nested deeper than ${DEPTH}`

function value(out: Out, x: unknown, open: Set<object>, depth: number) {
	if (typeof x === "number") return number(out, x)
	if (typeof x === "string") return text(out, x)
	if (typeof x === "bigint") {
		return x >= -EXACT && x <= EXACT ? number(out, Number(x)) : integer(out, x)
	}
	if (x === null) return out.byte(0xf6)
	if (x === false) return out.byte(0xf4)
	if (x === true) return out.byte(0xf5)
	if (typeof x !== "object") throw new CborError(`a ${typeof x} is not a value`)
	if (x instanceof Uint8Array) {
		out.head(2, x.length)
		return out.bytes(x)
	}
	if (x instanceof Stand) {
		if (depth >= DEPTH) throw new CborError(`a value ${tooDeep} has no encoding`)
		out.head(6, STAND)
		return value(out, x.kind, open, depth + 1)
	}
	if (ArrayBuffer.isView(x)) {
		const kind = BY_CLASS.get(x.constructor)
		if (!kind) throw new CborError(`a ${x.constructor.name} is not a value`)
		const t = x as Typed
		out.head(6, kind.tag)
		out.head(2, t.byteLength)
		// little-endian and no NaN: its bytes as they are
		if ((LITTLE || kind.size === 1) && !hasNaN(t, kind)) {
			return out.bytes(new Uint8Array(t.buffer, t.byteOffset, t.byteLength))
		}
		return out.bytes(elements(t, kind))
	}
	if (depth >= DEPTH) throw new CborError(`a value ${tooDeep} has no encoding`)
	const deep = depth > SHALLOW
	if (deep) {
		if (open.has(x)) throw new CborError("a value cannot hold itself")
		open.add(x)
	}
	if (Array.isArray(x)) {
		out.head(4, x.length)
		for (let i = 0; i < x.length; i++) value(out, x[i], open, depth + 1)
	} else {
		const proto = Object.getPrototypeOf(x)
		if (proto !== Object.prototype && proto !== null) {
			throw new CborError("a live value has no encoding")
		}
		if (Object.getOwnPropertySymbols(x).length) {
			throw new CborError("a symbol key has no encoding")
		}
		let ks = Object.keys(x), bs = ks.map(key)
		if (ks.length <= 16) {
			// insertion sort: most maps are small
			for (let i = 1; i < ks.length; i++) {
				const k = ks[i], b = bs[i]
				let j = i - 1
				for (; j >= 0 && compare(bs[j], b) > 0; j--) ks[j + 1] = ks[j], bs[j + 1] = bs[j]
				ks[j + 1] = k, bs[j + 1] = b
			}
		} else {
			// a big one (a folder of 30k names): n log n, not n²
			const order = ks.map((_, i) => i).sort((a, b) => compare(bs[a], bs[b]))
			ks = order.map((i) => ks[i]), bs = order.map((i) => bs[i])
		}
		out.head(5, ks.length)
		for (let i = 0; i < ks.length; i++) {
			out.bytes(bs[i])
			value(out, (x as { [k: string]: unknown })[ks[i]], open, depth + 1)
		}
	}
	if (deep) open.delete(x)
}

/** The deterministic CBOR of a value. A live value, a symbol, or anything not a value, throws. */
export function encode(x: Value): Uint8Array {
	const out = new Out()
	value(out, x, new Set(), 0)
	return out.buf.slice(0, out.n)
}

// decoding -------------------------------------------------------------------

const SAFE = 2n ** 53n - 1n
const wrong = (why: string) => new CborError(`not an encoding of a value: ${why}`)

function halfValue(h: number): number {
	const sign = h & 0x8000 ? -1 : 1
	const exp = (h >> 10) & 0x1f, mant = h & 0x3ff
	if (exp === 0) return sign * mant * 2 ** -24
	if (exp === 0x1f) return mant === 0 ? sign * Infinity : NaN
	return sign * (1024 + mant) * 2 ** (exp - 25)
}

class In {
	view: DataView
	at = 0
	constructor(readonly b: Uint8Array) {
		this.view = new DataView(b.buffer, b.byteOffset, b.byteLength)
	}
	need(k: number) {
		if (this.at + k > this.b.length) throw wrong("it ends early")
	}
	/** A head's argument, which must be in the fewest bytes. */
	arg(info: number): number {
		if (info < 24) return info
		let n: number
		if (info === 24) {
			this.need(1)
			n = this.b[this.at]
			this.at += 1
			if (n < 24) throw wrong("a head is longer than it needs to be")
		} else if (info === 25) {
			this.need(2)
			n = this.view.getUint16(this.at)
			this.at += 2
			if (n < 0x100) throw wrong("a head is longer than it needs to be")
		} else if (info === 26) {
			this.need(4)
			n = this.view.getUint32(this.at)
			this.at += 4
			if (n < 0x10000) throw wrong("a head is longer than it needs to be")
		} else if (info === 27) {
			this.need(8)
			const big = this.view.getBigUint64(this.at)
			this.at += 8
			if (big < 0x100000000n) throw wrong("a head is longer than it needs to be")
			if (big > BigInt(this.b.length)) throw wrong("a length is longer than the input")
			n = Number(big)
		} else throw wrong(info === 31 ? "an indefinite length" : "a reserved head")
		return n
	}
	take(k: number): Uint8Array {
		this.need(k)
		const s = this.b.subarray(this.at, this.at + k)
		this.at += k
		return s
	}
}

// a text: short and ASCII byte by byte, else strict UTF-8
function string(input: In, n: number): string {
	const at = input.at
	input.need(n)
	const b = input.b
	if (n <= 32) {
		let s = ""
		let i = 0
		for (; i < n; i++) {
			const c = b[at + i]
			if (c >= 0x80) break
			s += String.fromCharCode(c)
		}
		if (i === n) {
			input.at = at + n
			return s
		}
	}
	try {
		const s = strict.decode(b.subarray(at, at + n))
		input.at = at + n
		return s
	} catch {
		throw wrong("a string that is not UTF-8")
	}
}

// depth: how many containers hold what is read
function read(input: In, depth: number): Value {
	input.need(1)
	const start = input.at
	const ib = input.b[input.at++]
	const major = ib >> 5, info = ib & 0x1f
	switch (major) {
		case 0:
		case 1: {
			// a number while it is safe, a bigint past that
			if (info < 27) {
				const n = input.arg(info)
				return major === 0 ? n : -1 - n
			}
			if (info > 27) throw wrong(info === 31 ? "an indefinite length" : "a reserved head")
			input.need(8)
			const m = input.view.getBigUint64(input.at)
			input.at += 8
			if (m < 0x100000000n) throw wrong("a head is longer than it needs to be")
			const n = major === 0 ? m : -1n - m
			return n >= -SAFE && n <= SAFE ? Number(n) : n
		}
		case 2:
			return input.take(input.arg(info)).slice()
		case 3:
			return string(input, input.arg(info))
		case 4: {
			if (depth >= DEPTH) throw wrong(tooDeep)
			const n = input.arg(info)
			if (n > input.b.length - input.at) throw wrong("a list is longer than the input")
			const list: Value[] = []
			for (let i = 0; i < n; i++) list.push(read(input, depth + 1))
			return list
		}
		case 5: {
			if (depth >= DEPTH) throw wrong(tooDeep)
			const n = input.arg(info)
			if (n > input.b.length - input.at) throw wrong("a map is longer than the input")
			const map: { [k: string]: Value } = {}
			const b = input.b
			let from = -1, to = -1
			for (let i = 0; i < n; i++) {
				const at = input.at
				if (at < b.length && b[at] >> 5 !== 3) throw wrong("a map key that is not a string")
				const key = read(input, depth + 1) as string
				// after the last key, bytewise
				if (from >= 0) {
					const end = input.at, k = Math.min(to - from, end - at)
					let c = 0
					for (let j = 0; j < k && c === 0; j++) c = b[from + j] - b[at + j]
					if (c > 0 || (c === 0 && to - from >= end - at)) {
						throw wrong("map keys out of order or repeated")
					}
				}
				from = at, to = input.at
				const v = read(input, depth + 1)
				if (key === "__proto__") {
					Object.defineProperty(map, key, {
						value: v,
						enumerable: true,
						writable: true,
						configurable: true,
					})
				} else map[key] = v
			}
			return map
		}
		case 6: {
			const tag = input.arg(info)
			if (tag === 2 || tag === 3) {
				input.need(1)
				const bb = input.b[input.at++]
				if (bb >> 5 !== 2) throw wrong("a bignum's tag over something not bytes")
				const raw = input.take(input.arg(bb & 0x1f))
				if (raw.length <= 8) throw wrong("a bignum a plain integer holds")
				if (raw[0] === 0) throw wrong("a bignum with a leading zero")
				let h = ""
				for (let i = 0; i < raw.length; i++) h += raw[i].toString(16).padStart(2, "0")
				const m = BigInt("0x" + h)
				return tag === 2 ? m : -1n - m
			}
			if (tag === STAND) {
				if (depth >= DEPTH) throw wrong(tooDeep)
				return new Stand(read(input, depth + 1))
			}
			const kind = BY_TAG.get(tag)
			if (!kind) throw wrong("a tag that is not a typed array's")
			input.need(1)
			const bb = input.b[input.at++]
			if (bb >> 5 !== 2) throw wrong("a typed array's tag over something not bytes")
			const raw = input.take(input.arg(bb & 0x1f))
			if (raw.length % kind.size !== 0) {
				throw wrong("a typed array's bytes are not whole elements")
			}
			const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
			if (kind.tag === 85) {
				for (let i = 0; i < raw.length; i += 4) {
					const u = view.getUint32(i, true)
					if ((u & 0x7f800000) === 0x7f800000 && (u & 0x7fffff) !== 0 && u !== 0x7fc00000) {
						throw wrong("a NaN element that is not the one NaN")
					}
				}
			} else if (kind.tag === 86) {
				for (let i = 0; i < raw.length; i += 8) {
					const u = view.getBigUint64(i, true)
					if (
						(u & 0x7ff0000000000000n) === 0x7ff0000000000000n &&
						(u & 0xfffffffffffffn) !== 0n && u !== 0x7ff8000000000000n
					) throw wrong("a NaN element that is not the one NaN")
				}
			}
			const t = new kind.make(raw.length / kind.size)
			const out = new Uint8Array(t.buffer)
			if (LITTLE || kind.size === 1) out.set(raw)
			else {
				for (let i = 0; i < raw.length; i += kind.size) {
					for (let j = 0; j < kind.size; j++) out[i + j] = raw[i + kind.size - 1 - j]
				}
			}
			return t
		}
		default: {
			if (ib === 0xf4) return false
			if (ib === 0xf5) return true
			if (ib === 0xf6) return null
			let x: number
			if (ib === 0xf9) {
				x = halfValue(input.view.getUint16((input.need(2), input.at)))
				input.at += 2
			} else if (ib === 0xfa) {
				input.need(4)
				x = input.view.getFloat32(input.at)
				input.at += 4
			} else if (ib === 0xfb) {
				input.need(8)
				x = input.view.getFloat64(input.at)
				input.at += 8
			} else throw wrong("a simple value that is not false, true or null")
			// in its shortest float: the one NaN is f97e00; a half is a half
			if (ib === 0xf9) {
				if (x !== x && input.view.getUint16(start + 1) !== 0x7e00) {
					throw wrong("a number not in its shortest float")
				}
			} else if (x !== x || half(x) !== undefined || (ib === 0xfb && Math.fround(x) === x)) {
				throw wrong("a number not in its shortest float")
			}
			if (Number.isInteger(x)) throw wrong("a whole number written as a float")
			return x
		}
	}
}

/** The value a deterministic encoding encodes; anything else throws. */
export function decode(bytes: Uint8Array | ArrayBuffer): Value {
	const input = new In(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes)
	const x = read(input, 0)
	if (input.at !== input.b.length) throw wrong("bytes after the value")
	return x
}
