// commits over Subduction (extensions/subduction/plan.org, Rewrite for the new shape, 7): a device
// is two parts composed here. the mailroom (mailroom.ts): what a device holds of a node's commits, a history
// for each layer, the seals taken in, what is refused, its own takes sealed. the subduction stack
// (subduction.ts): stored commits as loose commits and fragments, each fragment with a snapshot of
// the tables at its head; ephemeral ones, never sealed, as its ephemeral messages; and what a
// device checks of what arrives before the mailroom's histories see it, and before Subduction stores
// it (only what is taken in is). what a device holds for others is bounded (Limits). adapted from
// the old stack's transport.ts (now in ermine-graveyard/extensions/subduction), which carries blops
import type * as sd from "npm:@automerge/subduction@0.23.0"
import {
	type Check,
	createMailroom,
	type Held,
	LIMITS as KEEPING,
	type Limits as Keeping,
} from "./mailroom.ts"
import {
	createSubduction,
	JOINING,
	type Joining,
	type Wired,
} from "../stacks/subduction/typescript/subduction.ts"
import type { Lock } from "./lock.ts"
import type { Kept } from "./history.ts"
import type { Merges } from "./replay.ts"
import type { Signer, Verifier } from "./seal.ts"
import { keep as hooks } from "./transport_conformance_hook.ts"

export type { Arrival, Check, Code, Layer, Taking } from "./mailroom.ts"
export { LIMIT, PART } from "../stacks/subduction/typescript/subduction.ts"
export { type Lock, type Opened, unlocked } from "./lock.ts"
export type { Fragment } from "../stacks/subduction/typescript/subduction.ts"

// starting: createDevice returns at once, and begins taking in what the storage holds for each
// document whose id is named already (every fragment, then every loose commit, as a save is taken
// in; a commit whose parents come later waits, as ever; another device's only once the document is
// followed). a tree whose id is not named yet (a tree id is a hash of the id: it can't be turned
// back) is only listed (unnamed() counts them), and taken in when its document is first followed
// (fragments, then loose commits, as the start would), before it is fetched from any peer.
// everything that touches the network (connect, connectDiscover, follow) waits for the start;
// take's sealing and storing, put and the other work queue behind it. ready() resolves when it is
// done; it throws what the storage threw. lazy: every tree only listed at the start (but first's),
// so the histories hold the followed documents and no other; a stored document never followed
// enters no history. not shared means not stored: this device stores its own commits, followed or
// not, and another's only for a followed document; a peer's put or fetch for one not followed is
// turned away, counted (turned, offered). what this device stores of a document is sent only while
// it is followed (pause, drop: Wired's)
export type Device = Held & Wired

// what a device holds for others at most, each letting go of its oldest past it (heard again, it
// comes in again): the mailroom's (mailroom.ts) and the stack's (subduction.ts)
export type Limits = Keeping & Joining
export const LIMITS: Limits = { ...KEEPING, ...JOINING }

export function createDevice(
	// join: how long, in ms, the parts of an ephemeral payload may wait for the rest
	options: {
		// its key must be Ed25519: Subduction's peer keys are
		signer: Signer
		// signature algorithms beyond the built in Ed25519, for the seals taken in (seal.ts)
		verifiers?: readonly Verifier[]
		lock?: Lock
		service?: string
		join?: number
		// where Subduction keeps what it saves (taken in on save as ever); default: in memory
		storage?: sd.SedimentreeStorage
		// what the storage holds is taken in as each document is followed, never at the start
		lazy?: boolean
		// default: everything applies
		check?: Check
		// the integration's: the tables at a fragment's head, packed (snapshot.ts), for its snapshot;
		// undefined: none for this one (the integration decides when one is worth it)
		snapshotOf?: (doc: string, head: Kept) => Uint8Array | undefined
		// the merge rules a snapshot from elsewhere is checked with (a replay to its head); default none
		merges?: Merges
		// default LIMITS
		limits?: Partial<Limits>
		// ids named before the start: their trees taken in at it, lazy or not (sync's shared list)
		first?: readonly string[]
	},
): Device {
	const limits: Limits = { ...LIMITS, ...options.limits }
	const mailroom = createMailroom({ ...options, limits })
	const wired = createSubduction(mailroom, { ...options, limits })
	const device: Device = { ...mailroom.device, ...wired.device }
	hooks(device, {
		...wired.inside,
		taking: (doc, layer) => mailroom.device.taking(doc, layer),
	})
	return device
}
