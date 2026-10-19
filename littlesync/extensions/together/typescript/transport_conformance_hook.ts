// the transport's conformance hooks (transport_conformance_hook.c in C): what only the harnesses and
// tests call. Not in the package's exports (deno.json), so only a path inside the repo reaches them.
// createDevice hands each device's own put, putFragment and taking here as it makes it
import type { Code, Device, Layer } from "./transport.ts"

// what the transport holds back or refused, before the histories
export type Taking = {
	waiting: { commit: string; waiting: string[] }[]
	refused: (
		| { commit: string; refused: Code }
		| { commit: string; stuck: string[] }
		| { fragment: string; refused: Code }
	)[]
}

type Inside = {
	put(doc: string, head: Uint8Array, parents: Uint8Array[], blob: Uint8Array): Promise<void>
	putFragment(
		doc: string,
		head: Uint8Array,
		boundary: Uint8Array[],
		checkpoints: Uint8Array[],
		blob: Uint8Array,
	): Promise<void>
	taking(doc: string, layer: Layer): Taking
}

const insides = new WeakMap<Device, Inside>()

// for createDevice only
export function keep(device: Device, inside: Inside) {
	insides.set(device, inside)
}

const of = (device: Device) => {
	const inside = insides.get(device)
	if (inside === undefined) throw new Error("not a device createDevice made")
	return inside
}

// addCommit as given: nothing checked or taken in first (taken in as a save is)
export function transport_conformance_hook_put(
	device: Device,
	doc: string,
	head: Uint8Array,
	parents: Uint8Array[],
	blob: Uint8Array,
): Promise<void> {
	return of(device).put(doc, head, parents, blob)
}

// addFragment as given, likewise
export function transport_conformance_hook_putFragment(
	device: Device,
	doc: string,
	head: Uint8Array,
	boundary: Uint8Array[],
	checkpoints: Uint8Array[],
	blob: Uint8Array,
): Promise<void> {
	return of(device).putFragment(doc, head, boundary, checkpoints, blob)
}

// what the transport holds back or refused before the histories. waiting: a loose commit (by its
// head), or a fragment's member (by its seal's stored id), and the names of its parents not here.
// refused, by id: a commit (code), a fragment refused whole, or one stuck on a parent refused or
// stuck here. each list sorted by id. the ephemeral layer: no waiting, the refused ephemeral commits
// by name
export function transport_conformance_hook_taking(
	device: Device,
	doc: string,
	layer: Layer = "stored",
): Taking {
	return of(device).taking(doc, layer)
}
