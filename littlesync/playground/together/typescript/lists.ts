// lists: what each path of a node holds, from the commits a device holds (values.org; the rules as
// lean/Together/Basic.lean has them: replaced, entry, under, owned, inside, open). a path is the
// table, then map keys.
//
// a write: a patch, at its key path. a path ends at the first list: a patch through a list index,
// a range or a move is a write of the whole value at its key path (keep-both: two ranges at one
// string are two whole strings), its value the commit's tables there (after). a patch followed in
// its commit by one at a prefix of its path is no write (the commit overwrote it).
// replaced: a later write at or above its path names it in replaces, or an ancestor of it (clamped:
// only names that are its own ancestors count); absent replaces: every ancestor at or under its path.
// standing: not replaced. a delete stands as gone. a path's items: its standing writes in the agreed
// order (higher lamport first, then the greater name), each marked inside when a standing write under
// it is not its own (owned: the same commit, or a descendant of it); under a write marked so, the
// deep path's items go on with the shallow write's value there (at: its path). open: a path of two
// items or more, or one marked inside.
//
// a merge by a rule: a whole write of each table, its value the rule's (after).
//
// the node is the first item at each path, composed shallow to deep: a deep write's missing parents
// made as maps (sync only: core's apply stays strict); one under a value that is not a map, left out.
import apply, { type Patch } from "@ermine/op/apply"
import { type Commit, compare, decode } from "@ermine/encoding/commit"
import type { Entry } from "@ermine/node/entry"
import { agreed, type History, type Kept } from "./history.ts"
import { changeOf, type Tables } from "./replay.ts"

export type Key = string | number

export type Write = {
	kept: Kept
	commit: Commit
	// the table, then keys
	path: Key[]
	// a set's value; whole: the commit's tables at path, once asked
	value?: unknown
	gone?: true
	whole?: true
	replaces?: Uint8Array[]
}

// an item of a path: a standing write there, or (at) a shallow one's value at it
export type Item = { write: Write; value?: unknown; gone?: true; inside?: true; at?: Key[] }

export type Lists = {
	// a commit, its parents added already
	add(kept: Kept, commit?: Commit): void
	// how many commits added
	readonly size: number
	// the items at path, first shown first; none: []
	items(path: readonly Key[]): Item[]
	// the standing writes at path and under it, each path's first shown first
	standing(path: readonly Key[]): Write[][]
	// every open path, with its items, shallow first
	open(): { path: Key[]; items: Item[] }[]
	// the node: each table's first items composed; choose: its writes first wherever it has one,
	// and nothing it does not own under them
	compose(choose?: Kept): Tables
}

type Node = { writes: Write[]; kids: Map<Key, Node> }

const isMap = (v: unknown): v is Record<string, unknown> => {
	if (v === null || typeof v !== "object" || Array.isArray(v)) return false
	const p = Object.getPrototypeOf(v)
	return p === Object.prototype || p === null
}
const prefix = (a: readonly Key[], b: readonly Key[]) =>
	a.length <= b.length && a.every((k, i) => k === b[i])
const by = (a: Write, b: Write) => agreed(a.kept, b.kept)

// the value at keys, or undefined
export function dig(v: unknown, keys: readonly Key[]): unknown {
	for (const k of keys) {
		if (v === null || typeof v !== "object") return undefined
		v = (v as Record<Key, unknown>)[k]
	}
	return v
}

// the key path a path makes: up to the first list index
const keyed = (path: readonly Key[]) => {
	const i = path.findIndex((k) => typeof k !== "string")
	return i < 0 ? path.slice() : path.slice(0, i)
}
// a patch with a range, a move or a list index
const whole = (p: Patch) =>
	p.range !== undefined || p.move !== undefined || p.path.some((k) => typeof k !== "string")

// a commit's writes, in its patches' order, as written
function writesOf(kept: Kept, commit: Commit): Write[] {
	const all: Write[] = []
	for (const p of commit.patches) {
		const w: Write = { kept, commit, path: [commit.table, ...keyed(p.path)] }
		if (p.replaces !== undefined) w.replaces = p.replaces
		if (whole(p)) w.whole = true
		else if ("value" in p) w.value = p.value
		else w.gone = true
		all.push(w)
		if (p.move !== undefined) {
			all.push({ ...w, path: [commit.table, ...keyed(p.move.path)], whole: true })
		}
	}
	return all.filter((w, i) => !all.slice(i + 1).some((l) => prefix(l.path, w.path)))
}

// patches applied as sync takes them, in place (cow false): a key patch's missing parents made as
// maps; one under a value that is not a map left out (a clash, which the lists keep); the rest as
// apply has them. the value after
export function applies(value: unknown, patches: readonly Patch[]): unknown {
	for (const p of patches) {
		if (whole(p) || p.path.length === 0) {
			value = apply(value, [p], { cow: false })
			continue
		}
		if (value === undefined) {
			if (!("value" in p)) continue
			value = {}
		}
		let at = value
		let ok = isMap(at)
		for (let i = 0; ok && i < p.path.length - 1; i++) {
			const m = at as Record<string, unknown>, k = p.path[i] as string
			if (m[k] === undefined) {
				if (!("value" in p)) ok = false
				else m[k] = {}
			}
			at = m[k]
			ok &&= isMap(at)
		}
		if (!ok) continue
		const m = at as Record<string, unknown>, k = p.path[p.path.length - 1] as string
		if ("value" in p) m[k] = p.value
		else delete m[k]
	}
	return value
}

// after: a commit's tables (new), for a whole write's value
export function createLists(history: History, after: (k: Kept) => Tables): Lists {
	const root: Node = { writes: [], kids: new Map() }
	let size = 0
	// one line of commits, each on the one before: ancestry is lamport
	let forked = false
	let tip: Kept | undefined

	// a an ancestor of c
	function anc(a: Kept, c: Kept): boolean {
		if (a.lamport >= c.lamport) return false
		if (!forked) return true
		const todo = [c], seen = new Set<Kept>()
		while (todo.length) {
			for (const p of todo.pop()!.parents) {
				const q = history.get(p)
				if (q === undefined || seen.has(q) || q.lamport < a.lamport) continue
				if (q === a) return true
				seen.add(q)
				todo.push(q)
			}
		}
		return false
	}
	// what w names, clamped to its own ancestors, covers s: named, or an ancestor of one named
	function covers(w: Write, s: Write): boolean {
		if (s.kept === w.kept) return false
		if (w.replaces === undefined) return anc(s.kept, w.kept)
		for (const n of w.replaces) {
			const x = history.get(n)
			if (x === undefined || !anc(x, w.kept)) continue
			if (s.kept === x || anc(s.kept, x)) return true
		}
		return false
	}
	const owns = (c: Write, d: Write) => c.kept === d.kept || anc(c.kept, d.kept)

	function reach(path: readonly Key[], make: boolean): Node | undefined {
		let n = root
		for (const k of path) {
			let next = n.kids.get(k)
			if (next === undefined) {
				if (!make) return undefined
				n.kids.set(k, next = { writes: [], kids: new Map() })
			}
			n = next
		}
		return n
	}
	function* below(n: Node): Generator<Node> {
		yield n
		for (const k of n.kids.values()) yield* below(k)
	}

	// a merge by a rule: a whole write of each table it holds, or one an ancestor wrote (gone, when
	// it holds none)
	function merged(kept: Kept, commit: Commit): Write[] {
		const tables = after(kept), out: Write[] = []
		for (const [t, n] of root.kids) {
			if (t in tables || [...below(n)].some((m) => m.writes.some((w) => anc(w.kept, kept)))) {
				out.push({ kept, commit, path: [t], whole: true })
			}
		}
		for (const t of Object.keys(tables)) {
			if (!root.kids.has(t)) out.push({ kept, commit, path: [t], whole: true })
		}
		return out
	}

	// a write's value: as written, or its commit's tables at its path
	function valueOf(w: Write): { value?: unknown; gone?: true } {
		if (w.whole && !("value" in w) && !w.gone) {
			const v = dig(after(w.kept)[w.path[0] as string]?.value, w.path.slice(1))
			if (v === undefined) w.gone = true
			else w.value = v
		}
		return w.gone ? { gone: true } : { value: w.value }
	}

	// the standing writes, each node's sorted; inside marks and the shallow writes over each path
	type Seen = { inside: Set<Write>; over: Map<Node, Write[]> }
	let seen: Seen | undefined
	function look(): Seen {
		if (seen !== undefined) return seen
		const inside = new Set<Write>(), over = new Map<Node, Write[]>()
		const walk = (n: Node, above: Write[]) => {
			n.writes.sort(by)
			for (const d of n.writes) {
				for (const c of above) {
					if (owns(c, d)) continue
					inside.add(c)
					const o = over.get(n) ?? []
					if (!o.includes(c)) o.push(c)
					over.set(n, o)
				}
			}
			const next = n.writes.length ? [...above, ...n.writes] : above
			for (const k of n.kids.values()) walk(k, next)
		}
		walk(root, [])
		for (const o of over.values()) o.sort(by)
		return seen = { inside, over }
	}

	function itemsOf(n: Node, path: readonly Key[]): Item[] {
		const { inside, over } = look()
		const out: Item[] = n.writes.map((w) => ({
			write: w,
			...valueOf(w),
			...inside.has(w) && { inside: true as const },
		}))
		for (const c of over.get(n) ?? []) {
			const v = valueOf(c)
			const at = v.gone ? undefined : dig(v.value, path.slice(c.path.length))
			out.push({
				write: c,
				...at === undefined ? { gone: true as const } : { value: at },
				...inside.has(c) && { inside: true as const },
				at: c.path,
			})
		}
		return out
	}

	return {
		add(kept, commit = decode(kept.bytes)) {
			size++
			if (!forked) {
				const on = tip === undefined
					? kept.parents.length === 0
					: kept.parents.length === 1 && compare(kept.parents[0], tip.name) === 0
				if (on) tip = kept
				else forked = true
			}
			seen = undefined
			const ws = commit.merge === undefined ? writesOf(kept, commit) : merged(kept, commit)
			for (const w of ws) {
				for (const n of below(reach(w.path, true)!)) {
					n.writes = n.writes.filter((s) => !covers(w, s))
				}
			}
			for (const w of ws) reach(w.path, true)!.writes.push(w)
		},
		standing(path) {
			const n = reach(path, false)
			if (n === undefined) return []
			look()
			return [...below(n)].filter((m) => m.writes.length).map((m) => m.writes.slice())
		},
		get size() {
			return size
		},
		items(path) {
			const n = reach(path, false)
			return n === undefined ? [] : itemsOf(n, path)
		},
		open() {
			const { inside, over } = look()
			const out: { path: Key[]; items: Item[] }[] = []
			const walk = (n: Node, path: Key[]) => {
				if (n.writes.length > 1 || n.writes.some((w) => inside.has(w)) || over.has(n)) {
					out.push({ path, items: itemsOf(n, path) })
				}
				for (const [k, c] of n.kids) walk(c, [...path, k])
			}
			walk(root, [])
			return out
		},
		compose(choose) {
			look()
			const out: Tables = {}
			for (const [table, top] of root.kids) {
				let value: unknown, last: Write | undefined
				// shallow to deep; owner: choose's write above, whose unowned writes under it are left out
				const walk = (n: Node, keys: Key[], owner: Write | undefined) => {
					const o = owner
					const ws = o === undefined ? n.writes : n.writes.filter((d) => owns(o, d))
					const w = ws.find((d) => d.kept === choose) ?? ws[0]
					if (w !== undefined) {
						if (last === undefined || by(w, last) < 0) last = w
						const v = valueOf(w)
						value = put(value, keys, v.gone ? undefined : structuredClone(v.value), !!v.gone)
						if (choose !== undefined && w.kept === choose) owner ??= w
					}
					for (const [k, c] of n.kids) walk(c, [...keys, k], owner)
				}
				walk(top, [], undefined)
				if (value !== undefined && last !== undefined) {
					out[table as string] = {
						value,
						change: changeOf(last.commit, last.kept.name),
					} as Entry<unknown>
				}
			}
			return out
		},
	}
}

// v at keys in root (gone: taken out): missing parents made as maps; under a value not a map,
// nothing. the root after
function put(root: unknown, keys: readonly Key[], v: unknown, gone: boolean): unknown {
	if (keys.length === 0) return gone ? undefined : v
	if (root === undefined) {
		if (gone) return root
		root = {}
	}
	if (!isMap(root)) return root
	let at: Record<string, unknown> = root
	for (const k of keys.slice(0, -1)) {
		let next = at[k as string]
		if (next === undefined) {
			if (gone) return root
			next = at[k as string] = {}
		}
		if (!isMap(next)) return root
		at = next
	}
	const k = keys[keys.length - 1] as string
	if (gone) delete at[k]
	else at[k] = v
	return root
}

// a node's tables from the commits given and their ancestors: the lists of those, composed. after:
// a commit's tables, for a whole write's value
export function state(
	history: History,
	heads: readonly Kept[],
	after: (k: Kept) => Tables,
): Tables {
	const mine = new Set<Kept>(heads), todo = [...heads]
	while (todo.length) {
		for (const p of todo.pop()!.parents) {
			const q = history.get(p)
			if (q !== undefined && !mine.has(q)) mine.add(q), todo.push(q)
		}
	}
	const lists = createLists(history, after)
	for (const k of history.all()) if (mine.has(k)) lists.add(k)
	return lists.compose()
}
