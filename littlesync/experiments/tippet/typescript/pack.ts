// pack: a run's steps, small on the wire (WIRE.md, pack). each step only as what can't be worked
// out from the step before, in columns; the first from step n - 1 (its prior), or whole at n = 1
// or with no prior given. unpack makes each step's bytes again exactly, so chain and signature are
// checked as ever, and throws on a pack that isn't one, or one packed against a prior not given
//
//   const packed = pack(steps, priorOf(stepBefore)); const steps = unpack(packed, prior)
import type { Value } from "@ermine/encoding/cbor"
import { type Columns, decode as patchesOf, encode as columns } from "@ermine/op/squish"
import { decodeStep, encodeStep, hashStep, own, type Step, written } from "./step.ts"

// first: the first step whole, or its n, worked out from step n - 1 like the rest
export type Packed = [
	first: Uint8Array | number,
	lamport: number[],
	when: number[],
	node: Value[],
	part: Value[],
	who: Value[],
	count: number[],
	columns: Columns,
]

// the same value: a node relative ([rest]) by its rest
const alike = (a: unknown, b: unknown) =>
	a === b ||
	(Array.isArray(a) && Array.isArray(b) && a.length === 1 && b.length === 1 && a[0] === b[0])

// a list as runs, [value, count, …], and back
function runs<T>(xs: T[]): T[] {
	const out: T[] = []
	for (const x of xs) {
		const n = out.length
		if (n && alike(out[n - 2], x)) (out[n - 1] as number)++
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

// what a step after this one is worked out from: its device, n, hash, lamport and when
export type Prior = { device: string; n: number; hash: Uint8Array; lamport: number; when: number }
export function priorOf(bytes: Uint8Array): Prior {
	const s = decodeStep(bytes)
	return { device: s.device, n: s.n, hash: hashStep(bytes), lamport: s.lamport, when: s.when }
}
// the first n of a pack, and whether it is packed against the step before it
export function firstOf(p: Packed): { n: number; prior: boolean } {
	return typeof p[0] === "number"
		? { n: p[0], prior: true }
		: { n: decodeStep(p[0]).n, prior: false }
}

// how many steps a pack holds
export const stepsIn = (p: Packed) =>
	(typeof p[0] === "number" ? 0 : 1) + (p[1] as number[]).reduce((k, x, i) => i % 2 ? k + x : k, 0)

// prior: the step before the first (it must be that one); none, or the first at n = 1: it goes whole
export function pack(bytes: readonly Uint8Array[], prior?: Prior): Packed {
	const steps = bytes.map(decodeStep), s0 = steps[0]
	if (prior && (prior.device !== s0.device || prior.n !== s0.n - 1)) {
		throw new RangeError("not the step before")
	}
	const before: Pick<Step, "lamport" | "when">[] = prior ? [prior, ...steps] : steps
	const rest = prior ? steps : steps.slice(1)
	return [
		prior ? s0.n : bytes[0],
		runs(rest.map((s, i) => s.lamport - before[i].lamport)),
		runs(rest.map((s, i) => s.when - before[i].when)),
		runs(rest.map(written)),
		runs(rest.map((s) => s.part)),
		runs(rest.map((s) => s.who ?? null)),
		runs(rest.map((s) => s.patches.length)),
		columns(rest.flatMap((s) => s.patches)),
	]
}

// a pack's steps; a pack that isn't one throws before anything is made of it: eight elements, at
// most STEPS steps in the columns and PATCHES patches, every column as long as the rest. one packed
// against step n - 1 is made from prior, which must be that step's; without it, it throws
export function unpack(p: unknown, prior?: Prior): Uint8Array[] {
	if (!Array.isArray(p) || p.length !== 8) throw new TypeError("not a pack")
	const [first, lamports, whens, nodes, parts, whos, counts, cols] = p as Packed
	const steps = length(lamports), patches = patchCount(cols)
	const against = typeof first === "number"
	const ok = steps >= 0 && steps < STEPS && patches >= 0 &&
		(first instanceof Uint8Array ||
			(Number.isSafeInteger(first) && (first as number) >= 2 && steps >= 1)) &&
		[whens, nodes, parts, whos, counts].every((c) => length(c) === steps) &&
		sum(counts) === patches
	if (!ok) throw new TypeError("not a pack")
	if (against && prior?.n !== (first as number) - 1) {
		throw new RangeError("the step before is not held")
	}
	const out: Uint8Array[] = against ? [] : [first as Uint8Array]
	let prev: Pick<Step, "device" | "n" | "lamport" | "when"> = against
		? prior!
		: decodeStep(first as Uint8Array)
	let hash = against ? prior!.hash : hashStep(first as Uint8Array), at = 0
	const lamport = unruns(lamports),
		when = unruns(whens),
		node = unruns(nodes),
		part = unruns(parts),
		who = unruns(whos),
		count = unruns(counts)
	const all = patchesOf(cols)
	// a node: its id, or [the rest after the device's]
	if (
		!node.every((x) =>
			typeof x === "string" || (Array.isArray(x) && x.length === 1 && typeof x[0] === "string")
		)
	) {
		throw new TypeError("not a pack")
	}
	for (let i = 0; i < count.length; i++) {
		const s: Step = {
			device: prev.device,
			n: prev.n + 1,
			before: hash,
			...(typeof node[i] === "string"
				? { node: node[i] as string }
				: { node: own(prev.device) + (node[i] as string[])[0], relative: true }),
			part: part[i] as string,
			patches: all.slice(at, at += count[i]),
			lamport: prev.lamport + lamport[i],
			when: prev.when + when[i],
			...(who[i] !== null && { who: who[i] as string }),
		}
		const b = encodeStep(s)
		out.push(b)
		prev = s, hash = hashStep(b)
	}
	return out
}
