// a device's key: ed25519, through webcrypto. a device is named by its public key, hex. what it
// signs is the hash of its latest step, so one signature covers every step before it
//
//   const me = await createSigner(seed)   // seed: 32 bytes, the same device every run; none: new
//   const sig = await me.sign(hash)
//   await verify(me.device, hash, sig)
import { hex, unhex } from "./step.ts"

export type Signer = { device: string; sign: (m: Uint8Array) => Promise<Uint8Array> }

// pkcs8's wrapping of a raw ed25519 seed
const PKCS8 = unhex("302e020100300506032b657004220420")

const b64url = (s: string) =>
	Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))

export async function createSigner(seed?: Uint8Array): Promise<Signer> {
	let key: CryptoKey, pub: Uint8Array
	if (seed === undefined) {
		const pair = await crypto.subtle.generateKey("Ed25519", false, [
			"sign",
			"verify",
		]) as CryptoKeyPair
		key = pair.privateKey
		pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
	} else {
		if (seed.length !== 32) throw new TypeError("a seed is 32 bytes")
		const der = new Uint8Array([...PKCS8, ...seed])
		const open = await crypto.subtle.importKey("pkcs8", der, "Ed25519", true, ["sign"])
		pub = b64url((await crypto.subtle.exportKey("jwk", open)).x!)
		key = await crypto.subtle.importKey("pkcs8", der, "Ed25519", false, ["sign"])
	}
	return {
		device: hex(pub),
		sign: async (m) => new Uint8Array(await crypto.subtle.sign("Ed25519", key, m.slice())),
	}
}

const keys = new Map<string, CryptoKey>()

// keys checked lately, at most 1024 (the oldest let go first); only good ones are kept
export async function verify(device: string, m: Uint8Array, sig: Uint8Array): Promise<boolean> {
	if (!/^[0-9a-f]{64}$/.test(device) || sig.length !== 64) return false
	try {
		let k = keys.get(device)
		if (k === undefined) {
			k = await crypto.subtle.importKey("raw", unhex(device), "Ed25519", false, ["verify"])
			keys.set(device, k)
			if (keys.size > 1024) keys.delete(keys.keys().next().value!)
		}
		return await crypto.subtle.verify("Ed25519", k, sig.slice(), m.slice())
	} catch {
		return false
	}
}
