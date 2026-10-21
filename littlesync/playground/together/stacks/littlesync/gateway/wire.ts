// littlesync's messages (../littlesync.h, wire): CBOR maps with "t". read as the C side reads them:
// a field of the wrong kind makes the message nothing (dropped); a name is 34 bytes (a BLAKE3
// multihash), a node an id as text (its UTF-8 at most ID_LEN bytes; for now an ermine id, of any
// kind: ermine/ids, which nodes sync being sync's own question), a key 34 (an Ed25519 multikey)
import * as cbor from "@ermine/encoding/cbor"
import { kind } from "@ermine/ids"

export const STACK = "littlesync/0"
// the merge rule an older littlesync commit with several parents named (littlesync now names none:
// each patch says what it replaces, values.org)
export const MERGE = "littlesync/lww-path"
export const NAME = 34
// a node's id at most, in bytes (UTF-8, LS_ID_LEN): littlesync refuses a longer one
export const ID_LEN = 128
export const KEY = 34
// a held value goes after this long without a beat; a device beats this often (LS_HELD_MS, LS_BEAT_MS)
export const HELD_MS = 4000
export const BEAT_MS = 1000
// a message's topic at most, in bytes (UTF-8, LS_TOPIC_MAX); its bytes at most by default (LS_MESSAGE)
export const TOPIC_MAX = 256
export const MESSAGE = 4096
// the most a seal adds to a message's bytes (LS_SEALED): {bytes, signer, signature} around them
export const SEALED = 160

export type Message =
	| { t: "hello"; key: Uint8Array; stack: string; re?: boolean }
	| { t: "heads"; node: string; heads: Uint8Array[]; re?: boolean }
	| { t: "want"; node: string; names: Uint8Array[] }
	| { t: "commits"; node: string; sealed: Uint8Array[] }
	| { t: "ephemeral"; node: string; commit: Uint8Array }
	| { t: "ack"; node: string; names: Uint8Array[] }
	// the topics the sender wants sent to it (all: every one), the whole list each time
	| { t: "listen"; topics: string[]; all?: boolean }
	// a short-lived message: bytes on a topic (presence.ts's channel's: a presence row on a room's),
	// sealed by who said them (seal.ts's sealMessage: the signer is in the bytes)
	| { t: "say"; topic: string; bytes: Uint8Array }

export function encode(m: Message): Uint8Array {
	const o: Record<string, cbor.Value> = {}
	for (const [k, v] of Object.entries(m)) if (v !== undefined && v !== false) o[k] = v
	return cbor.encode(o)
}

const isBytes = (x: unknown, n?: number): x is Uint8Array =>
	x instanceof Uint8Array && (n === undefined || x.length === n)
const utf8 = new TextEncoder()
export const isTopic = (x: unknown): x is string =>
	typeof x === "string" && x.length > 0 && !x.includes("\0") && utf8.encode(x).length <= TOPIC_MAX
// a node's id: well-formed text of at most ID_LEN bytes, and for now an ermine id
export const isNode = (x: unknown): x is string =>
	typeof x === "string" && x.isWellFormed() && utf8.encode(x).length <= ID_LEN &&
	kind(x) !== undefined
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
		case "listen": {
			if (!Array.isArray(o.topics) && o.all !== true) return
			const topics = Array.isArray(o.topics) ? [...new Set(o.topics.filter(isTopic))] : []
			return { t: "listen", topics, ...o.all === true && { all: true } }
		}
		case "say":
			if (!isTopic(o.topic) || !isBytes(o.bytes)) return
			return { t: "say", topic: o.topic, bytes: o.bytes }
	}
	if (typeof o.t !== "string" || !isNode(o.node)) return
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
