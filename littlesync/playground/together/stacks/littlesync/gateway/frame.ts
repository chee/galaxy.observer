// littlesync's frames (../littlesync.h, wire; ../frame.c), in TypeScript: 0x00, the COBS of ("L",
// one CBOR message, the CRC-32 of the message, 4 bytes little end), 0x00. what does not decode is
// junk. the same bytes as the C side, both ways

// the most bytes between two zeros that are kept (a frame, COBS encoded): frame.h's LS_FRAME_MAX
export const FRAME_MAX = 4608

const TABLE = (() => {
	const t = new Uint32Array(256)
	for (let i = 0; i < 256; i++) {
		let c = i
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		t[i] = c >>> 0
	}
	return t
})()

// the CRC-32 (zlib's), as an unsigned number
export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff
	for (let i = 0; i < data.length; i++) crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
	return (crc ^ 0xffffffff) >>> 0
}

// the COBS of the bytes: no zero in it
export function cobs(data: Uint8Array): Uint8Array {
	const out = new Uint8Array(data.length + Math.ceil(data.length / 254) + 1)
	let at = 1, codeAt = 0, code = 1
	for (let i = 0; i < data.length; i++) {
		if (data[i] === 0) {
			out[codeAt] = code
			codeAt = at++
			code = 1
			continue
		}
		out[at++] = data[i]
		if (++code === 0xff) {
			out[codeAt] = code
			codeAt = at++
			code = 1
		}
	}
	out[codeAt] = code
	return out.slice(0, at)
}

// the bytes back; undefined for what is not COBS
export function uncobs(data: Uint8Array): Uint8Array | undefined {
	const out = new Uint8Array(data.length)
	let at = 0, i = 0
	while (i < data.length) {
		const code = data[i++]
		if (code === 0) return undefined
		const n = code - 1
		if (i + n > data.length) return undefined
		out.set(data.subarray(i, i + n), at)
		at += n, i += n
		if (code !== 0xff && i < data.length) out[at++] = 0
	}
	return out.slice(0, at)
}

// a frame for the message, zeros on both sides
export function frame(message: Uint8Array): Uint8Array {
	const plain = new Uint8Array(message.length + 5)
	plain[0] = 0x4c // "L"
	plain.set(message, 1)
	new DataView(plain.buffer).setUint32(1 + message.length, crc32(message), true)
	const c = cobs(plain)
	const out = new Uint8Array(c.length + 2)
	out.set(c, 1)
	return out
}

// the message in a frame's bytes (between the zeros), or undefined: no "L", a bad CRC, not COBS
export function unframe(data: Uint8Array): Uint8Array | undefined {
	const plain = uncobs(data)
	if (plain === undefined || plain.length < 6 || plain[0] !== 0x4c) return undefined
	const m = plain.length - 5
	const crc = new DataView(plain.buffer, plain.byteOffset).getUint32(1 + m, true)
	const message = plain.subarray(1, 1 + m)
	return crc === crc32(message) ? message : undefined
}

// frames out of a byte stream that may carry other text too: feed gives the messages the bytes
// end, in order; junk counts what came between zeros and was no frame (or was over FRAME_MAX)
export class Unframer {
	junk = 0
	#rx = new Uint8Array(FRAME_MAX)
	#n = 0
	#over = false

	feed(bytes: Uint8Array): Uint8Array[] {
		const out: Uint8Array[] = []
		for (let i = 0; i < bytes.length; i++) {
			const b = bytes[i]
			if (b !== 0) {
				if (this.#n < FRAME_MAX) this.#rx[this.#n++] = b
				else this.#over = true
				continue
			}
			if (this.#n > 0) {
				const m = this.#over ? undefined : unframe(this.#rx.subarray(0, this.#n))
				if (m !== undefined) out.push(m.slice())
				else this.junk++
			}
			this.#n = 0
			this.#over = false
		}
		return out
	}
}
