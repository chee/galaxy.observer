// a commit signed by the device that made it, and the id it is stored under (extensions/subduction/
// plan.org, Rewrite for the new shape, 2). sealed: {commit: its bytes, signature}, the signer's key
// once (it is in the commit). signed: "ermine/v0/commit", the document's 32 bytes (the ermine://
// id's), the signature's varsig header, then the commit's name, so a seal is good in its document
// only (nothing of the document goes in the seal: the document is where it came, a sedimentree),
// and a header put on another signature is no longer good (the varsig spec recommends the header
// be in what is signed). the signature is self-describing: a varsig header, then the raw signature.
// the commit's signer is a multikey (commit.ts). Ed25519 through WebCrypto, which every browser, Deno and Node have: a key made here
// never leaves as bytes; others by a verifier a caller adds
import { blake3 } from "npm:@noble/hashes@1.8.0/blake3"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, decode, joinKey, name as nameOf, splitKey } from "@ermine/encoding/commit"
import { strict } from "./ed25519.ts"

// key: the device's multikey; header: the varsig header its signatures begin with; sign: the raw
// signature of the message, without the header
export type Signer = {
	key: Uint8Array
	header: Uint8Array
	sign(message: Uint8Array): Promise<Uint8Array>
}

// a signature algorithm a seal can be checked with: the varsig header it is found by (a signature
// begins with exactly these bytes), the multicodec code its keys must have, how many bytes of
// signature follow the header, and the check, given the raw key
export type Verifier = {
	header: Uint8Array
	code: number
	size: number
	verify(signature: Uint8Array, key: Uint8Array, message: Uint8Array): Promise<boolean>
}

export type Code = "shape" | "signature"

export class SealError extends Error {
	constructor(readonly code: Code, readonly reason?: string) {
		super(reason === undefined ? code : `${code} (${reason})`)
	}
}

// Ed25519: the multicodec code of ed25519-pub (0xed, varint 0xed 0x01), and the varsig (v1, the
// version UCAN 1.0 uses) header: 0x34 0x01 (varsig, version 1), then EdDSA 0xed 0x01 with its curve
// 0xed 0x01 (ed25519-pub) and its hash 0x13 (sha2-512; RFC 8032), then the payload encoding 0x5f
// (byte-identical): what is signed is our own bytes ("ermine/v0/commit" then a name), no DAG-CBOR
// (0x71) or other codec to render, so the one that says the payload is used as it is
export const ED25519 = 0xed
const ED25519_HEADER = Uint8Array.from([0x34, 0x01, 0xed, 0x01, 0xed, 0x01, 0x13, 0x5f])

// a multikey of an Ed25519 key, from its 32 raw bytes
export const ed25519Key = (raw: Uint8Array) => joinKey(ED25519, raw)

const DOMAIN = new TextEncoder().encode("ermine/v0/commit")
// what a seed is wrapped in for WebCrypto to take it (RFC 8410, PKCS#8)
const PKCS8 = Uint8Array.from([
	0x30,
	0x2e,
	0x02,
	0x01,
	0x00,
	0x30,
	0x05,
	0x06,
	0x03,
	0x2b,
	0x65,
	0x70,
	0x04,
	0x22,
	0x04,
	0x20,
])

// what is signed: the domain, the document's bytes, the signature's header, the commit's name (a
// header tells its own length, as a name does)
const message = (doc: Uint8Array, header: Uint8Array, name: Uint8Array) => {
	if (doc.length !== 32) throw new SealError("shape")
	const m = new Uint8Array(DOMAIN.length + 32 + header.length + name.length)
	m.set(DOMAIN)
	m.set(doc, DOMAIN.length)
	m.set(header, DOMAIN.length + 32)
	m.set(name, DOMAIN.length + 32 + header.length)
	return m
}

const unbase64url = (s: string) =>
	Uint8Array.from(
		atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")),
		(c) => c.charCodeAt(0),
	)

// a signer: from a 32-byte seed (the same key on every run), or a new key that cannot be exported
export async function createSigner(seed?: Uint8Array): Promise<Signer> {
	let privateKey: CryptoKey, key: Uint8Array
	if (seed === undefined) {
		const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
			"sign",
			"verify",
		]) as CryptoKeyPair
		privateKey = pair.privateKey
		key = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
	} else {
		if (seed.length !== 32) throw new SealError("shape")
		const der = new Uint8Array(PKCS8.length + 32)
		der.set(PKCS8)
		der.set(seed, PKCS8.length)
		// its public half from its JWK, then the private half made again, not exportable
		const open = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"])
		key = unbase64url((await crypto.subtle.exportKey("jwk", open)).x!)
		privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"])
	}
	return {
		key: ed25519Key(key),
		header: ED25519_HEADER,
		sign: async (m) => new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, m.slice())),
	}
}

// the keys imported, and the signatures found good, the oldest let go of past CACHED: a seal is
// checked again as it is stored, taken in, and handed on, and one signer signs most of what comes
const CACHED = 4096
const keys = new Map<string, Promise<CryptoKey>>()
const checked = new Set<string>()
const cache = <T>(m: Map<string, T> | Set<string>, k: string) => {
	if (m.size >= CACHED) m.delete(m.keys().next().value!)
	return k
}

// the raw signature good for this raw key and message, checked strictly (ed25519.ts)
export async function good(
	signature: Uint8Array,
	key: Uint8Array,
	m: Uint8Array,
): Promise<boolean> {
	if (!strict(signature, key)) return false
	const seen = hex(blake3(Uint8Array.from([...key, ...signature, ...m])))
	if (checked.has(seen)) return true
	try {
		const kh = hex(key)
		let k = keys.get(kh)
		if (k === undefined) {
			k = crypto.subtle.importKey("raw", key.slice(), { name: "Ed25519" }, false, ["verify"])
			keys.set(cache(keys, kh), k)
			k.catch(() => keys.delete(kh))
		}
		const ok = await crypto.subtle.verify("Ed25519", await k, signature.slice(), m.slice())
		if (ok) checked.add(cache(checked, seen))
		return ok
	} catch {
		return false
	}
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// the built in: Ed25519 only
export const verifiers: readonly Verifier[] = [
	{ header: ED25519_HEADER, code: ED25519, size: 64, verify: good },
]

// the sealed commit's bytes, for the document (its 32 bytes). the commit's signer must be this
// signer's key. made: its name, and its commit, from whoever just made it: not decoded or named
// again; given a name and no commit, the caller vouches that its signer is this one (a device sealing
// its own)
export async function seal(
	bytes: Uint8Array,
	signer: Signer,
	doc: Uint8Array,
	made?: { commit?: Commit; name: Uint8Array },
): Promise<Uint8Array> {
	const commit = made ? made.commit : decode(bytes)
	if (commit && !same(commit.signer, signer.key)) throw new SealError("signature")
	const raw = await signer.sign(message(doc, signer.header, made?.name ?? nameOf(bytes)))
	if (!(raw instanceof Uint8Array) || raw.length === 0) throw new SealError("shape")
	const signature = new Uint8Array(signer.header.length + raw.length)
	signature.set(signer.header)
	signature.set(raw, signer.header.length)
	return cbor.encode({ commit: bytes, signature })
}

export type Unsealed = { commit: Commit; bytes: Uint8Array; name: Uint8Array; stored: Uint8Array }

// the commit, checked: its shape, and its signer's signature for the document (its 32 bytes), by
// the verifier whose header the signature begins with: the built in, then more (a caller's). no
// verifier for the header, or one whose key type is not the signer's: refused as a signature not
// good, with the reason
export async function unseal(
	sealed: Uint8Array,
	doc: Uint8Array,
	more: readonly Verifier[] = [],
): Promise<Unsealed> {
	let x: unknown
	try {
		x = cbor.decode(sealed)
	} catch {
		throw new SealError("shape")
	}
	if (x === null || typeof x !== "object" || Array.isArray(x)) throw new SealError("shape")
	const o = x as Record<string, unknown>
	if (Object.keys(o).length !== 2 || !(o.commit instanceof Uint8Array)) {
		throw new SealError("shape")
	}
	const signature = o.signature
	if (!(signature instanceof Uint8Array)) throw new SealError("shape")
	let commit: Commit
	try {
		commit = decode(o.commit)
	} catch {
		throw new SealError("shape")
	}
	const name = nameOf(o.commit)
	const v = [...verifiers, ...more].find((v) => startsWith(signature, v.header))
	if (v === undefined) throw new SealError("signature", "no verifier for this signature header")
	const key = splitKey(commit.signer)!
	if (key.code !== v.code) {
		throw new SealError("signature", "the header and the signer's key differ")
	}
	if (signature.length !== v.header.length + v.size) throw new SealError("shape")
	if (
		!(await v.verify(signature.subarray(v.header.length), key.key, message(doc, v.header, name)))
	) {
		throw new SealError("signature")
	}
	return { commit, bytes: o.commit, name, stored: stored(sealed) }
}

// the id a sealed commit is stored under: the BLAKE3 hash of its sealed bytes
export function stored(sealed: Uint8Array): Uint8Array {
	return blake3(sealed)
}

// how many bytes of a signature are its varsig header: 0x34 0x01, an algorithm of those varsig names
// (BLS, ECDSA, EdDSA, RSA: each with two segments after it), then the payload encoding (raw,
// DAG-CBOR, DAG-JSON); 0 for any other, which is no header this reads
export function headerLength(signature: Uint8Array): number {
	let at = 0
	const varint = () => {
		let n = 0, scale = 1
		for (let k = 0; k < 7; k++) {
			if (at >= signature.length) return -1
			const byte = signature[at++]
			n += (byte & 0x7f) * scale
			if (byte < 0x80) return n
			scale *= 0x80
		}
		return -1
	}
	if (signature[0] !== 0x34 || signature[1] !== 0x01) return 0
	at = 2
	const algorithm = varint()
	if (![0xb1, 0xec, 0xed, 0x1205].includes(algorithm) || varint() < 0 || varint() < 0) return 0
	return [0x5f, 0x71, 0x0129].includes(varint()) ? at : 0
}

const startsWith = (a: Uint8Array, b: Uint8Array) =>
	a.length >= b.length && b.every((x, i) => a[i] === x)

const same = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((x, i) => x === b[i])
