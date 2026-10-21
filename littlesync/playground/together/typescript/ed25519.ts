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
