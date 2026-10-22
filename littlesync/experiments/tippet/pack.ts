// pack: a batch's steps, small on the wire. the first step goes whole; each after it is told only by
// what isn't worked out from the one before (its n is one more, its before is the one before's
// hash, its device the same), as columns: each field a run of [value, count, …], numbers as the
// step from the one before, and every patch together as squish's columns. unpack makes each step's
// bytes again exactly, so the chain and the signature are checked as ever: a wrong pack is refused
//
//   const packed = pack(steps); const steps = unpack(packed)
import type { Value } from "@ermine/encoding/cbor"
import { type Columns, decode as patchesOf, encode as columns } from "@ermine/op/squish"
import { decodeStep, encodeStep, hashStep, type Step } from "./step.ts"

export type Packed = {
	first: Uint8Array
	// per step after the first, as runs: lamport and when as steps from the one before; node, part
	// and who (null: none) as they are; how many patches each
	lamport: number[]
	when: number[]
	node: Value[]
	part: Value[]
	who: Value[]
	count: number[]
	patches: Columns
}

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

export function pack(bytes: readonly Uint8Array[]): Packed {
	const steps = bytes.map(decodeStep), rest = steps.slice(1)
	const prev = (i: number) => steps[i]
	return {
		first: bytes[0],
		lamport: runs(rest.map((s, i) => s.lamport - prev(i).lamport)),
		when: runs(rest.map((s, i) => s.when - prev(i).when)),
		node: runs(rest.map((s) => s.node)),
		part: runs(rest.map((s) => s.part)),
		who: runs(rest.map((s) => s.who ?? null)),
		count: runs(rest.map((s) => s.patches.length)),
		patches: columns(rest.flatMap((s) => s.patches)),
	}
}

export function unpack(p: Packed): Uint8Array[] {
	const out = [p.first]
	let prev = decodeStep(p.first), at = 0
	const lamport = unruns(p.lamport),
		when = unruns(p.when),
		node = unruns(p.node),
		part = unruns(p.part),
		who = unruns(p.who),
		count = unruns(p.count)
	const patches = patchesOf(p.patches)
	for (let i = 0; i < count.length; i++) {
		const s: Step = {
			device: prev.device,
			n: prev.n + 1,
			before: hashStep(out[out.length - 1]),
			node: node[i] as string,
			part: part[i] as string,
			patches: patches.slice(at, at += count[i]),
			lamport: prev.lamport + lamport[i],
			when: prev.when + when[i],
			...(who[i] !== null && { who: who[i] as string }),
		}
		out.push(encodeStep(s))
		prev = s
	}
	return out
}
