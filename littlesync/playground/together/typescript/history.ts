// one node's history (extensions/subduction/plan.org, Rewrite for the new shape, 3): its commits
// as their bytes, each taken in once its parents are, its heads in the agreed order, what waits on
// a parent and what is refused. no values: what a head holds is the table's (the head shown) or
// replay's (replay.ts), worked out from the bytes when asked, so nothing here is ever shared with
// what changes.
//
// taking a commit in: its bytes decoded (a commit's shape, commit.ts), its parents all here and
// taken (else it waits), its lamport 1 + the highest of theirs (1 for a root: a lamport is derived,
// never chosen), and check (the integration's: do its patches apply to its parent's node) says yes.
// a commit taken in releases what waited on it, in order. one the check cannot judge yet waits on
// nothing named until again() asks once more; a throw in the check is such a wait, and thrown.
// one the check holds (a merge by a rule this device doesn't know, or what goes on one touching its
// path) is taken in all the same, a head like any other, its patches unapplied; its record carries
// the rule: a held parent's (the first), else the nearest held ancestor's, else its own merge's
//
// beside it, for merge rules: what a commit's tables follow from (follows), and the commits since a
// set of heads' common ancestor, in causal order (since)
import { type Commit, compare, decode, name as nameOf } from "@ermine/formats/commit"
import { hex } from "./hex.ts"

export type Refusal = "shape" | "lamport" | "patches" | "parent"

// waiting: on the parents named; on none, on the check (it could not judge the commit yet). held:
// taken in, not applied
export type Added =
	| "taken"
	| "held"
	| "passed"
	| { waiting: string[] }
	| { refused: Refusal }

// what the check says of a commit: true, it applies; false, refused "patches"; a refusal, refused
// so; "wait", it cannot be judged yet (authority not here yet, say): the commit waits on the check;
// "held", taken in unapplied (a held one with no rule to carry, neither on a held one nor a merge:
// refused "patches")
export type Judged = boolean | Refusal | "wait" | "held"

// what a commit is kept as: its bytes, and what ordering and replay read without decoding again
export type Kept = {
	name: Uint8Array
	bytes: Uint8Array
	table: string
	parents: Uint8Array[]
	// the parent its patches are over: the only one, or the base of several; none for a root, a
	// merge, or key patches on several
	base: Uint8Array | undefined
	// a merge commit's rule: its patches are over the merge of its parents
	merge: string | undefined
	lamport: number
	// a patch names what it replaces: its tables are the lists' (lists.ts), not its base's patched
	replaces?: true
	// held: the rule this device doesn't know that it waits for (a merge's, or one under it)
	held?: string
}

export type History = {
	// the commit's bytes: taken in, waiting, refused or passed (here already). made: its commit and
	// name, from whoever just encoded it (this device's own): not decoded or named again
	add(bytes: Uint8Array, made?: { commit: Commit; name: Uint8Array }): Added
	// the heads, in the agreed order: higher lamport first; equal, the greater name
	heads(): Kept[]
	get(name: Uint8Array): Kept | undefined
	// told each commit taken in, in the order taken, released ones too
	taken(f: (kept: Kept) => void): () => void
	// in the order they came to wait; waiting on the check: waiting []
	waiting(): { name: string; waiting: string[] }[]
	// the commits waiting on the check judged again, in the order they came to wait; the first
	// throw of the check thrown after
	again(): void
	refused(): { name: string; refused: Refusal; on?: string }[]
	// every commit taken in, in the order taken (held ones too)
	all(): Kept[]
	// a head taken in let go of, as if never told of it: its parents heads again where nothing else
	// goes on them. false: not taken, or something goes on it
	forget(name: Uint8Array): boolean
}

// check: given a commit whose parents are all taken, whether its patches apply to its parent's
// node (the integration's, which may apply them as it looks), as Judged says. a throw is a wait on
// the check, and thrown from the add (or again) once what it let in is settled. most: how many
// commits it holds waiting on a parent, and how many refusals, at most: past it the oldest is let
// go of, as if never told (told again, it is judged again), and dropped is told the one waiting
export function createHistory(
	check: (kept: Kept, commit: Commit) => Judged = () => true,
	limits: { most?: number; dropped?: (name: string) => void } = {},
): History {
	const most = limits.most ?? Infinity
	const taken = new Map<string, Kept>()
	const order: Kept[] = []
	const heads = new Set<string>()
	// how many taken commits go on each one, where any do
	const children = new Map<string, number>()
	// a commit not taken in yet: its own, and the names it waits on; none: it waits on the check
	const waits = new Map<string, { kept: Kept; commit: Commit; on: Set<string> }>()
	// a throw of the check, thrown once the add or again that met it is done
	let thrown: { error: unknown } | undefined
	const waiters = new Map<string, Set<string>>()
	const refusals = new Map<string, Refusal>()
	// a commit refused for a parent: the parent refused, its name
	const causes = new Map<string, string>()
	const listeners = new Set<(kept: Kept) => void>()
	// the lowest lamport of a held commit: none is under it
	let low = Infinity

	// refused, the oldest refusal let go of past most
	function note(n: string, why: Refusal) {
		if (refusals.size >= most) {
			const old = refusals.keys().next().value!
			refusals.delete(old)
			causes.delete(old)
		}
		refusals.set(n, why)
	}

	// the oldest commit waiting on a parent let go of, as if never told
	function letGo() {
		for (const [n, w] of waits) {
			if (w.on.size === 0) continue
			waits.delete(n)
			for (const p of w.on) {
				const s = waiters.get(p)!
				s.delete(n)
				if (s.size === 0) waiters.delete(p)
			}
			limits.dropped?.(n)
			return
		}
	}

	function refuse(n: string, why: Refusal, cause?: string) {
		note(n, why)
		if (cause !== undefined) causes.set(n, cause)
		// what waits on a refused commit never comes in
		for (const w of waiters.get(n) ?? []) {
			const x = waits.get(w)
			if (x === undefined) continue
			waits.delete(w)
			refuse(w, "parent", n)
		}
		waiters.delete(n)
	}

	// parents all taken: the lamport, then check; taken, then what waited on it
	function settle(kept: Kept, commit: Commit): Added {
		const n = hex(kept.name)
		const top = Math.max(0, ...kept.parents.map((p) => taken.get(hex(p))!.lamport))
		if (kept.lamport !== top + 1) {
			refuse(n, "lamport")
			return { refused: "lamport" }
		}
		let ok: Judged
		try {
			ok = check(kept, commit)
		} catch (error) {
			thrown ??= { error }
			ok = "wait"
		}
		if (ok === "wait") {
			waits.set(n, { kept, commit, on: new Set() })
			return { waiting: [] }
		}
		if (ok === "held") {
			const rule = heldBy(kept)
			if (rule === undefined) ok = false
			else {
				kept.held = rule
				low = Math.min(low, kept.lamport)
			}
		}
		if (ok !== true && ok !== "held") {
			const why = ok === false ? "patches" : ok
			refuse(n, why)
			return { refused: why }
		}
		taken.set(n, kept)
		order.push(kept)
		for (const p of kept.parents) {
			const h = hex(p)
			heads.delete(h)
			children.set(h, (children.get(h) ?? 0) + 1)
		}
		heads.add(n)
		for (const f of listeners) f(kept)
		for (const w of waiters.get(n) ?? []) {
			const x = waits.get(w)
			if (x === undefined) continue
			x.on.delete(n)
			// in its place while it is judged: one that waits on the check keeps it
			if (x.on.size === 0) {
				const r = settle(x.kept, x.commit)
				if (typeof r !== "object" || !("waiting" in r)) waits.delete(w)
			}
		}
		waiters.delete(n)
		return kept.held === undefined ? "taken" : "held"
	}

	// a held commit's rule: a held parent's (the first), else the nearest held ancestor's (back along
	// parents, in their order, none under the lowest held), else its own merge's
	function heldBy(k: Kept): string | undefined {
		for (const p of k.parents) {
			const h = taken.get(hex(p))!.held
			if (h !== undefined) return h
		}
		const todo = k.parents.map((p) => taken.get(hex(p))!), seen = new Set<Kept>(todo)
		for (let i = 0; i < todo.length; i++) {
			if (todo[i].held !== undefined) return todo[i].held
			for (const p of todo[i].parents) {
				const q = taken.get(hex(p))
				if (q === undefined || q.lamport < low || seen.has(q)) continue
				seen.add(q)
				todo.push(q)
			}
		}
		return k.merge
	}

	// what an add or again met thrown, once it is done
	function rethrow<T>(x: T): T {
		const t = thrown
		thrown = undefined
		if (t !== undefined) throw t.error
		return x
	}

	return {
		add(bytes, made) {
			const name = made?.name ?? nameOf(bytes), n = hex(name)
			if (taken.has(n) || waits.has(n)) return "passed"
			const was = refusals.get(n)
			if (was !== undefined) return { refused: was }
			let commit: Commit
			if (made) commit = made.commit
			else {
				try {
					commit = decode(bytes)
				} catch {
					note(n, "shape")
					return { refused: "shape" }
				}
			}
			const kept: Kept = {
				name,
				bytes,
				table: commit.table,
				parents: commit.parents,
				// several parents, no base, no merge: key patches only, on all of them
				base: commit.merge === undefined && commit.parents.length < 2
					? commit.parents[0]
					: commit.base,
				merge: commit.merge,
				lamport: commit.lamport,
			}
			if (commit.patches.some((p) => p.replaces !== undefined)) kept.replaces = true
			for (const p of commit.parents) {
				if (refusals.has(hex(p))) {
					refuse(n, "parent", hex(p))
					return { refused: "parent" }
				}
			}
			const missing = commit.parents.map(hex).filter((p) => !taken.has(p))
			if (missing.length) {
				if (waits.size >= most) letGo()
				waits.set(n, { kept, commit, on: new Set(missing) })
				for (const p of missing) {
					let s = waiters.get(p)
					if (!s) waiters.set(p, s = new Set())
					s.add(n)
				}
				return { waiting: missing }
			}
			return rethrow(settle(kept, commit))
		},
		heads: () => [...heads].map((n) => taken.get(n)!).sort(agreed),
		get: (name) => taken.get(hex(name)),
		taken(f) {
			listeners.add(f)
			return () => void listeners.delete(f)
		},
		waiting: () => [...waits].map(([name, w]) => ({ name, waiting: [...w.on] })),
		again() {
			for (const [n, w] of [...waits]) {
				if (w.on.size > 0 || waits.get(n) !== w) continue
				const r = settle(w.kept, w.commit)
				if (typeof r !== "object" || !("waiting" in r)) waits.delete(n)
			}
			rethrow(undefined)
		},
		refused: () =>
			[...refusals].map(([name, refused]) => ({
				name,
				refused,
				...causes.has(name) && { on: causes.get(name)! },
			})),
		all: () => order.slice(),
		forget(name) {
			const n = hex(name), kept = taken.get(n)
			if (kept === undefined || children.has(n)) return false
			taken.delete(n)
			heads.delete(n)
			// most often among the last taken
			const i = order.lastIndexOf(kept)
			if (i >= 0) order.splice(i, 1)
			for (const p of kept.parents) {
				const h = hex(p), c = children.get(h)! - 1
				if (c > 0) children.set(h, c)
				else {
					children.delete(h)
					if (taken.has(h)) heads.add(h)
				}
			}
			return true
		},
	}
}

// the agreed order: higher lamport first; equal, the greater name
export const agreed = (a: Kept, b: Kept) =>
	a.lamport !== b.lamport ? b.lamport - a.lamport : compare(b.name, a.name)

// what a commit's tables follow from: a merge's parents, else its base (a commit with a base keeps
// what that one held, whatever its other parents did), else its parents (key patches on all of
// them; none: a root)
export function follows(k: Kept): Uint8Array[] {
	return k.merge !== undefined || k.base === undefined ? k.parents : [k.base]
}

// the commits since heads' common ancestors, along follows. walked back from the heads in the
// agreed order, a frontier of what is not walked yet; from: the first frontier that every commit
// walked follows from, all of it (so nothing since is beside it), and known says its tables can be
// had (one commit's, or several merged). a frontier of one commit is such once no root is walked;
// none: from nothing (empty), every commit back to the roots. from in the agreed order; commits: the
// ones walked, in causal
// order, lower lamport first, equal lamport the lesser name first
export function since(
	history: History,
	heads: readonly Kept[],
	known: (from: readonly Kept[]) => boolean = () => true,
): { from: Kept[]; commits: Kept[] } {
	const frontier = new Map<string, Kept>()
	for (const k of heads) frontier.set(hex(k.name), k)
	const walked: Kept[] = [], seen = new Set<string>()
	let root = false
	// every commit walked follows from all of the frontier
	const under = () => {
		const reach = new Map<string, Set<string>>()
		for (let i = walked.length - 1; i >= 0; i--) {
			const got = new Set<string>()
			for (const p of follows(walked[i])) {
				const h = hex(p)
				if (frontier.has(h)) got.add(h)
				else for (const x of reach.get(h) ?? []) got.add(x)
			}
			if (got.size !== frontier.size) return false
			reach.set(hex(walked[i].name), got)
		}
		return true
	}
	for (;;) {
		if (frontier.size === 0) return { from: [], commits: walked.reverse() }
		if (!root) {
			const from = [...frontier.values()].sort(agreed)
			if ((from.length === 1 || walked.length === 0) && known(from)) {
				return { from, commits: walked.reverse() }
			}
			if (from.length > 1 && walked.length > 0 && known(from) && under()) {
				return { from, commits: walked.reverse() }
			}
		}
		let top: Kept | undefined
		for (const k of frontier.values()) if (top === undefined || agreed(k, top) < 0) top = k
		const n = hex(top!.name)
		frontier.delete(n)
		seen.add(n)
		walked.push(top!)
		const up = follows(top!)
		if (up.length === 0) root = true
		for (const p of up) {
			const h = hex(p)
			if (seen.has(h) || frontier.has(h)) continue
			const k = history.get(p)
			if (k !== undefined) frontier.set(h, k)
		}
	}
}
