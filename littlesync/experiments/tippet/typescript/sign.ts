// a device's key: ed25519, through webcrypto. a device is named by its public key, hex. it signs
// the hash of a run's last step; verify checks that
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

export async function createSigner(
	seed: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): Promise<Signer> {
	if (seed.length !== 32) throw new TypeError("a seed is 32 bytes")
	const der = new Uint8Array([...PKCS8, ...seed])
	const open = await crypto.subtle.importKey("pkcs8", der, "Ed25519", true, ["sign"])
	const pub = b64url((await crypto.subtle.exportKey("jwk", open)).x!)
	const key = await crypto.subtle.importKey("pkcs8", der, "Ed25519", false, ["sign"])
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
