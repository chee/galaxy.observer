// a WebSocket as a Subduction transport (sendBytes, recvBytes, disconnect, onDisconnect): one binary
// message each way per call, as Subduction's own WebSocket client sends them. the gateway dials the
// server with this so it sees the connection drop (Subduction's connectDiscover tells no one), and
// tests serve one with it
import type { Transport } from "npm:@automerge/subduction@0.23.0"

export type Socket = Transport & {
	// closed: by either side, or failed
	gone: Promise<void>
	ws: WebSocket
}

// a WebSocket, open or opening, as a transport. what arrives before a recvBytes waits for it
export function socket(ws: WebSocket): Socket {
	ws.binaryType = "arraybuffer"
	const queue: Uint8Array[] = []
	const waiting: { take: (b: Uint8Array) => void; fail: (e: Error) => void }[] = []
	const fns: (() => void)[] = []
	let done: () => void
	const gone = new Promise<void>((r) => done = r)
	let closed = false
	const close = () => {
		if (closed) return
		closed = true
		for (const w of waiting.splice(0)) w.fail(new Error("socket closed"))
		for (const f of fns) {
			try {
				f()
			} catch { /* theirs */ }
		}
		done()
	}
	ws.addEventListener("message", (e) => {
		if (!(e.data instanceof ArrayBuffer)) return
		const b = new Uint8Array(e.data), w = waiting.shift()
		if (w) w.take(b)
		else queue.push(b)
	})
	ws.addEventListener("close", close)
	ws.addEventListener("error", close)
	const opened = ws.readyState === WebSocket.OPEN
		? Promise.resolve()
		: new Promise<void>((r, j) => {
			ws.addEventListener("open", () => r())
			gone.then(() => j(new Error("socket closed")))
		})
	opened.catch(() => {})
	return {
		ws,
		gone,
		async sendBytes(bytes) {
			await opened
			if (closed || ws.readyState !== WebSocket.OPEN) throw new Error("socket closed")
			ws.send(bytes)
		},
		recvBytes() {
			const b = queue.shift()
			if (b) return Promise.resolve(b)
			if (closed) return Promise.reject(new Error("socket closed"))
			return new Promise((take, fail) => waiting.push({ take, fail }))
		},
		disconnect() {
			try {
				ws.close()
			} catch { /* gone */ }
			close()
			return Promise.resolve()
		},
		onDisconnect(fn) {
			if (closed) fn()
			else fns.push(fn)
		},
	}
}

// a WebSocket to the url, once open; throws when it can't open
export async function dial(url: string): Promise<Socket> {
	const s = socket(new WebSocket(url))
	await new Promise<void>((r, j) => {
		if (s.ws.readyState === WebSocket.OPEN) return r()
		s.ws.addEventListener("open", () => r())
		s.gone.then(() => j(new Error(`${url}: can't open`)))
	})
	return s
}
