// commits over Subduction (extensions/subduction/plan.org, Rewrite for the new shape, 7): a device
// is two parts composed here. the mailroom (mailroom.ts): what a device holds of a node's commits, a history
// for each layer, the seals taken in, what is refused, its own takes sealed. the subduction stack
// (subduction.ts): stored commits as loose commits and fragments, each fragment with a snapshot of
// the tables at its head; ephemeral ones, never sealed, as its ephemeral messages; and what a
// device checks of what arrives before the mailroom's histories see it, and before Subduction stores
// it (only what is taken in is). what a device holds for others is bounded (Limits). adapted from
// extensions/subduction/typescript/transport.ts, which carries blops
import type * as sd from "npm:@automerge/subduction@0.23.0"
import {
	type Check,
	createMailroom,
	type Held,
	LIMITS as KEEPING,
	type Limits as Keeping,
} from "./mailroom.ts"
import { createSubduction, JOINING, type Joining, type Lock, type Wired } from "../stacks/subduction/typescript/subduction.ts"
import type { Kept } from "./history.ts"
import type { Merges } from "./replay.ts"
import type { Signer, Verifier } from "./seal.ts"
import { keep as hooks } from "./transport_conformance_hook.ts"

export type { Arrival, Check, Code, Layer, Taking } from "./mailroom.ts"
export { LIMIT, type Lock, type Opened, PART, unlocked } from "../stacks/subduction/typescript/subduction.ts"
export type { Fragment } from "../stacks/subduction/typescript/subduction.ts"

// starting: createDevice returns at once, and begins taking in everything the storage holds (every
// fragment, then every loose commit, as a save is taken in; a commit whose parents come later waits,
// as ever). everything that touches the network (connect, connectDiscover, follow) waits for that;
// take's sealing and storing, put and the other work queue behind it. ready() resolves when it is
// done; it throws what the storage threw. lazy: only the trees the storage holds are listed at the
// start; a document's tree is taken in when it is followed (fragments, then loose commits, as the
// start would), before it is fetched from any peer, so the histories hold the followed documents
// and no other; a stored document never followed enters no history
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
		// what the storage holds is taken in as each document is followed, not at the start
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
	},
): Device {
	const limits: Limits = { ...LIMITS, ...options.limits }
	const mailroom = createMailroom({ ...options, limits })
	const wired = createSubduction(mailroom, { ...options, limits })
	const device: Device = { ...mailroom.device, ...wired.device }
	hooks(device, { ...wired.inside, taking: (doc, layer) => mailroom.device.taking(doc, layer) })
	return device
}
