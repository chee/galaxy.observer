// deflate (RFC 1951, raw) whose output is fixed by the input alone: the same bytes here and from
// deflate.c, so packs, snapshots and fragments match across devices. inflate reads any deflate.
//
// the encoder (deflate.c follows it line for line):
//   matches   window 32768, lengths 3–258. hash (b[p] << 10 ^ b[p+1] << 5 ^ b[p+2]) & 32767,
//             newest first; walk at most CHAIN (64); first longest wins; NICE (128) ends the walk
//   choosing  no match: a literal. shorter than LAZY (32): try p + 1; longer there: literal at p
//   blocks    every BLOCK (16384) symbols, last final; smallest of stored (<= 65535 bytes), fixed,
//             dynamic; ties in that order
//   codes     package-merge (limits 15, 15, 7), ties by symbol, single symbols before packages;
//             fewer than two used symbols: lowest unused get count 1
//   lengths   lit/len and dist lengths as one run-length sequence (last nonzero kept): zero runs
//             >= 11 by 18 (<= 138), 3–10 by 17; repeats by 16 (3–6); code length lengths in RFC
//             order, at least 4

export class DeflateError extends Error {
	constructor(why: string) {
		super(why)
	}
}

const WINDOW = 32768, MIN = 3, MAX = 258, CHAIN = 64, NICE = 128, LAZY = 32, BLOCK = 16384

// lengths 3..258 and distances 1..32768 as codes, extra bits and bases (RFC 1951 3.2.5)
// deno-fmt-ignore
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99,
	115, 131, 163, 195, 227, 258]
// deno-fmt-ignore
const LEXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
// deno-fmt-ignore
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025,
	1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
// deno-fmt-ignore
const DEXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11,
	12, 12, 13, 13]
// the code length code's order
// deno-fmt-ignore
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

// a length's code (less 257), a distance's code
const LCODE = new Uint8Array(MAX + 1)
for (let c = 0; c < 28; c++) for (let l = LBASE[c]; l < LBASE[c + 1]; l++) LCODE[l] = c
LCODE[258] = 28
const DCODE = new Uint8Array(WINDOW + 1)
for (let c = 0; c < 30; c++) {
	for (let d = DBASE[c]; d < (c < 29 ? DBASE[c + 1] : WINDOW + 1); d++) DCODE[d] = c
}

// ---- writing bits, least significant first

class Bits {
	buf = new Uint8Array(1024)
	n = 0
	acc = 0
	count = 0
	put(value: number, bits: number) {
		this.acc |= value << this.count
		this.count += bits
		while (this.count >= 8) {
			this.byte(this.acc & 0xff)
			this.acc >>>= 8
			this.count -= 8
		}
	}
	byte(b: number) {
		if (this.n === this.buf.length) {
			const next = new Uint8Array(this.buf.length * 2)
			next.set(this.buf)
			this.buf = next
		}
		this.buf[this.n++] = b
	}
	// to a byte boundary, zeros
	align() {
		if (this.count > 0) this.byte(this.acc & 0xff)
		this.acc = 0
		this.count = 0
	}
	done(): Uint8Array {
		this.align()
		return this.buf.slice(0, this.n)
	}
}

// a code's bits reversed, as deflate sends Huffman codes
function reverse(code: number, len: number) {
	let r = 0
	for (let i = 0; i < len; i++) r = (r << 1) | ((code >> i) & 1)
	return r
}

// canonical codes from lengths (RFC 1951 3.2.2), reversed for sending
function codes(lengths: ArrayLike<number>): Uint32Array {
	const count = new Uint32Array(16), next = new Uint32Array(16)
	const out = new Uint32Array(lengths.length)
	for (let i = 0; i < lengths.length; i++) count[lengths[i]]++
	count[0] = 0
	let code = 0
	for (let b = 1; b < 16; b++) {
		code = (code + count[b - 1]) << 1
		next[b] = code
	}
	for (let i = 0; i < lengths.length; i++) {
		const l = lengths[i]
		if (l) out[i] = reverse(next[l]++, l)
	}
	return out
}

// code lengths for counts, at most limit bits: package-merge. the singles in order of count, ties
// by symbol; each level the pairs of the level before packaged, and merged with the singles by
// weight, a single before a package of the same weight; the first 2n - 2 items of the last level
// chosen, and a symbol's length is how many chosen items hold it (counted down the levels)
function lengthsOf(counts: Uint32Array, limit: number): Uint8Array {
	const out = new Uint8Array(counts.length)
	const used: number[] = []
	for (let s = 0; s < counts.length; s++) if (counts[s] > 0) used.push(s)
	if (used.length === 0) return out
	if (used.length === 1) {
		out[used[0]] = 1
		return out
	}
	used.sort((a, b) => counts[a] - counts[b] || a - b)
	const m = used.length
	// each level: its items' weights, and what each is: a single's symbol (>= 0), or a package of
	// items 2k and 2k + 1 of the level before (-1 - k)
	const weights: number[][] = [used.map((s) => counts[s])]
	const kinds: number[][] = [used.slice()]
	for (let level = 1; level < limit; level++) {
		const pw = weights[level - 1]
		const w: number[] = [], k: number[] = []
		let a = 0, b = 0
		const packages = pw.length >> 1
		while (a < m || b < packages) {
			const bw = b < packages ? pw[2 * b] + pw[2 * b + 1] : Infinity
			if (a < m && counts[used[a]] <= bw) w.push(counts[used[a]]), k.push(used[a++])
			else w.push(bw), k.push(-1 - b++)
		}
		weights.push(w), kinds.push(k)
	}
	// chosen: the first 2m - 2 of the last level; a package passes its count to its pair below
	let chosen = new Uint32Array(kinds[limit - 1].length)
	chosen.fill(1, 0, 2 * m - 2)
	for (let level = limit - 1; level >= 0; level--) {
		const k = kinds[level]
		const below = level > 0 ? new Uint32Array(kinds[level - 1].length) : new Uint32Array(0)
		for (let i = 0; i < k.length; i++) {
			const c = chosen[i]
			if (!c) continue
			if (k[i] >= 0) out[k[i]] += c
			else {
				const j = -1 - k[i]
				below[2 * j] += c, below[2 * j + 1] += c
			}
		}
		chosen = below
	}
	return out
}

// ---- the encoder

export function deflate(input: Uint8Array): Uint8Array {
	const n = input.length
	const head = new Int32Array(32768).fill(-1), prev = new Int32Array(WINDOW).fill(-1)
	let ins = 0
	// every position before p in its chain
	const upto = (p: number) => {
		for (; ins < p; ins++) {
			if (ins + 2 >= n) continue
			const h = ((input[ins] << 10) ^ (input[ins + 1] << 5) ^ input[ins + 2]) & 32767
			prev[ins & (WINDOW - 1)] = head[h]
			head[h] = ins
		}
	}
	// the best match at p: in found and at; found 0 for none
	let found = 0, at = 0
	const find = (p: number) => {
		upto(p)
		found = 0, at = 0
		if (p + 2 >= n) return
		const most = Math.min(MAX, n - p)
		let best = 0, dist = 0, walked = 0
		let cand = head[((input[p] << 10) ^ (input[p + 1] << 5) ^ input[p + 2]) & 32767]
		while (cand >= 0 && walked < CHAIN && p - cand <= WINDOW) {
			walked++
			if (input[cand + best] === input[p + best]) {
				let l = 0
				while (l < most && input[cand + l] === input[p + l]) l++
				if (l > best) {
					best = l, dist = p - cand
					if (l >= NICE || l === most) break
				}
			}
			const next = prev[cand & (WINDOW - 1)]
			if (next >= cand) break
			cand = next
		}
		if (best >= MIN) found = best, at = dist
	}
	// the symbols: a literal (dist 0, lit the byte) or a match (lit its length)
	const lits = new Uint16Array(n + 1), dists = new Uint16Array(n + 1)
	let count = 0
	for (let p = 0; p < n;) {
		find(p)
		const len = found, dist = at
		if (len === 0) {
			lits[count] = input[p], dists[count++] = 0
			p++
			continue
		}
		if (len < LAZY && p + 1 < n) {
			find(p + 1)
			if (found > len) {
				lits[count] = input[p], dists[count++] = 0
				p++
				continue
			}
		}
		lits[count] = len, dists[count++] = dist
		p += len
	}
	const out = new Bits()
	if (count === 0) {
		block(out, input, lits, dists, 0, 0, 0, 0, true)
		return out.done()
	}
	let first = 0 // the block's first byte
	for (let s = 0; s < count; s += BLOCK) {
		const end = Math.min(count, s + BLOCK)
		let bytes = 0
		for (let i = s; i < end; i++) bytes += dists[i] ? lits[i] : 1
		block(out, input, lits, dists, s, end, first, bytes, end === count)
		first += bytes
	}
	return out.done()
}

// fixed codes' lengths (RFC 1951 3.2.6)
const FIXED_L = new Uint8Array(288), FIXED_D = new Uint8Array(30).fill(5)
FIXED_L.fill(8, 0, 144),
	FIXED_L.fill(9, 144, 256),
	FIXED_L.fill(7, 256, 280),
	FIXED_L.fill(8, 280, 288)
const FIXED_LC = codes(FIXED_L), FIXED_DC = codes(FIXED_D)

const nonzero = (xs: Uint32Array) => xs.reduce((t, c) => t + (c > 0 ? 1 : 0), 0)

function block(
	out: Bits,
	input: Uint8Array,
	lits: Uint16Array,
	dists: Uint16Array,
	s: number,
	end: number,
	first: number,
	bytes: number,
	last: boolean,
) {
	const lc = new Uint32Array(286), dc = new Uint32Array(30)
	let extra = 0 // the extra bits every code carries, the same whichever codes
	for (let i = s; i < end; i++) {
		if (dists[i] === 0) lc[lits[i]]++
		else {
			const c = LCODE[lits[i]], d = DCODE[dists[i]]
			lc[257 + c]++, dc[d]++
			extra += LEXTRA[c] + DEXTRA[d]
		}
	}
	lc[256]++
	// the dynamic codes
	const lcount = lc.slice(), dcount = dc.slice()
	for (let k = 0, used = nonzero(lcount); used < 2; k++) if (lcount[k] === 0) lcount[k] = 1, used++
	for (let k = 0, used = nonzero(dcount); used < 2; k++) if (dcount[k] === 0) dcount[k] = 1, used++
	const ll = lengthsOf(lcount, 15), dl = lengthsOf(dcount, 15)
	let hlit = 286
	while (hlit > 257 && ll[hlit - 1] === 0) hlit--
	let hdist = 30
	while (hdist > 1 && dl[hdist - 1] === 0) hdist--
	const seq = new Uint8Array(hlit + hdist)
	seq.set(ll.subarray(0, hlit)), seq.set(dl.subarray(0, hdist), hlit)
	// the sequence run-length coded: symbols, and each one's extra value
	const rle: number[] = [], rlx: number[] = []
	for (let i = 0; i < seq.length;) {
		const v = seq[i]
		let r = 1
		while (i + r < seq.length && seq[i + r] === v) r++
		i += r
		if (v === 0) {
			while (r >= 11) {
				const k = Math.min(r, 138)
				rle.push(18), rlx.push(k - 11), r -= k
			}
			if (r >= 3) rle.push(17), rlx.push(r - 3), r = 0
			for (; r > 0; r--) rle.push(0), rlx.push(0)
		} else {
			rle.push(v), rlx.push(0), r--
			while (r >= 3) {
				const k = Math.min(r, 6)
				rle.push(16), rlx.push(k - 3), r -= k
			}
			for (; r > 0; r--) rle.push(v), rlx.push(0)
		}
	}
	const cc = new Uint32Array(19)
	for (const y of rle) cc[y]++
	const cl = lengthsOf(cc, 7)
	let hclen = 19
	while (hclen > 4 && cl[ORDER[hclen - 1]] === 0) hclen--
	// sizes in bits, beyond the 3-bit header
	let dynamic = 5 + 5 + 4 + 3 * hclen + extra
	for (const y of rle) dynamic += cl[y] + (y === 16 ? 2 : y === 17 ? 3 : y === 18 ? 7 : 0)
	let fixed = extra
	for (let k = 0; k < 286; k++) dynamic += lc[k] * ll[k], fixed += lc[k] * FIXED_L[k]
	for (let k = 0; k < 30; k++) dynamic += dc[k] * dl[k], fixed += dc[k] * FIXED_D[k]
	// stored: to the byte, then four bytes of length, then the bytes
	const pad = (8 - ((out.count + 3) % 8)) % 8
	const stored = bytes <= 65535 ? pad + 32 + 8 * bytes : Infinity
	const header = (type: number) => out.put((last ? 1 : 0) | (type << 1), 3)
	if (stored <= fixed && stored <= dynamic) {
		header(0)
		out.align()
		out.put(bytes & 0xffff, 16), out.put(~bytes & 0xffff, 16)
		for (let i = 0; i < bytes; i++) out.byte(input[first + i])
		return
	}
	let lcodes: Uint32Array, llen: Uint8Array, dcodes: Uint32Array, dlen: Uint8Array
	if (fixed <= dynamic) {
		header(1)
		lcodes = FIXED_LC, llen = FIXED_L, dcodes = FIXED_DC, dlen = FIXED_D
	} else {
		header(2)
		out.put(hlit - 257, 5), out.put(hdist - 1, 5), out.put(hclen - 4, 4)
		for (let k = 0; k < hclen; k++) out.put(cl[ORDER[k]], 3)
		const ccodes = codes(cl)
		for (let i = 0; i < rle.length; i++) {
			const y = rle[i]
			out.put(ccodes[y], cl[y])
			if (y === 16) out.put(rlx[i], 2)
			else if (y === 17) out.put(rlx[i], 3)
			else if (y === 18) out.put(rlx[i], 7)
		}
		lcodes = codes(ll), llen = ll, dcodes = codes(dl), dlen = dl
	}
	for (let i = s; i < end; i++) {
		const lit = lits[i], dist = dists[i]
		if (dist === 0) {
			out.put(lcodes[lit], llen[lit])
			continue
		}
		const c = LCODE[lit], d = DCODE[dist]
		out.put(lcodes[257 + c], llen[257 + c])
		if (LEXTRA[c]) out.put(lit - LBASE[c], LEXTRA[c])
		out.put(dcodes[d], dlen[d])
		if (DEXTRA[d]) out.put(dist - DBASE[d], DEXTRA[d])
	}
	out.put(lcodes[256], llen[256])
}

// ---- the decoder: any deflate. limit: the most bytes it may give (a bomb is refused)

// a decoding table: for every 15 bits that could come next (least significant first), the symbol
// they start with and its length in bits; length 0: no code starts so
type Table = { sym: Uint16Array; len: Uint8Array }
function table(lengths: ArrayLike<number>): Table {
	const count = new Uint16Array(16)
	for (let i = 0; i < lengths.length; i++) count[lengths[i]]++
	count[0] = 0
	// over-subscribed: no code
	let left = 1
	for (let b = 1; b < 16; b++) {
		left = (left << 1) - count[b]
		if (left < 0) throw new DeflateError("a code over-subscribed")
	}
	const sym = new Uint16Array(32768), len = new Uint8Array(32768)
	const rev = codes(lengths)
	for (let i = 0; i < lengths.length; i++) {
		const l = lengths[i]
		if (!l) continue
		for (let k = rev[i]; k < 32768; k += 1 << l) sym[k] = i, len[k] = l
	}
	return { sym, len }
}
let FIXED_LT: Table | undefined, FIXED_DT: Table | undefined

export function inflate(input: Uint8Array, limit = 1 << 30): Uint8Array {
	let pos = 0, acc = 0, have = 0
	let out = new Uint8Array(Math.max(64, Math.min(limit, input.length * 4))), n = 0
	// at least k bits in acc (zeros past the end, which a code may peek at but not use)
	const fill = (k: number) => {
		while (have < k) {
			acc |= (pos < input.length ? input[pos] : 0) << have
			pos++, have += 8
		}
	}
	const bits = (k: number) => {
		fill(k)
		if (pos - Math.floor(have / 8) > input.length && have - k < 8 * (pos - input.length)) {
			throw new DeflateError("ends early")
		}
		const v = acc & ((1 << k) - 1)
		acc >>>= k, have -= k
		return v
	}
	const room = (k: number) => {
		if (n + k > limit) throw new DeflateError("over the limit")
		if (n + k <= out.length) return
		let size = out.length * 2
		while (size < n + k) size *= 2
		const next = new Uint8Array(Math.min(size, limit))
		next.set(out.subarray(0, n))
		out = next
	}
	const decode = (t: Table) => {
		fill(15)
		const k = acc & 32767, l = t.len[k]
		if (l === 0) throw new DeflateError("no such code")
		// the bits a code uses must have been there
		if (8 * (pos - input.length) > have - l) throw new DeflateError("ends early")
		acc >>>= l, have -= l
		return t.sym[k]
	}
	for (let last = 0; !last;) {
		last = bits(1)
		const type = bits(2)
		if (type === 0) {
			// to the byte: what is left of this one dropped, whole bytes read ahead given back
			const back = have >> 3
			pos -= back, acc = 0, have = 0
			if (pos + 4 > input.length) throw new DeflateError("ends early")
			const len = input[pos] | (input[pos + 1] << 8),
				nlen = input[pos + 2] | (input[pos + 3] << 8)
			if (len !== (~nlen & 0xffff)) throw new DeflateError("a stored length that doesn't check")
			pos += 4
			if (pos + len > input.length) throw new DeflateError("ends early")
			room(len)
			out.set(input.subarray(pos, pos + len), n)
			n += len, pos += len
			continue
		}
		let lt: Table, dt: Table
		if (type === 1) {
			lt = FIXED_LT ??= table(FIXED_L), dt = FIXED_DT ??= table(FIXED_D)
		} else if (type === 2) {
			const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4
			if (hlit > 286 || hdist > 30) throw new DeflateError("too many codes")
			const cl = new Uint8Array(19)
			for (let k = 0; k < hclen; k++) cl[ORDER[k]] = bits(3)
			const ct = table(cl)
			const lens = new Uint8Array(hlit + hdist)
			for (let i = 0; i < hlit + hdist;) {
				const y = decode(ct)
				if (y < 16) lens[i++] = y
				else {
					let r: number, v = 0
					if (y === 16) {
						if (i === 0) throw new DeflateError("a repeat with nothing before")
						v = lens[i - 1], r = 3 + bits(2)
					} else if (y === 17) r = 3 + bits(3)
					else r = 11 + bits(7)
					if (i + r > hlit + hdist) throw new DeflateError("lengths past the end")
					for (; r > 0; r--) lens[i++] = v
				}
			}
			if (lens[256] === 0) throw new DeflateError("no end of block")
			lt = table(lens.subarray(0, hlit)), dt = table(lens.subarray(hlit))
		} else throw new DeflateError("a block of type 3")
		for (;;) {
			const y = decode(lt)
			if (y < 256) {
				if (n === out.length) room(1)
				else if (n + 1 > limit) throw new DeflateError("over the limit")
				out[n++] = y
			} else if (y === 256) break
			else {
				const c = y - 257
				if (c >= 29) throw new DeflateError("no such length")
				const len = LBASE[c] + (LEXTRA[c] ? bits(LEXTRA[c]) : 0)
				const d = decode(dt)
				if (d >= 30) throw new DeflateError("no such distance")
				const dist = DBASE[d] + (DEXTRA[d] ? bits(DEXTRA[d]) : 0)
				if (dist > n) throw new DeflateError("a distance before the start")
				room(len)
				for (let k = 0; k < len; k++, n++) out[n] = out[n - dist]
			}
		}
	}
	return out.slice(0, n)
}
