// string positions, for every lib that has them (notify, apply, squish)
// a position counts code points: a surrogate pair is one, a lone surrogate is one.
// utf16: UTF-16 units, JavaScript's own: nothing walked (an experiment)
// the walk: positions before the first surrogate are their units, so the engine finds it (a
// string of Latin-1 has none: answered at once); then pair to pair, while pairs are sparse; then
// unit by unit

const sur = /[\uD800-\uDFFF]/
const pair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g

// from unit i, position k, unit by unit; x, y: a's and b's units if found, else -1
function step(
	s: string,
	i: number,
	k: number,
	a: number,
	b: number,
	all: boolean,
	x: number,
	y: number,
): [number, number, number] | null {
	const u = s.length
	if (x < 0) {
		for (; k < a; k++) {
			if (i >= u) return null
			const c = s.charCodeAt(i)
			i += c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1
		}
		x = i
	}
	if (y < 0) {
		for (; k < b; k++) {
			if (i >= u) return null
			const c = s.charCodeAt(i)
			i += c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1
		}
		y = i
	}
	if (!all) return [x, y, -1]
	for (; i < u; k++) {
		const c = s.charCodeAt(i)
		i += c >= 0xd800 && c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? 2 : 1
	}
	return [x, y, k]
}

// pairs closer than one in DENSE units, after AFTER of them: stepping beats jumping
const DENSE = 16, AFTER = 8

// one walk: the units where positions a and b start (a <= b), and, all: how many positions s has
// (else -1); null: b past the end
export function walk(
	s: string,
	a: number,
	b: number,
	all = false,
	utf16 = false,
): [number, number, number] | null {
	const u = s.length
	if (utf16) return b <= u ? [a, b, all ? u : -1] : null
	const f = s.search(sur)
	if (f < 0) return b <= u ? [a, b, all ? u : -1] : null
	// unit i is position k; before f, every position is its unit
	let i = f, k = f
	let x = a <= f ? a : -1, y = b <= f ? b : -1
	if (y >= 0 && !all) return [x, y, -1]
	pair.lastIndex = f
	let pairs = 0, m
	while ((m = pair.exec(s)) !== null) {
		// the pair's position
		const at = k + (m.index - i)
		if (x < 0 && a <= at) x = i + (a - k)
		if (y < 0 && b <= at) {
			y = i + (b - k)
			if (!all) return [x, y, -1]
		}
		i = m.index + 2
		k = at + 1
		if (++pairs >= AFTER && i - f < pairs * DENSE) return step(s, i, k, a, b, all, x, y)
	}
	// no pair left: one unit a position
	if (x < 0) x = i + (a - k)
	if (y < 0) y = i + (b - k)
	if (y > u) return null
	return [x, y, all ? k + (u - i) : -1]
}

// what a holder of s knows of it: n positions (-1: not known), and position k is at unit i
export type Hint = { n: number; k: number; i: number }

// from unit i, position k, back to position a: its unit. a pair is a low after a high, read
// either way
function back(s: string, i: number, k: number, a: number): number {
	for (; k > a; k--) {
		const c = s.charCodeAt(--i)
		if ((c & 0xfc00) === 0xdc00 && i > 0 && (s.charCodeAt(i - 1) & 0xfc00) === 0xd800) i--
	}
	return i
}

// walk, begun where it is shortest: the start, the hint, or the end (when n is known); forward
// or back. the count is the hint's n when known, else walked for when all
export function near(
	s: string,
	a: number,
	b: number,
	all: boolean,
	h: Hint,
): [number, number, number] | null {
	const { n, k, i } = h
	if (n >= 0 && b > n) return null
	const fromEnd = n >= 0 ? n - a : Infinity
	const fromHint = Math.abs(a - k)
	// the start: walk's own fast paths
	if (a <= fromHint && a <= fromEnd) {
		const w = walk(s, a, b, all && n < 0)
		return w && n >= 0 ? [w[0], w[1], n] : w
	}
	let x: number
	if (fromEnd < fromHint) x = back(s, s.length, n, a)
	else if (a < k) x = back(s, i, k, a)
	else {
		const w = step(s, i, k, a, a, false, -1, -1)
		if (!w) return null
		x = w[0]
	}
	const w = step(s, x, a, a, b, all && n < 0, x, -1)
	if (!w) return null
	return [x, w[1], n >= 0 ? n : w[2]]
}

// a lone high met by a lone low at unit u of s: an edit that cut or put there made them one pair,
// a position fewer. an edit never splits a pair (a position never starts inside one)
export function joins(s: string, u: number): boolean {
	return u > 0 && (s.charCodeAt(u - 1) & 0xfc00) === 0xd800 &&
		(s.charCodeAt(u) & 0xfc00) === 0xdc00
}

// how many positions s has
export function count(s: string, utf16 = false): number {
	return utf16 ? s.length : walk(s, 0, 0, true)![2]
}

// the unit where position n starts (s.length at the end); -1: past the end
export function unit(s: string, n: number, utf16 = false): number {
	return walk(s, n, n, false, utf16)?.[0] ?? -1
}

// positions [a, b), walking no further than b; past the end: cut there; a < 0 or b <= a: ""
export function slice(s: string, a: number, b: number, utf16 = false): string {
	if (a < 0 || b <= a) return ""
	if (utf16) return s.slice(a, b)
	const w = walk(s, a, b)
	if (w) return s.slice(w[0], w[1])
	const x = unit(s, a)
	return x < 0 ? "" : s.slice(x)
}

// the old way, unit by unit from the start: the baseline fast paths are benched against
export function stepped(
	s: string,
	a: number,
	b: number,
	all = false,
): [number, number, number] | null {
	return step(s, 0, 0, a, b, all, -1, -1)
}
