// one littlesync link (../littlesync.h, links), in TypeScript: a byte stream to one peer, sans-IO as
// the C side's ls_link is. what is said on it and what is known of the peer: hello, up or not, the
// timers (hello again every 2 s while down, every 4 s while up; silent after 8 s). nothing is read or
// written here: feed takes bytes in, next gives the bytes to send, tick is told the time. what a
// message means past hello is the owner's (on); the C device's nodes and merging are not here
import { frame, Unframer } from "./frame.ts"
import { decode, encode, type Message, STACK } from "./wire.ts"

export type Traffic = { framesIn: number; framesOut: number; junk: number }

export class Link {
	up = false
	// the peer's key (a multikey), once it has said hello
	peer: Uint8Array | undefined
	traffic: Traffic = { framesIn: 0, framesOut: 0, junk: 0 }
	#unframer = new Unframer()
	#out: Uint8Array[] = []
	#now = 0
	#heard = 0
	#helloSent = -Infinity

	// key: this side's (a multikey); on: each message but hello, and each hello that starts the
	// peer over (not one answering ours, re), as it arrives
	constructor(
		readonly key: Uint8Array,
		readonly on: (m: Message) => void,
		readonly log: (line: string) => void = () => {},
	) {}

	send(m: Message) {
		this.#out.push(frame(encode(m)))
		this.traffic.framesOut++
	}

	// the bytes to send now, all of them (empty: nothing)
	next(): Uint8Array {
		if (this.#out.length === 0) return new Uint8Array(0)
		const all = new Uint8Array(this.#out.reduce((n, b) => n + b.length, 0))
		let at = 0
		for (const b of this.#out.splice(0)) all.set(b, at), at += b.length
		return all
	}

	#hello(re: boolean) {
		this.#helloSent = this.#now
		this.send({ t: "hello", key: this.key, stack: STACK, ...re && { re: true } })
	}

	// bytes that arrived (any: frames among text, half a frame, nothing); now: the clock tick is told
	feed(bytes: Uint8Array, now = this.#now) {
		this.#now = now
		const before = this.#unframer.junk
		const messages = this.#unframer.feed(bytes)
		this.traffic.junk += this.#unframer.junk - before
		for (const raw of messages) {
			const m = decode(raw)
			if (m === undefined) {
				this.traffic.junk++
				continue
			}
			this.traffic.framesIn++
			if (!this.up && m.t !== "hello") {
				// a peer that thinks we are up: told we are here, it says hello back
				this.up = true
				this.#hello(false)
			}
			this.#heard = now
			if (m.t !== "hello") {
				this.on(m)
				continue
			}
			const was = this.up
			this.peer = m.key
			this.up = true
			if (m.re && was) continue
			// a peer that has begun again knows nothing of ours
			this.#hello(!m.re)
			this.on(m)
		}
	}

	// time has passed: now, a clock that only goes up (ms, any start)
	tick(now: number) {
		this.#now = now
		if (this.up && now - this.#heard > 8000) {
			this.up = false
			this.log("peer silent")
		}
		if (!this.up) {
			if (now - this.#helloSent >= 2000) this.#hello(false)
		} else if (now - this.#helloSent >= 4000) this.#hello(true)
	}
}
