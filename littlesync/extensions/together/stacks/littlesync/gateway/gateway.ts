// the gateway (../../../../../../ermine-plans/extensions/together/bridge.org): littlesync devices in
// rooms on a Subduction server. each littlesync link (link.ts) is one device; inside, one together
// device (the mailroom and the subduction stack, memory storage) is a Subduction peer of the server.
// nothing of its own is stored: the server holds everything, and a node is pulled again when a
// device names it after a start.
//
//   device → room   each seal a device sends: unsealed (seal.ts: its signature, in its node), then
//                   through a history (history.ts: its parents here, its lamport 1 + their highest),
//                   then the stack. refused: logged with the reason, counted, not forwarded (still
//                   acked, so the device stops resending it)
//   room → device   every commit of a node the device names (heads, want, commits, ephemeral), as
//                   its seal, until the device acks it (littlesync refuses what it can't merge and
//                   acks that too). a commit held with no seal (vouched in a fragment's pack) can't go:
//                   logged, counted
//   ephemerals      a device's {node, commit} is made again as an ephemeral commit of the gateway's
//                   own (the server relays an ephemeral payload under its sender's key, and the
//                   mailroom takes one only when its signer is the sender): the same table and
//                   patches, on the node's first head, metadata {littlesync: the device's key}; a beat
//                   again sends it again; a new one replaces it; a stop goes when the device's next
//                   stored commit there lands, or after HELD_MS with no beat. one heard from the room
//                   goes to each device naming the node as it came, then is let go of here
//   presence        a row (presence.ts's message, the bytes as they came) goes both ways unchanged,
//                   on the topic "ermine://<node's hex>". room → device: each row heard on the topic
//                   of a node a device names, with its sender's key as who. device → room: the server
//                   relays an ephemeral under its publisher's key, and presence names a row by it, so
//                   each device key (who) gets a Subduction peer of its own here, a key made for it
//                   (its rows' name in the room), connected as the upstream is (keep's dial, connect's
//                   url, or options.peer), let go of PEER_IDLE ms after its last row; rows heard back
//                   from those keys are not sent down again. also on to the other devices naming the
//                   node, as it came (the C side relays so)
//   upstream        kept (keep): a lost connection is dialled again, a while longer between tries
//                   each time; once made, the followed nodes are subscribed and fetched again and the
//                   ephemeral topics subscribed again (the stack's connect). while there is none, a
//                   device's commits are taken and put here but not acked: acked once it is back, so
//                   a device keeps the ones the server may lack until then
//   merges          a commit by a merge rule (an older littlesync write with several parents named
//                   "littlesync/lww-path"; littlesync now writes neither base nor merge, each patch
//                   saying what it replaces): the history and mailroom here take it as any commit (they
//                   check no merge rule: that is sync.ts's check, which this has none of), so it is
//                   forwarded; a sync.ts device refuses it ("merge") and every commit on it
//                   ("parent"). each one is logged and counted, both ways
//
// composed as transport.ts's createDevice composes a device (mailroom, then the subduction stack), so
// that two things createDevice keeps inside are reachable: a taken-in commit's seal (the mailroom's
// documents), and a seal from elsewhere put to the stack as a loose commit (the stack's inside.put)
import type * as sd from "npm:@automerge/subduction@0.23.0"
import * as cbor from "@ermine/encoding/cbor"
import { type Commit, decode, encode, name as nameOf } from "@ermine/encoding/commit"
import { createMailroom, LIMITS } from "../../../typescript/mailroom.ts"
import { createSubduction, JOINING } from "../../subduction/typescript/subduction.ts"
import { createHistory, type History, type Kept } from "../../../typescript/history.ts"
import { createSigner, type Signer, stored, unseal } from "../../../typescript/seal.ts"
import { hex, unhex } from "../../../typescript/hex.ts"
import type { Device } from "../../../typescript/transport.ts"
import type { Socket } from "./socket.ts"
import { Link } from "./link.ts"
import { FRAME_MAX } from "./frame.ts"
import { HELD_MS, MERGE, type Message, peek } from "./wire.ts"

// seals in one commits message, about (the C side's CHUNK); one seal over SEAL_MAX makes a frame
// over FRAME_MAX, which the device drops
const CHUNK = 3000
const SEAL_MAX = FRAME_MAX - 200
// a commit not acked is sent again after RESEND ms, at most TRIES times
const RESEND = 3000
const TRIES = 5
// device commits waiting on a parent, per node; refusals kept to read
const WAITING = 1024
const REFUSALS = 256
// the upstream dialled again after FIRST ms, then twice as long each time up to MOST; a dial (and its
// handshake) given up after DIAL ms
const FIRST = 500
const MOST = 30000
const DIAL = 20000
// a device's presence peer let go of this long after its last row (a row is renewed every 2 s, lasts 6)
const PEER_IDLE = 10000

export type Refusal = { node: string; name: string; from: string; reason: string }

export type Stats = {
	links: number
	// device → room: seals in, put to the stack, refused by reason, waiting on a parent now
	in: number
	forwarded: number
	refused: Record<string, number>
	waiting: number
	// room → device: seals sent (resends too), commits held with no seal, seals too big for a frame
	out: number
	unsealed: number
	big: number
	// merge commits seen in the gateway path, by rule; from devices, from the room
	merges: { device: number; room: number; rules: Record<string, number> }
	ephemeral: { in: number; out: number; stops: number }
	// presence rows: from devices, to devices; device keys with a peer of their own upstream now
	presence: { in: number; out: number; peers: number }
	// the server: connected now, connections made, connections lost, acks held while there is none
	upstream: { up: boolean; connects: number; drops: number; held: number }
}

export type Conn = {
	// bytes that arrived on the link
	feed(bytes: Uint8Array): void
	// the link closed: its holds stop
	close(): void
	link: Link
	// the nodes the device names
	follows: Set<string>
}

export type Gateway = {
	device: Device
	stats: Stats
	refusals: Refusal[]
	// a littlesync link: send is given the bytes to write to it
	open(send: (bytes: Uint8Array) => void): Conn
	// timers: hellos, resends, holds that stopped beating. call it every few tens of ms
	tick(): void
	// the server once: by url (connectDiscover), or a transport; not made again when lost (keep is)
	connect(url: string, service?: string): Promise<void>
	connectTransport(transport: sd.Transport, initiator: boolean): Promise<void>
	// the server, kept: dial gives a new connection each time (socket.ts's dial, say); dialled again
	// when it drops or fails. gives back the stop (the connection now is closed too; close stops it)
	keep(dial: () => Promise<Socket>): () => void
	// the nodes followed upstream
	followed(): string[]
	// nothing queued in the device, nothing being handled
	idle(): Promise<void>
	close(): Promise<void>
}

type Node = {
	id: string
	bytes: Uint8Array
	// the history check device commits go through first: every commit the device's stored history
	// takes is added here too, so it holds what the room holds and what was forwarded
	check: History
	// device seals waiting here on a parent, by name
	waiting: Map<string, { sealed: Uint8Array; from: string }>
	// device seals forwarded, by name: their stored ids (the mailroom names them once taken in)
	forwarded: Map<string, string>
	// names logged once: with no seal, too big
	told: Set<string>
}

type Hold = { from: string; made: Uint8Array; table: string; signer: string; last: number }

type State = {
	conn: Conn
	send: (bytes: Uint8Array) => void
	closed: boolean
	// per node: the commits sent to it (ms, tries) and those it has (acked, or named in its heads)
	sent: Map<string, Map<string, { at: number; tries: number }>>
	acked: Map<string, Set<string>>
	holds: Map<string, Hold>
	// names taken from it while there was no upstream, by node: acked once there is one
	unacked: Map<string, Set<string>>
}

const short = (s: string) => s.replace(/^ermine:\/\//, "").slice(0, 8)

export function createGateway(options: {
	signer: Signer
	log?: (line: string) => void
	now?: () => number
	storage?: sd.SedimentreeStorage
	// the server's service name, for keep's connections (connectTransport's too); default "ermine"
	service?: string
	// how a device's presence peer reaches the server (it connects as connect is given); default
	// keep's dial, or connect's url. none of these: device rows go to other devices only
	peer?: (connect: (transport: sd.Transport, initiator: boolean) => Promise<void>) => Promise<void>
}): Gateway {
	const now = options.now ?? Date.now
	const log = options.log ?? ((line: string) => console.log(line))
	const limits = { ...LIMITS, ...JOINING }
	const mailroom = createMailroom({ signer: options.signer, limits })
	const wired = createSubduction(mailroom, {
		signer: options.signer,
		storage: options.storage,
		service: options.service,
		limits,
	})
	const device: Device = { ...mailroom.device, ...wired.device }

	const stats: Stats = {
		links: 0,
		in: 0,
		forwarded: 0,
		refused: {},
		waiting: 0,
		out: 0,
		unsealed: 0,
		big: 0,
		merges: { device: 0, room: 0, rules: {} },
		ephemeral: { in: 0, out: 0, stops: 0 },
		presence: { in: 0, out: 0, peers: 0 },
		upstream: { up: false, connects: 0, drops: 0, held: 0 },
	}
	const refusals: Refusal[] = []
	const nodes = new Map<string, Node>()
	const states = new Set<State>()
	let nonce = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1
	// what devices say is handled one message at a time, in order (unsealing is async)
	let chain: Promise<void> = Promise.resolve()
	let busy = 0
	const serial = (f: () => Promise<void> | void) => {
		busy++
		chain = chain.then(f).catch((e) => log(`gateway: ${e?.stack ?? e}`)).finally(() =>
			void busy--
		)
	}

	// ---- nodes

	function nodeOf(id: string): Node {
		let n = nodes.get(id)
		if (n) return n
		const check = createHistory(() => true, { most: WAITING })
		n = {
			id,
			bytes: unhex(id.slice(9)),
			check,
			waiting: new Map(),
			forwarded: new Map(),
			told: new Set(),
		}
		nodes.set(id, n)
		const node = n
		const history = device.history(id)
		for (const k of history.all()) check.add(k.bytes)
		history.taken((k) => void check.add(k.bytes))
		// a device seal that waited here on a parent, let in: forwarded
		check.taken((k) => {
			const w = node.waiting.get(hex(k.name))
			if (w === undefined) return
			node.waiting.delete(hex(k.name))
			stats.waiting--
			serial(() => forward(node, k, w.sealed))
		})
		log(`follow ${short(id)}`)
		device.follow(id).catch((e) => log(`follow ${short(id)}: ${e}`))
		device.listen(id, (from, row) => heard(node, from, row))
		return n
	}

	// a taken-in commit's seal: none for one a pack's next vouched for
	function sealOf(node: Node, name: Uint8Array): Uint8Array | undefined {
		const d = mailroom.documents.get(hex(node.bytes))
		const ids = d?.names.get(hex(name))
		for (const id of ids ?? []) {
			const s = d!.seen.get(id)?.sealed
			if (s) return s
		}
	}

	// ---- device → room

	function refuse(node: Node, name: Uint8Array | undefined, from: string, reason: string) {
		stats.refused[reason] = (stats.refused[reason] ?? 0) + 1
		const r = { node: node.id, name: name ? hex(name) : "", from, reason }
		refusals.push(r)
		if (refusals.length > REFUSALS) refusals.shift()
		log(
			`refused ${r.name.slice(4, 12)} on ${short(node.id)} from ${from.slice(4, 12)}: ${reason}`,
		)
	}

	function merged(where: "device" | "room", node: Node, k: { merge?: string; name: Uint8Array }) {
		if (k.merge === undefined) return
		stats.merges[where]++
		stats.merges.rules[k.merge] = (stats.merges.rules[k.merge] ?? 0) + 1
		const known = k.merge === MERGE ? " (littlesync's)" : ""
		log(
			`merge ${hex(k.name).slice(4, 12)} on ${short(node.id)} from the ${where}: rule ` +
				`"${k.merge}"${known}. taken here and ${
					where === "device" ? "forwarded" : "sent on"
				} as any commit (no merge rule is checked in the gateway path); a sync.ts device ` +
				`without the rule refuses it ("merge") and every commit on it ("parent")`,
		)
	}

	async function fromDevice(s: State, node: Node, sealed: Uint8Array) {
		stats.in++
		let u
		try {
			u = await unseal(sealed, node.bytes)
		} catch (e) {
			const c = peek(sealed)
			return refuse(node, c && nameOf(c), "?", `seal: ${(e as Error).message}`)
		}
		const from = hex(u.commit.signer), n = hex(u.name)
		let acked = s.acked.get(node.id)
		if (!acked) s.acked.set(node.id, acked = new Set())
		acked.add(n)
		// that device's stored commit: what it held there stops
		const h = s.holds.get(node.id)
		if (h && h.signer === from) unhold(s, node.id, h)
		const added = node.check.add(u.bytes)
		if (added === "passed") return
		merged("device", node, { merge: u.commit.merge, name: u.name })
		if (added === "taken") return await forward(node, node.check.get(u.name)!, sealed)
		if ("refused" in added) {
			const on = node.check.refused().find((r) => r.name === n)?.on
			return refuse(
				node,
				u.name,
				from,
				`history: ${added.refused}${on ? ` (on ${on.slice(4, 12)})` : ""}`,
			)
		}
		// waiting on a parent here: forwarded once it comes (check.taken)
		if (!node.waiting.has(n)) stats.waiting++
		node.waiting.set(n, { sealed, from })
		// the device may hold them (a gateway that began again has none of what it was sent)
		const lacking = added.waiting.filter((p) => !node.waiting.has(p)).map(unhex)
		if (lacking.length && !s.closed) {
			s.conn.link.send({ t: "want", node: node.bytes, names: lacking })
		}
		log(
			`waiting ${n.slice(4, 12)} on ${short(node.id)}: parents ${
				added.waiting.map((p) => p.slice(4, 12)).join(" ")
			}`,
		)
	}

	// a device seal through the check: put to the stack as a loose commit (its stored id, its parents'
	// stored ids, the seal as its blob: the lock is "unlocked")
	async function forward(node: Node, k: Kept, sealed: Uint8Array) {
		const d = mailroom.documents.get(hex(node.bytes))
		const parents: Uint8Array[] = []
		for (const p of k.parents) {
			const id = d?.names.get(hex(p))?.[0] ?? node.forwarded.get(hex(p))
			if (id === undefined) return refuse(node, k.name, "?", "a parent's seal is not here")
			parents.push(unhex(id))
		}
		const s = stored(sealed)
		node.forwarded.set(hex(k.name), hex(s))
		await wired.inside.put(node.id, s, parents, sealed)
		stats.forwarded++
		log(`forwarded ${hex(k.name).slice(4, 12)} on ${short(node.id)} (lamport ${k.lamport})`)
	}

	// ---- room → device

	function has(s: State, id: string, n: string) {
		return s.acked.get(id)?.has(n) ?? false
	}

	// commits to the device, those it has not got and was not sent lately
	function offer(s: State, node: Node, names: Uint8Array[]) {
		const t = now()
		let sent = s.sent.get(node.id)
		if (!sent) s.sent.set(node.id, sent = new Map())
		let batch: Uint8Array[] = [], size = 0
		const flush = () => {
			if (!batch.length) return
			s.conn.link.send({ t: "commits", node: node.bytes, sealed: batch })
			stats.out += batch.length
			batch = [], size = 0
		}
		for (const name of names) {
			const n = hex(name)
			if (has(s, node.id, n)) continue
			const was = sent.get(n)
			if (was && (t - was.at < RESEND || was.tries >= TRIES)) continue
			const seal = sealOf(node, name)
			if (seal === undefined || seal.length > SEAL_MAX) {
				if (!node.told.has(n)) {
					node.told.add(n)
					if (seal === undefined) stats.unsealed++
					else stats.big++
					log(
						`can't send ${n.slice(4, 12)} on ${short(node.id)}: ${
							seal === undefined
								? "held with no seal (vouched in a fragment's pack)"
								: `its seal is ${seal.length} bytes, over a frame`
						}`,
					)
				}
				continue
			}
			sent.set(n, { at: t, tries: (was?.tries ?? 0) + 1 })
			if (size + seal.length > CHUNK) flush()
			batch.push(seal)
			size += seal.length + 4
		}
		flush()
	}

	const all = (node: Node) => device.history(node.id).all().map((k) => k.name)

	device.arrived((a) => {
		const node = nodes.get(a.doc)
		if (node === undefined) return
		if (a.layer === "stored") {
			if (!node.forwarded.has(hex(a.kept.name))) merged("room", node, a.kept)
			for (const s of states) if (s.conn.follows.has(a.doc)) offer(s, node, [a.kept.name])
			pumpAll()
			return
		}
		// an ephemeral commit heard (not a stored one in the ephemeral history): on to the devices
		if (!a.heard || device.history(a.doc).get(a.kept.name) !== undefined) return
		for (const s of states) {
			if (!s.conn.follows.has(a.doc)) continue
			s.conn.link.send({ t: "ephemeral", node: node.bytes, commit: a.kept.bytes })
			stats.ephemeral.out++
		}
		pumpAll()
		// let go of here: heard again (a beat), it comes in again
		queueMicrotask(() => device.forget(a.doc, a.kept.name))
	})

	// ---- ephemerals from a device

	function unhold(s: State, id: string, h: Hold) {
		s.holds.delete(id)
		device.stop(id, h.table)
		device.forget(id, h.made)
		stats.ephemeral.stops++
	}

	function ephemeral(s: State, node: Node, bytes: Uint8Array) {
		let c: Commit
		try {
			c = decode(bytes)
		} catch {
			return log(`ephemeral on ${short(node.id)}: not a commit`)
		}
		stats.ephemeral.in++
		// on to the other devices naming the node, as it came (the C side relays so)
		for (const o of states) {
			if (o !== s && o.conn.follows.has(node.id)) {
				o.conn.link.send({ t: "ephemeral", node: node.bytes, commit: bytes })
			}
		}
		const from = hex(nameOf(bytes)), h = s.holds.get(node.id)
		if (h && h.from === from) {
			h.last = now()
			device.again(node.id, h.made)
			return
		}
		const head = device.history(node.id).heads()[0]
		const commit: Commit = {
			table: c.table,
			actor: c.actor,
			time: c.time,
			signer: options.signer.key,
			nonce: nonce++,
			parents: head ? [head.name] : [],
			lamport: (head?.lamport ?? 0) + 1,
			patches: c.patches,
			metadata: { littlesync: hex(c.signer) },
		}
		const made = encode(commit), name = nameOf(made)
		const added = device.take(node.id, made, "ephemeral", { commit, name })
		if (added !== "taken") return log(`ephemeral on ${short(node.id)}: ${JSON.stringify(added)}`)
		if (h) device.forget(node.id, h.made)
		s.holds.set(node.id, { from, made: name, table: c.table, signer: hex(c.signer), last: now() })
	}

	// ---- presence

	type Peer = { key?: string; device?: Device; rows: Map<string, Uint8Array>; last: number }
	// by the device's key (hex); the keys made for them (hex), whose rows heard back stay up there
	const peers = new Map<string, Peer>()
	const ours = new Set<string>()
	// how a peer reaches the server: once it has, ended (a socket's close) ends the peer
	type Reach = (d: Device) => Promise<{ ended?: Promise<void> } | void>
	const given = options.peer
	let reach: Reach | undefined = given && ((d) => given((t, initiator) => d.connect(t, initiator)))

	// a row heard on a node's topic: down to each device naming the node
	function heard(node: Node, from: string, row: Uint8Array) {
		if (ours.has(from)) return
		for (const s of states) {
			if (!s.conn.follows.has(node.id)) continue
			s.conn.link.send({ t: "presence", node: node.bytes, who: unhex(from), row })
			stats.presence.out++
		}
		pumpAll()
	}

	function presence(s: State, node: Node, who: Uint8Array, row: Uint8Array) {
		stats.presence.in++
		for (const o of states) {
			if (o !== s && o.conn.follows.has(node.id)) {
				o.conn.link.send({ t: "presence", node: node.bytes, who, row })
			}
		}
		const k = hex(who)
		// a row from the room come back round (links in a ring), or no way up now
		if (ours.has(k) || reach === undefined || !stats.upstream.up) return
		let p = peers.get(k)
		if (p === undefined) peers.set(k, p = openPeer(k))
		p.last = now()
		if (p.device === undefined) return void p.rows.set(node.id, row)
		void p.device.send(node.id, row).catch(() => {})
		if (gone(row)) p.last = now() - PEER_IDLE + 1000
	}

	const gone = (row: Uint8Array) => {
		try {
			return (cbor.decode(row) as { gone?: unknown })?.gone === true
		} catch {
			return false
		}
	}

	// a device's peer upstream: a key of its own, connected; the rows that came meanwhile, the last
	// of each node, sent once it is
	function openPeer(k: string): Peer {
		const p: Peer = { rows: new Map(), last: now() }
		;(async () => {
			const signer = await createSigner()
			p.key = hex(signer.key)
			ours.add(p.key)
			const room = createMailroom({ signer, limits })
			const up = createSubduction(room, { signer, service: options.service, limits })
			const d: Device = { ...room.device, ...up.device }
			const r = await reach!(d)
			if (peers.get(k) !== p) return void d.close().catch(() => {})
			r?.ended?.then(() => peers.get(k) === p && closePeer(k, p))
			p.device = d
			stats.presence.peers++
			log(`presence peer ${p.key.slice(4, 12)} for ${k.slice(4, 12)}`)
			for (const [id, row] of p.rows) await d.send(id, row).catch(() => {})
			p.rows.clear()
		})().catch((e) => {
			log(`presence peer for ${k.slice(4, 12)}: ${(e as Error)?.message ?? e}`)
			if (peers.get(k) === p) closePeer(k, p)
		})
		return p
	}

	function closePeer(k: string, p: Peer) {
		peers.delete(k)
		if (p.key) ours.delete(p.key)
		if (p.device === undefined) return
		stats.presence.peers--
		void p.device.close().catch(() => {})
	}

	// ---- links

	function pump(s: State) {
		const b = s.conn.link.next()
		if (b.length && !s.closed) s.send(b)
	}
	const pumpAll = () => {
		for (const s of states) pump(s)
	}

	function message(s: State, m: Message) {
		if (m.t === "hello") {
			// the device began again: it has nothing of ours
			s.sent.clear()
			s.acked.clear()
			for (const id of s.conn.follows) offer(s, nodeOf(id), all(nodeOf(id)))
			return
		}
		const id = "ermine://" + hex(m.node)
		const node = nodeOf(id)
		if (!s.conn.follows.has(id)) s.conn.follows.add(id)
		let acked = s.acked.get(id)
		if (!acked) s.acked.set(id, acked = new Set())
		switch (m.t) {
			case "heads": {
				const want: Uint8Array[] = []
				for (const h of m.heads) {
					acked.add(hex(h))
					if (!node.check.get(h) && !node.waiting.has(hex(h))) want.push(h)
				}
				if (want.length) s.conn.link.send({ t: "want", node: m.node, names: want })
				offer(s, node, all(node))
				return
			}
			case "want":
				for (const n of m.names) s.sent.get(id)?.delete(hex(n)), acked.delete(hex(n))
				offer(s, node, m.names)
				return
			case "ack":
				for (const n of m.names) acked.add(hex(n))
				return
			case "ephemeral":
				return ephemeral(s, node, m.commit)
			case "presence":
				return presence(s, node, m.who, m.row)
			case "commits": {
				const names = m.sealed.map(peek).filter((c) => c !== undefined).map((c) => nameOf(c!))
				serial(async () => {
					for (const sealed of m.sealed) await fromDevice(s, node, sealed)
					if (s.closed || !names.length) return
					if (stats.upstream.up) s.conn.link.send({ t: "ack", node: m.node, names })
					else {
						let u = s.unacked.get(id)
						if (!u) s.unacked.set(id, u = new Set())
						for (const n of names) u.add(hex(n))
						stats.upstream.held = held()
					}
					pump(s)
				})
				return
			}
		}
	}

	// ---- upstream

	const held = () =>
		[...states].reduce((k, s) => k + [...s.unacked.values()].reduce((j, u) => j + u.size, 0), 0)

	function up(now: boolean) {
		stats.upstream.up = now
		if (!now) return
		for (const s of states) {
			for (const [id, u] of s.unacked) {
				if (u.size) {
					s.conn.link.send({ t: "ack", node: unhex(id.slice(9)), names: [...u].map(unhex) })
				}
			}
			s.unacked.clear()
		}
		stats.upstream.held = 0
		pumpAll()
	}

	const keeps = new Set<() => void>()
	function keep(dial: () => Promise<Socket>) {
		// a presence peer dials as the gateway does; its socket gone, the peer goes (made again at
		// the device's next row)
		reach ??= async (d) => {
			const s = await dial()
			try {
				await d.connect(s, true)
			} catch (e) {
				await s.disconnect()
				throw e
			}
			return { ended: s.gone }
		}
		let stopped = false, now: Socket | undefined, nap: (() => void) | undefined
		const sleep = (ms: number) =>
			new Promise<void>((r) => {
				const t = setTimeout(r, ms)
				nap = () => (clearTimeout(t), r())
			})
		;(async () => {
			for (let wait = FIRST; !stopped;) {
				let s: Socket | undefined
				try {
					s = await dial()
					if (stopped) break
					let late: ReturnType<typeof setTimeout> | undefined
					const early = s.gone.then(() => {
						throw new Error("closed in the handshake")
					})
					early.catch(() => {})
					await Promise.race([
						device.connect(s, true),
						new Promise((_, j) =>
							late = setTimeout(() => j(new Error("no handshake")), DIAL)
						),
						early,
					]).finally(() => clearTimeout(late))
				} catch (e) {
					await s?.disconnect()
					if (stopped) break
					log(`upstream: ${(e as Error)?.message ?? e}; again in ${wait} ms`)
					await sleep(wait)
					wait = Math.min(wait * 2, MOST)
					continue
				}
				now = s
				stats.upstream.connects++
				log(`upstream connected (${stats.upstream.connects})`)
				up(true)
				wait = FIRST
				await s.gone
				now = undefined
				up(false)
				if (stopped) break
				stats.upstream.drops++
				log(`upstream lost; again in ${wait} ms`)
				await sleep(wait)
			}
		})()
		const stop = () => {
			stopped = true
			keeps.delete(stop)
			nap?.()
			void now?.disconnect()
		}
		keeps.add(stop)
		return stop
	}

	return {
		device,
		stats,
		refusals,
		open(send) {
			const s = {} as State
			const link = new Link(options.signer.key, (m) => message(s, m), (l) => log(`link: ${l}`))
			const conn: Conn = {
				link,
				follows: new Set(),
				feed(bytes) {
					link.feed(bytes, now())
					pump(s)
				},
				close() {
					if (s.closed) return
					s.closed = true
					states.delete(s)
					stats.links--
					for (const [id, h] of [...s.holds]) unhold(s, id, h)
					log("link closed")
				},
			}
			Object.assign(s, {
				conn,
				send,
				closed: false,
				sent: new Map(),
				acked: new Map(),
				holds: new Map(),
				unacked: new Map(),
			})
			states.add(s)
			stats.links++
			link.tick(now())
			pump(s)
			log("link open")
			return conn
		},
		tick() {
			const t = now()
			for (const [k, p] of [...peers]) if (t - p.last > PEER_IDLE) closePeer(k, p)
			for (const s of states) {
				s.conn.link.tick(t)
				for (const [id, h] of [...s.holds]) if (t - h.last > HELD_MS) unhold(s, id, h)
				for (const [id, sent] of s.sent) {
					const due = [...sent].filter(([n, w]) =>
						!has(s, id, n) && t - w.at >= RESEND && w.tries < TRIES
					)
					if (due.length) offer(s, nodeOf(id), due.map(([n]) => unhex(n)))
				}
				pump(s)
			}
		},
		async connect(url, service) {
			reach ??= (d) => d.connectDiscover(url, service)
			await device.connectDiscover(url, service)
			up(true)
		},
		async connectTransport(transport, initiator) {
			await device.connect(transport, initiator)
			up(true)
		},
		keep,
		followed: () => [...nodes.keys()],
		async idle() {
			while (busy > 0) await chain
			await device.idle()
		},
		async close() {
			for (const s of [...states]) s.conn.close()
			for (const [k, p] of [...peers]) closePeer(k, p)
			for (const stop of [...keeps]) stop()
			await device.close()
		},
	}
}
