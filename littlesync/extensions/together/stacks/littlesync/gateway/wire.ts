// littlesync's messages (../littlesync.h, wire): CBOR maps with "t". read as the C side reads them:
// a field of the wrong kind makes the message nothing (dropped); a name is 34 bytes (a BLAKE3
// multihash), a node 32, a key 34 (an Ed25519 multikey)
import * as cbor from "@ermine/encoding/cbor"

export const STACK = "littlesync/0"
// the merge rule an older littlesync commit with several parents named (littlesync now names none:
// each patch says what it replaces, values.org)
export const MERGE = "littlesync/lww-path"
export const NAME = 34
export const KEY = 34
// a held value goes after this long without a beat; a device beats this often (LS_HELD_MS, LS_BEAT_MS)
export const HELD_MS = 4000
export const BEAT_MS = 1000

export type Message =
	| { t: "hello"; key: Uint8Array; stack: string; re?: boolean }
	| { t: "heads"; node: Uint8Array; heads: Uint8Array[]; re?: boolean }
	| { t: "want"; node: Uint8Array; names: Uint8Array[] }
	| { t: "commits"; node: Uint8Array; sealed: Uint8Array[] }
	| { t: "ephemeral"; node: Uint8Array; commit: Uint8Array }
	| { t: "ack"; node: Uint8Array; names: Uint8Array[] }
	// a presence row: presence.ts's message (CBOR, {ttl, value} or {gone: true}) as its channel sends
	// it on the topic "ermine://<node's hex>", and who sent it (a key, as the C side takes it: 1 to 34 bytes)
	| { t: "presence"; node: Uint8Array; who: Uint8Array; row: Uint8Array }

export function encode(m: Message): Uint8Array {
	const o: Record<string, cbor.Value> = {}
	for (const [k, v] of Object.entries(m)) if (v !== undefined && v !== false) o[k] = v
	return cbor.encode(o)
}

const isBytes = (x: unknown, n?: number): x is Uint8Array =>
	x instanceof Uint8Array && (n === undefined || x.length === n)
// a list of names: what is not a name in it is left out (the C side skips those)
const names = (x: unknown) =>
	Array.isArray(x) ? x.filter((n): n is Uint8Array => isBytes(n, NAME)) : undefined

// the message, or undefined: not CBOR, not a map with t, or a field not as the wire has it
export function decode(bytes: Uint8Array): Message | undefined {
	let x: unknown
	try {
		x = cbor.decode(bytes)
	} catch {
		return undefined
	}
	if (x === null || typeof x !== "object" || Array.isArray(x) || ArrayBuffer.isView(x)) return
	const o = x as Record<string, unknown>
	const re = o.re === true ? { re: true } : {}
	switch (o.t) {
		case "hello":
			if (!isBytes(o.key, KEY) || typeof o.stack !== "string") return
			if (!o.stack.startsWith("littlesync/")) return
			return { t: "hello", key: o.key, stack: o.stack, ...re }
	}
	if (typeof o.t !== "string" || !isBytes(o.node, 32)) return
	const node = o.node
	switch (o.t) {
		case "heads": {
			const heads = names(o.heads)
			return heads && { t: "heads", node, heads, ...re }
		}
		case "want":
		case "ack": {
			const list = names(o.names)
			return list && { t: o.t, node, names: list }
		}
		case "commits": {
			if (!Array.isArray(o.sealed)) return
			return { t: "commits", node, sealed: o.sealed.filter((s) => isBytes(s)) }
		}
		case "ephemeral":
			return isBytes(o.commit) ? { t: "ephemeral", node, commit: o.commit } : undefined
		case "presence":
			if (!isBytes(o.who) || o.who.length === 0 || o.who.length > KEY || !isBytes(o.row)) return
			return { t: "presence", node, who: o.who, row: o.row }
	}
}

// a seal's commit name and its commit's bytes, unchecked (the C side's peek_name)
export function peek(sealed: Uint8Array): Uint8Array | undefined {
	try {
		const x = cbor.decode(sealed) as Record<string, unknown>
		return x !== null && typeof x === "object" && x.commit instanceof Uint8Array
			? x.commit
			: undefined
	} catch {
		return undefined
	}
}
