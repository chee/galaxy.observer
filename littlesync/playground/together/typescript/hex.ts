// bytes as lowercase hex and back, by table: names are map keys everywhere here, so this is hot
const TO = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"))
const FROM = new Map(TO.map((h, i) => [h, i]))

export function hex(b: Uint8Array): string {
	let s = ""
	for (let i = 0; i < b.length; i++) s += TO[b[i]]
	return s
}

// lowercase hex only, as hex gives
export function unhex(s: string): Uint8Array {
	const out = new Uint8Array(s.length >> 1)
	for (let i = 0; i < out.length; i++) out[i] = FROM.get(s.slice(2 * i, 2 * i + 2)) ?? 0
	return out
}
