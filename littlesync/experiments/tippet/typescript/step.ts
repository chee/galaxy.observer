// a step: one kept write, as it travels (WIRE.md, step). a step is its bytes: encodeStep makes
// them once, decodeStep reads them back and throws on anything that isn't one, hashStep names them
//
//   const bytes = encodeStep({ device, n: 1, before: null, node, part, patches, lamport, when })
//   const step = decodeStep(bytes)
import { decode, encode, type Value } from "@ermine/encoding/cbor"
import { blake3 } from "@ermine/blake3"
import type { Patch } from "@ermine/op/apply"

export type Step = {
	// the writer's key, hex here, its 32 bytes on the wire
	device: string
	// 1, 2, 3, … per device
	n: number
	// the hash of this device's step n - 1; null at 1
	before: Uint8Array | null
	// the node's id, whole. relative: written as the rest after the device's own id (ermine:ed01 +
	// its key's hex), node being that id or under it (WIRE.md, step)
	node: string
	relative?: boolean
	part: string
	patches: readonly Patch[]
	// one more than the highest the writer had seen; a whole number, as are n and when
	lamport: number
	// whole seconds since 1970, the writer's clock
	when: number
	// who, as the writer's change header said, when it was a string
	who?: string
}

const KEY = /^[0-9a-f]{64}$/

// a device's own id, as text (ermine/ids: key)
export const own = (device: string) => `ermine:ed01${device}`
// what follows the device's own id in node, when node is that id or under it ("" or "/…")
export function rest(device: string, node: string): string | undefined {
	const id = own(device)
	if (!node.startsWith(id)) return
	const r = node.slice(id.length)
	return r === "" || r[0] === "/" ? r : undefined
}
// the node as written: its id, or [the rest] when relative
export function written(s: Step): Value {
	if (!s.relative) return s.node
	const r = rest(s.device, s.node)
	if (r === undefined) throw new TypeError("not a node relative to its device")
	return [r]
}

// a step's bytes; a device that isn't a key, or a node relative that isn't under it, throws
export function encodeStep(s: Step): Uint8Array {
	if (!KEY.test(s.device)) throw new TypeError("not a device")
	const a = [unhex(s.device), s.n, s.before, written(s), s.part, s.patches, s.lamport, s.when]
	if (s.who !== undefined) a.push(s.who)
	return encode(a as Value)
}

export const whole = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0
export const key = (x: unknown): x is Uint8Array => x instanceof Uint8Array && x.length === 32
const only = (o: object, keys: string[]) => Object.keys(o).every((k) => keys.includes(k))
const isMap = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x) && !ArrayBuffer.isView(x)
// a place: a path of names and whole numbers, and maybe a range, two whole numbers
const target = (t: Record<string, unknown>) =>
	Array.isArray(t.path) && t.path.every((k) => typeof k === "string" || whole(k)) &&
	(t.range === undefined ||
		(Array.isArray(t.range) && t.range.length === 2 && t.range.every(whole)))
const patch = (p: unknown) =>
	isMap(p) && only(p, ["path", "range", "value", "move"]) && target(p) &&
	(p.move === undefined || (isMap(p.move) && only(p.move, ["path", "range"]) && target(p.move)))

// a node relative to the device: [rest], rest "" or "/…"
const relative = (x: unknown): x is [string] =>
	Array.isArray(x) && x.length === 1 && typeof x[0] === "string" &&
	(x[0] === "" || x[0][0] === "/")

// a step, only as tippet writes one: eight elements, or nine with who, each of its kind, every
// number whole, so it packs and unpacks to the same bytes. anything else throws
export function decodeStep(bytes: Uint8Array): Step {
	const a = decode(bytes)
	if (
		!Array.isArray(a) || !(a.length === 8 || (a.length === 9 && typeof a[8] === "string")) ||
		!key(a[0]) || !whole(a[1]) || a[1] < 1 || !(a[2] === null || key(a[2])) ||
		!(typeof a[3] === "string" || relative(a[3])) || typeof a[4] !== "string" ||
		!Array.isArray(a[5]) ||
		!a[5].every(patch) || !whole(a[6]) || !whole(a[7])
	) throw new TypeError("not a step")
	const [device, n, before, node, part, patches, lamport, when, who] = a
	const d = hex(device)
	const s: Step = typeof node === "string"
		? { device: d, n, before, node, part, patches, lamport, when }
		: {
			device: d,
			n,
			before,
			node: own(d) + node[0],
			relative: true,
			part,
			patches,
			lamport,
			when,
		}
	if (who !== undefined) s.who = who
	return s
}

export const hashStep = (bytes: Uint8Array): Uint8Array => blake3(bytes)

export const same = (a: Uint8Array | null, b: Uint8Array | null) =>
	a === b || (a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]))

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))
