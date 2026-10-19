import type { Patch } from "@ermine/op/apply"
import type { FileLocation } from "@ermine/util/stacktrace"

// a change's metadata: a plain object, any keys; the keys some layer reads by name typed here.
// node: the id of the node whose computer made it (table's Id: string | symbol). run, mark: that
// computer's run count and mark. actor, reader: as the header's. caller, trusted-event: a send's.
// place: a path (places' Path). cause, wallclock, message: sync's
export type Metadata = {
	[key: string]: unknown
	node?: string | symbol
	run?: number
	mark?: number
	actor?: unknown
	reader?: string
	caller?: unknown
	"trusted-event"?: boolean
	place?: readonly string[]
	cause?: unknown
	wallclock?: number
	message?: string
}

// what a change says: given by whoever makes it, never read here. external: where in code it was
// made, oldest first, a site added after (stacktrace's capture). metadata: an object anyone adds
// keys to (Metadata). op: the latest edit, its patches as given and undo, their inverse (op's invert):
// set by update, never by a caller
export type ChangeHeader = {
	time: number
	actor: unknown
	reader?: string
	external?: FileLocation[]
	metadata?: Metadata
	op?: { patches: readonly Patch[]; undo: readonly Patch[] }
}

// a value and its latest change; none: nothing there. where it is kept is a layer above's
export type Entry<V> = {
	value?: V
	change: ChangeHeader
}

// kept by the caller; nothing checked: checks are a layer above's. the change given is the
// entry's, not copied; one with no time: a new change with the time now, whole seconds since 1970,
// the one given unchanged
export default function createEntry<V>(
	value: V,
	change: ChangeHeader = {} as ChangeHeader,
): Entry<V> {
	if (change.time === undefined) change = { ...change, time: Math.floor(Date.now() / 1000) }
	const entry: Entry<V> = { change }
	if (value !== undefined) entry.value = value
	return entry
}
