// pack: a run's steps, small on the wire (WIRE.md, pack). the first step goes whole; the rest only
// as what can't be worked out from the step before, in columns. unpack makes each step's bytes again
// exactly, so chain and signature are checked as ever, and throws on a pack that isn't one
//
//   const packed = pack(steps); const steps = unpack(packed)
import type { Value } from "@ermine/encoding/cbor"
import { type Columns, decode as patchesOf, encode as columns } from "@ermine/op/squish"
import { decodeStep, encodeStep, hashStep, type Step } from "./step.ts"

export type Packed = [
	first: Uint8Array,
	lamport: number[],
	when: number[],
	node: Value[],
	part: Value[],
	who: Value[],
	count: number[],
	columns: Columns,
]

// a list as runs, [value, count, …], and back
function runs<T>(xs: T[]): T[] {
	const out: T[] = []
	for (const x of xs) {
		const n = out.length
		if (n && out[n - 2] === x) (out[n - 1] as number)++
		else out.push(x, 1 as T)
	}
	return out
}
function unruns<T>(rs: T[]): T[] {
	const out: T[] = []
	for (let i = 0; i < rs.length; i += 2) {
		for (let n = 0; n < (rs[i + 1] as number); n++) out.push(rs[i])
	}
	return out
}

// the most steps a pack holds, and patches
const STEPS = 4096, PATCHES = 65536

// how many a column's runs make, or -1: not runs (each count a whole number past 0)
function length(rs: unknown): number {
	if (!Array.isArray(rs) || rs.length % 2) return -1
	let n = 0
	for (let i = 1; i < rs.length; i += 2) {
		if (!Number.isSafeInteger(rs[i]) || rs[i] < 1) return -1
		n += rs[i]
	}
	return n
}
// the sum of a column of numbers' runs, or -1
function sum(rs: unknown[]): number {
	let n = 0
	for (let i = 0; i < rs.length; i += 2) {
		if (!Number.isSafeInteger(rs[i]) || (rs[i] as number) < 0) return -1
		n += (rs[i] as number) * (rs[i + 1] as number)
	}
	return n
}
// how many patches a pack's columns hold, every column as long as they say, or -1
function patchCount(c: Columns): number {
	const n = length(c?.shape)
	if (n < 0 || n > PATCHES || length(c.path) !== n || !Array.isArray(c.paths)) return -1
	let ranged = 0, valued = 0, moved = 0
	for (let i = 0; i < c.shape.length; i += 2) {
		const s = c.shape[i], k = c.shape[i + 1]
		if (!Number.isInteger(s) || s < 0 || s > 7) return -1
		ranged += s & 1 ? k : 0, valued += s & 2 ? k : 0, moved += s & 4 ? k : 0
	}
	const ok = length(c.from) === ranged && length(c.size) === ranged &&
		Array.isArray(c.value) && c.value.length === valued && Array.isArray(c.move) &&
		c.move.length === moved &&
		c.path.every((x, i) => i % 2 || (Number.isInteger(x) && x >= 0 && x < c.paths.length))
	return ok ? n : -1
}

export function pack(bytes: readonly Uint8Array[]): Packed {
	const steps = bytes.map(decodeStep), rest = steps.slice(1)
	return [
		bytes[0],
		runs(rest.map((s, i) => s.lamport - steps[i].lamport)),
		runs(rest.map((s, i) => s.when - steps[i].when)),
		runs(rest.map((s) => s.node)),
		runs(rest.map((s) => s.part)),
		runs(rest.map((s) => s.who ?? null)),
		runs(rest.map((s) => s.patches.length)),
		columns(rest.flatMap((s) => s.patches)),
	]
}

// a pack's steps; a pack that isn't one throws before anything is made of it: eight elements, at
// most STEPS steps and PATCHES patches, every column as long as the rest
export function unpack(p: unknown): Uint8Array[] {
	if (!Array.isArray(p) || p.length !== 8) throw new TypeError("not a pack")
	const [first, lamports, whens, nodes, parts, whos, counts, cols] = p as Packed
	const steps = length(lamports), patches = patchCount(cols)
	const ok = steps >= 0 && steps < STEPS && patches >= 0 && first instanceof Uint8Array &&
		[whens, nodes, parts, whos, counts].every((c) => length(c) === steps) &&
		sum(counts) === patches
	if (!ok) throw new TypeError("not a pack")
	const out = [first]
	let prev = decodeStep(first), at = 0
	const lamport = unruns(lamports),
		when = unruns(whens),
		node = unruns(nodes),
		part = unruns(parts),
		who = unruns(whos),
		count = unruns(counts)
	const all = patchesOf(cols)
	for (let i = 0; i < count.length; i++) {
		const s: Step = {
			device: prev.device,
			n: prev.n + 1,
			before: hashStep(out[out.length - 1]),
			node: node[i] as string,
			part: part[i] as string,
			patches: all.slice(at, at += count[i]),
			lamport: prev.lamport + lamport[i],
			when: prev.when + when[i],
			...(who[i] !== null && { who: who[i] as string }),
		}
		out.push(encodeStep(s))
		prev = s
	}
	return out
}
