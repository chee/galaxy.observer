// patches pushed in, fewer patches out; and patches as columns, run-length encoded
// patches are GRAPH.tex's: this reads them, never applies them, and never needs the content
// squishing keeps the end result and drops the in-between: only an edit's end is ever seen
import type { Key, Patch, Span } from "./apply.ts"
import { count, near } from "@ermine/util/walk-string"

type Ranged = Patch & { range: Span }

const isList = Array.isArray
const ranged = (p: Patch): p is Ranged => p.range !== undefined
const plain = (p: Patch) => p.move === undefined && !("value" in p)

// strings count code points: walk.ts
function len(v: unknown): number {
	if (typeof v === "string") return count(v)
	if (isList(v) || typed(v)) return v.length
	return NaN
}
// bytes, a Uint8Array, are one whole value: never joined or cut (MUTATE.tex)
type Typed = Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array
const typed = (v: unknown): v is Typed =>
	ArrayBuffer.isView(v) && !(v instanceof DataView) && !(v instanceof Uint8Array)

const same = (a: readonly Key[], b: readonly Key[]) =>
	a.length === b.length && a.every((k, i) => k === b[i])
// q is at or above p
const under = (p: readonly Key[], q: readonly Key[]) =>
	q.length <= p.length && q.every((k, i) => k === p[i])

// next puts or removes the whole of prev's place, so prev is dead
// a move in prev may take from anywhere: never dead
// prev removing a list element (a number last) moves the ones after it: next at the same place is
// at another element
function dies(prev: Patch, next: Patch): boolean {
	return next.range === undefined && next.move === undefined && prev.move === undefined &&
		under(prev.path, next.path) &&
		!(plain(prev) && prev.range === undefined && typeof prev.path.at(-1) === "number" &&
			prev.path.length === next.path.length)
}

// the last patch's value, as known: so typing one at a time costs what it types
type Tail = {
	// its length; -1: not counted
	n: number
	// a string whose places are its UTF-16 units: no surrogate pairs
	simple: boolean
	// made here and never given out: may change in place. a typed array: a view of back
	own: boolean
	back: Typed | null
}
const fresh = (): Tail => ({ n: -1, simple: false, own: false, back: null })

// v, n long, with [x, y) replaced by w (undefined: removed); undefined when the kinds differ
function splice(t: Tail, v: unknown, x: number, y: number, w: unknown): unknown {
	const n = t.n
	if (typeof v === "string") {
		if (w !== undefined && typeof w !== "string") return undefined
		const s = w ?? "", wn = len(s)
		t.n = n - (y - x) + wn
		if (x === n) return t.simple = t.simple && s.length === wn, v + s
		if (t.simple) return t.simple = s.length === wn, v.slice(0, x) + s + v.slice(y)
		const at = near(v, x, y, false, { n, k: n, i: v.length })
		let out
		if (at) out = v.slice(0, at[0]) + s + v.slice(at[1])
		else {
			const cs = Array.from(v)
			out = cs.slice(0, x).join("") + s + cs.slice(y).join("")
		}
		t.simple = out.length === t.n
		return out
	}
	if (isList(v)) {
		if (w !== undefined && !isList(w)) return undefined
		let out = t.own ? v : v.slice()
		if (x === out.length && y === x && w) { for (const e of w) out.push(e) }
		else if (w && w.length > 1000) out = out.slice(0, x).concat(w, out.slice(y))
		else out.splice(x, y - x, ...(w ?? []))
		t.own = true
		t.n = out.length
		return out
	}
	if (!typed(v)) return undefined
	if (w !== undefined && (!typed(w) || w.constructor !== v.constructor)) return undefined
	const wn = w ? w.length : 0, size = n - (y - x) + wn
	t.n = size
	if (t.own && t.back && x === n && size <= t.back.length) {
		if (w) t.back.set(w, n)
		return t.back.subarray(0, size)
	}
	const back = new (v.constructor as new (n: number) => Typed)(Math.max(16, size * 2))
	back.set(v.subarray(0, x), 0)
	if (w) back.set(w, x)
	back.set(v.subarray(y), x + wn)
	t.own = true
	t.back = back
	return back.subarray(0, size)
}

// one patch doing what prev and then next do, or null; t: prev's value, then the result's
function merge(t: Tail, prev: Patch, next: Patch): Patch | null {
	if (!ranged(prev) || !ranged(next) || prev.move || next.move) return null
	if (!same(prev.path, next.path)) return null
	const [a, b] = prev.range, [c, d] = next.range
	const path = prev.path
	const w = "value" in next ? next.value : undefined
	if ("value" in prev) {
		if (t.n < 0) {
			t.n = len(prev.value)
			t.simple = typeof prev.value === "string" && prev.value.length === t.n
		}
		// the span prev made is [a, a + n)
		const n = t.n
		let value: unknown, range: Span
		if (a <= c && d <= a + n) {
			value = splice(t, prev.value, c - a, d - a, w), range = [a, b]
		} else if (c === a + n && d > c) {
			value = w === undefined ? prev.value : splice(t, prev.value, n, n, w)
			range = [a, b + (d - c)]
		} else return null
		if (value === undefined) return null
		return { path, range, value }
	}
	if (!plain(prev)) return null
	// prev removed [a, b)
	if (w === undefined) {
		if (c <= a && a <= d) return { path, range: [c, b + (d - a)] }
		return null
	}
	if (c === a && d === a) return Object.assign(t, fresh()), { path, range: [a, b], value: w }
	return null
}

// prev and next might merge, by their ranges alone: cheaper than a merge that fails. t: prev's
// tail; its length not counted yet, the UTF-16 length is as long or longer
function could(t: Tail, prev: Patch, next: Patch): boolean {
	if (!ranged(prev) || !ranged(next)) return false
	const a = prev.range[0], [c, d] = next.range
	if (!("value" in prev)) return "value" in next ? c === a && d === a : c <= a && a <= d
	if (t.n >= 0) return (a <= c && d <= a + t.n) || (c === a + t.n && d > c)
	const v = prev.value
	return (typeof v === "string" || isList(v) || typed(v)) && a <= c && c <= a + v.length
}

// a lone surrogate anywhere in v
function lone(v: unknown): boolean {
	if (typeof v === "string") return !v.isWellFormed()
	if (v === null || typeof v !== "object" || ArrayBuffer.isView(v)) return false
	for (const x of isList(v) ? v : Object.values(v)) if (lone(x)) return true
	return false
}

export type Squish = {
	// the patch is kept as given, never changed
	push(patch: Patch): void
	// what has been pushed, squished; a copy
	patches(): Patch[]
	[Symbol.iterator](): Iterator<Patch>
}

// typing at one place becomes one insert; a backspace after it, a shorter one;
// a put makes earlier patches under it dead; moves are never merged. merges reach back: a last
// patch just merged is merged into the one before it, and that into the one before, while they do
export default function createSquish(): Squish {
	const buf: Patch[] = []
	// counting code points, a lone surrogate makes positions depend on what is around it, which
	// squish never sees (a lone high meeting a lone low is one pair, a position fewer). so a patch
	// that puts one somewhere is never merged, and nothing at or under where it went is merged
	// again
	// PROBLEM (open, flagged by the designer 10-11): the content squish starts on is taken to be
	// well-formed. lone halves already in it are never seen (squish stays content-free), so a
	// removal that brings two together is merged wrong (squish_test.ts, "removal joins them")
	const fouled: (readonly Key[])[] = []
	const isFouled = (path: readonly Key[]) => fouled.some((f) => under(path, f))
	let tail = fresh()
	// one per patch before the last: the tail it had, retired. its length stays counted; never
	// changed in place again
	const kept: Tail[] = []
	const retire = (t: Tail): Tail => ({ n: t.n, simple: t.simple, own: false, back: null })
	// the tail is given out: never changed in place again, a typed array cut to its length
	function seen() {
		const last = buf[buf.length - 1]
		if (tail.own && tail.back) {
			buf[buf.length - 1] = { ...last, value: (last.value as Typed).slice() }
		}
		tail = fresh()
	}
	return {
		push(patch) {
			if (patch.path.length === 0 && patch.range === undefined && patch.move === undefined) {
				buf.length = 0, kept.length = 0
			} else {
				while (buf.length && dies(buf[buf.length - 1], patch)) {
					buf.pop(), tail = kept.pop() ?? fresh()
				}
			}
			let m = null
			if (lone(patch.value) || (patch.move && isFouled(patch.move.path))) {
				fouled.push(patch.path)
			} else if (buf.length && !isFouled(patch.path)) {
				m = merge(tail, buf[buf.length - 1], patch)
			}
			if (!m) {
				if (buf.length) kept.push(retire(tail))
				buf.push(patch), tail = fresh()
				return
			}
			let last: Patch = buf[buf.length - 1] = m
			// reaching back: at the path just merged, so never fouled
			while (kept.length) {
				const t = kept[kept.length - 1], prev = buf[buf.length - 2]
				const back = could(t, prev, last) ? merge(t, prev, last) : null
				if (!back) break
				kept.pop(), buf.pop()
				buf[buf.length - 1] = last = back, tail = t
			}
		},
		patches: () => (seen(), buf.slice()),
		[Symbol.iterator]: () => (seen(), buf.values()),
	}
}

export function squish(patches: Iterable<Patch>): Patch[] {
	const s = createSquish()
	for (const p of patches) s.push(p)
	return s.patches()
}

// patches as columns: [value, count, value, count, ...] runs, equal paths once
export type Columns = {
	// each distinct path once
	paths: (readonly Key[])[]
	// which path, per patch
	path: number[]
	// per patch: 1 has a range, 2 has a value, 4 has a move
	shape: number[]
	// per ranged patch: its from, as the step from the last ranged patch's from
	from: number[]
	// per ranged patch: to - from
	size: number[]
	value: unknown[]
	move: NonNullable<Patch["move"]>[]
}

function runs(xs: number[]): number[] {
	const out: number[] = []
	for (const x of xs) {
		const n = out.length
		if (n && out[n - 2] === x) out[n - 1]++
		else out.push(x, 1)
	}
	return out
}
function* unruns(rs: number[]): Generator<number> {
	for (let i = 0; i < rs.length; i += 2) for (let n = 0; n < rs[i + 1]; n++) yield rs[i]
}

export function encode(patches: Iterable<Patch>): Columns {
	const paths: (readonly Key[])[] = []
	const seen = new Map<string, number>()
	const path: number[] = [], shape: number[] = [], from: number[] = [], size: number[] = []
	const value: unknown[] = [], move: Columns["move"] = []
	let last = 0
	for (const p of patches) {
		const id = JSON.stringify(p.path)
		let i = seen.get(id)
		if (i === undefined) seen.set(id, i = paths.push(p.path) - 1)
		path.push(i)
		shape.push((p.range ? 1 : 0) | ("value" in p ? 2 : 0) | (p.move ? 4 : 0))
		if (p.range) {
			from.push(p.range[0] - last)
			size.push(p.range[1] - p.range[0])
			last = p.range[0]
		}
		if ("value" in p) value.push(p.value)
		if (p.move) move.push(p.move)
	}
	return {
		paths,
		path: runs(path),
		shape: runs(shape),
		from: runs(from),
		size: runs(size),
		value,
		move,
	}
}

export function decode(c: Columns): Patch[] {
	const path = unruns(c.path),
		shape = unruns(c.shape),
		from = unruns(c.from),
		size = unruns(c.size)
	const out: Patch[] = []
	let last = 0, v = 0, m = 0
	for (const s of shape) {
		const p: Patch = { path: c.paths[path.next().value!] }
		if (s & 1) {
			last += from.next().value!
			p.range = [last, last + size.next().value!]
		}
		if (s & 2) p.value = c.value[v++]
		if (s & 4) p.move = c.move[m++]
		out.push(p)
	}
	return out
}
