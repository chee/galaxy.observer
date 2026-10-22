// a step: one kept write, as it travels. each device numbers its own steps from 1, and each step
// names the hash of the one before it (before), so one signature over a device's latest step vouches
// for all of them. a step is its bytes: canonical cbor, hashed with blake3, never encoded twice
//
//   const bytes = encodeStep({ device, n: 1, before: null, node, part, patches, lamport, when })
//   const step = decodeStep(bytes)
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { blake3 } from "@ermine/blake3"
import type { Patch } from "@ermine/op/apply"

export type Step = {
	// the writer's key, hex
	device: string
	// 1, 2, 3, … per device
	n: number
	// the hash of this device's step n - 1; null at 1
	before: Uint8Array | null
	node: string
	part: string
	patches: readonly Patch[]
	// one more than the highest the writer had seen
	lamport: number
	// whole seconds since 1970, the writer's clock
	when: number
	// who, as the writer's change header said, when it was a string
	who?: string
}

export const encodeStep = (s: Step): Uint8Array => encode(s as unknown as Value)

export function decodeStep(bytes: Uint8Array): Step {
	const s = decode(bytes) as Record<string, unknown>
	const ok = typeof s.device === "string" && Number.isInteger(s.n) && (s.n as number) >= 1 &&
		(s.before === null || s.before instanceof Uint8Array) && typeof s.node === "string" &&
		typeof s.part === "string" && Array.isArray(s.patches) && Number.isInteger(s.lamport) &&
		typeof s.when === "number" && (s.who === undefined || typeof s.who === "string")
	if (!ok) throw new TypeError("not a step")
	return s as unknown as Step
}

export const hashStep = (bytes: Uint8Array): Uint8Array => blake3(bytes)

export const same = (a: Uint8Array | null, b: Uint8Array | null) =>
	a === b || (a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]))

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
