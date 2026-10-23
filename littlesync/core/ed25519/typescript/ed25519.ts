// Ed25519 for ermine, in TS (c/ed25519.h the same in C): a 32-byte secret (an RFC 8032 seed), its
// 32-byte public key, a 64-byte signature. sign and verify go through WebCrypto (every browser, Deno
// and Node have it); verify takes only what strict (below) takes, as the C does, so every device
// takes the same signatures
//
//   const key = await publicKeyOf(secret)
//   const signature = await sign(secret, message)
//   await verify(key, message, signature)     // true | false, never a throw
//
// what an Ed25519 signature must be before the equation is asked, as the C (ed25519.h) has it, so
// every device takes the same ones: S below the group order L; the key (A) and R each in their one
// canonical encoding (y below p, and no sign bit when x is 0); neither of small order. WebCrypto
// checks the equation without the cofactor, as the C does; alone it takes some of these (the
// identity as a key, with R the identity and S 0, is good for every message)

const P = 2n ** 255n - 19n
const L = 2n ** 252n + 27742317777372353535851937790883648493n

// the eight points of small order, each in its canonical encoding: the identity, the point of order
// 2, two of order 4, four of order 8
const SMALL = new Set([
	"0100000000000000000000000000000000000000000000000000000000000000",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0000000000000000000000000000000000000000000000000000000000000080",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
])

// 32 bytes, little-endian
function number(b: Uint8Array): bigint {
	let n = 0n
	for (let i = b.length - 1; i >= 0; i--) n = n * 256n + BigInt(b[i])
	return n
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")

// a point's encoding that is its one canonical one, and not of small order. y is 1 or p - 1 exactly
// when x is 0
function point(b: Uint8Array): boolean {
	if (b.length !== 32) return false
	const sign = b[31] >> 7
	const y = number(Uint8Array.from(b, (x, i) => i === 31 ? x & 0x7f : x))
	if (y >= P) return false
	if (sign === 1 && (y === 1n || y === P - 1n)) return false
	return !SMALL.has(hex(b))
}

// whether a raw signature (R then S, 64 bytes) and raw key may be good at all
export function strict(signature: Uint8Array, key: Uint8Array): boolean {
	if (signature.length !== 64 || key.length !== 32) return false
	if (number(signature.subarray(32)) >= L) return false
	return point(key) && point(signature.subarray(0, 32))
}

// what a seed is wrapped in for WebCrypto to take it (RFC 8410, PKCS#8)
const PKCS8 = Uint8Array.of(
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
)

const imported = (secret: Uint8Array, extractable: boolean) => {
	if (secret.length !== 32) throw new TypeError("an Ed25519 secret is 32 bytes")
	const der = new Uint8Array([...PKCS8, ...secret])
	return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, extractable, ["sign"])
}

// a secret's public key, read from its JWK
export async function publicKeyOf(secret: Uint8Array): Promise<Uint8Array> {
	const x = (await crypto.subtle.exportKey("jwk", await imported(secret, true))).x!
	const b64 = x.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(x.length / 4) * 4, "=")
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

export async function sign(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
	const k = await imported(secret, false)
	return new Uint8Array(await crypto.subtle.sign("Ed25519", k, message.slice()))
}

// whether signature is key's over message: strict first, then the equation
export async function verify(
	key: Uint8Array,
	message: Uint8Array,
	signature: Uint8Array,
): Promise<boolean> {
	if (!strict(signature, key)) return false
	try {
		const k = await crypto.subtle.importKey("raw", key.slice(), { name: "Ed25519" }, false, [
			"verify",
		])
		return await crypto.subtle.verify("Ed25519", k, signature.slice(), message.slice())
	} catch {
		return false
	}
}
