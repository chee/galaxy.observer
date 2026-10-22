// a link over a websocket, either end: a browser's or deno's client, or deno's server side
// (Deno.upgradeWebSocket). sends wait until it is open
//
//   sync.link(socket(new WebSocket("wss://galaxy.example/tippet/pigs")))
import type { Link } from "../sync.ts"

export function socket(ws: WebSocket): Link {
	ws.binaryType = "arraybuffer"
	const waiting: Uint8Array[] = []
	ws.addEventListener("open", () => {
		for (const b of waiting.splice(0)) ws.send(b)
	})
	return {
		send(b) {
			if (ws.readyState === ws.CONNECTING) waiting.push(b)
			else ws.send(b)
		},
		onMessage(fn) {
			ws.addEventListener("message", (e) => {
				if (e.data instanceof ArrayBuffer) fn(new Uint8Array(e.data))
			})
		},
		onClose(fn) {
			ws.addEventListener("close", () => fn())
		},
		close: () => ws.close(),
	}
}
