// a node's tables at a commit (extensions/subduction/plan.org, Rewrite for the new shape, 4): back
// along the bases to the newest snapshot (or the root), then forward, each commit decoded from its
// bytes and applied to its table in place. everything built here is new: decoded from bytes,
// shared with nothing, so applying in place costs the patches, not the tables. for a head that
// doesn't show (conflicts), a head switch, a version
//
// a merge commit on the way back: its tables are its rule's merge of its parents, given merges;
// the walk starts there. a rule is given only what is had without merging (a snapshot, or a walk
// back to one or the root that meets no merge commit), so a merge never waits on another. key
// patches on several parents, or a commit naming what it replaces: its tables are the lists' of it
// and its ancestors (lists.ts); the walk starts there too. a held commit (history.ts) the same: the
// lists show it beside what they show, so its tables are what its parents' are, composed. patches
// apply as sync takes them (lists.ts applies: a key patch makes its missing parents)
import { type Commit, decode } from "@ermine/formats/commit"
import type { ChangeHeader, Entry } from "@ermine/node/entry"
import type { History, Kept } from "./history.ts"
import { hex } from "./hex.ts"
import { applies, state } from "./lists.ts"
import { alike, tablesOf } from "./snapshot.ts"

// each table's entry: its value, and the change that last touched it
export type Tables = Record<string, Entry<unknown>>

// the tables at a commit, when a snapshot of them is kept: new objects each time asked
export type Snapshots = (name: Uint8Array) => Tables | undefined

// a merge rule: the tables of a node's heads merged, the same on every device. pure: it changes
// nothing it is given and keeps nothing. get: the tables at a commit, or at several merged by this
// rule, when they are had without merging (new objects each time); else undefined. keeping, when
// a rule has it: a merge by the same rule for one node's history that keeps its work between calls
// (not pure), giving the same tables; for a device merging a node again and again as it grows
export type Merge =
	& ((
		history: History,
		heads: readonly Kept[],
		get: (names: readonly Uint8Array[]) => Tables | undefined,
	) => Tables)
	& { keeping?: () => Merge }

// the rules a device knows, by name
export type Merges = Readonly<Record<string, Merge>>

// a commit's change header, as the graph has one. name (the commit's) given: who signed it and the
// commit kept in its metadata, signer (its key, a multikey) and commit (name), both hex, over any
// of those names the commit carried
export function changeOf(c: Commit, name?: Uint8Array): ChangeHeader {
	const h: ChangeHeader = { time: c.time, actor: c.actor }
	if (c.reader !== undefined) h.reader = c.reader
	if (c.external !== undefined) h.external = c.external
	if (name !== undefined) {
		h.metadata = { ...c.metadata, signer: hex(c.signer), commit: hex(name) }
	} else if (c.metadata !== undefined) h.metadata = c.metadata
	return h
}

// whether a snapshot of the tables at name (packed, snapshot.ts) from elsewhere is right: the tables
// replayed to it (from the snapshots given, each checked so itself) are the same. no snapshot is
// signed, so one is a hint, kept only when it matches (transport.ts); false: not taken in, a merge on
// the way by a rule not given, or bytes that are no snapshot
export function matches(
	history: History,
	name: Uint8Array,
	bytes: Uint8Array,
	snapshot: Snapshots = () => undefined,
	merges?: Merges,
): boolean {
	const tables = replay(history, name, snapshot, merges)
	if (tables === undefined) return false
	try {
		return alike(tables, tablesOf(bytes))
	} catch {
		return false
	}
}

// the tables at name; undefined: not taken in, or a merge on the way by a rule not given
export function replay(
	history: History,
	name: Uint8Array,
	snapshot: Snapshots = () => undefined,
	merges?: Merges,
): Tables | undefined {
	return walk(history, name, snapshot, merges ?? {}, true)
}

// the tables at name when they are had without merging: a snapshot, or a walk back to one or the
// root that meets no merge commit; else undefined. what a rule is given
export function plain(
	history: History,
	name: Uint8Array,
	snapshot: Snapshots = () => undefined,
): Tables | undefined {
	return walk(history, name, snapshot, {}, false)
}

// the tables a commit's own patches make, as its writer had them: on its base's tables (a merge's:
// on its rule's merge), whatever the lists say of it. a whole write's value (lists.ts)
export function written(
	history: History,
	name: Uint8Array,
	snapshot: Snapshots = () => undefined,
	merges?: Merges,
): Tables | undefined {
	return walk(history, name, snapshot, merges ?? {}, true, true)
}

// key patches on several parents, a commit naming what it replaces, or a held one: its tables are
// the lists'
const listed = (k: Kept) =>
	k.held !== undefined ||
	k.merge === undefined && (k.replaces || k.base === undefined && k.parents.length > 1)

// merging: a merge commit met is merged; else the walk gives undefined. own: the commit's own
// patches on what they are over (written)
function walk(
	history: History,
	name: Uint8Array,
	snapshot: Snapshots,
	merges: Merges,
	merging: boolean,
	own = false,
): Tables | undefined {
	const start = history.get(name)
	if (start === undefined) return
	const line: Kept[] = []
	let tables: Tables = {}
	for (let k: Kept | undefined = start; k !== undefined;) {
		const s = own && k === start || k.held !== undefined ? undefined : snapshot(k.name)
		if (s !== undefined) {
			tables = s
			break
		}
		if (listed(k) && !(own && k === start)) {
			const after = (j: Kept) => walk(history, j.name, snapshot, merges, merging, true) ?? {}
			tables = state(history, [k], after)
			break
		}
		line.push(k)
		if (k.merge !== undefined) {
			const rule = merges[k.merge]
			if (!merging || rule === undefined) return
			const heads = k.parents.map((p) => history.get(p)!)
			tables = rule(
				history,
				heads,
				(ns) => ns.length === 1 ? walk(history, ns[0], snapshot, merges, false) : undefined,
			)
			break
		}
		k = k.base === undefined ? undefined : history.get(k.base)
	}
	for (let i = line.length - 1; i >= 0; i--) {
		const c = decode(line[i].bytes)
		const value = applies(tables[c.table]?.value, c.patches)
		if (value === undefined) delete tables[c.table]
		else tables[c.table] = { value, change: changeOf(c, line[i].name) }
	}
	return tables
}
