// Many stored blops as one Subduction fragment (FRAGMENT.tex): the walk from a head, and the build
// over a document's heads. Ids are stored ids, 32 bytes. Subduction's build_fragment_store and
// fragment (sedimentree_core, commit.rs), over what the device holds: lookup and known are the host's
export type Fragment = {
	head: Uint8Array
	members: Uint8Array[]
	boundary: Uint8Array[]
	checkpoints: Uint8Array[]
}

// a commit's parents, or undefined: not here
export type Lookup = (id: Uint8Array) => Uint8Array[] | undefined
// a fragment here, by head
export type Known = (head: Uint8Array) => Fragment | undefined

export type Code = "missing" | "depth-zero"

export class FragmentError extends Error {
	constructor(readonly code: Code) {
		super(code)
	}
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16))

// the number of leading zero bytes
export function depth(id: Uint8Array): number {
	let n = 0
	while (n < id.length && id[n] === 0) n++
	return n
}

// one fragment, from a head of depth 1 or more
export function walk(head: Uint8Array, lookup: Lookup, known: Known): Fragment {
	const deep = depth(head)
	if (deep === 0) throw new FragmentError("depth-zero")
	const first = lookup(head)
	if (!first) throw new FragmentError("missing")
	const h = hex(head)
	const visited = new Set([h]), members = new Set([h])
	const boundary = new Set<string>(), checkpoints = new Set<string>()
	const queue = first.map(hex)
	for (let id; (id = queue.pop()) !== undefined;) {
		if (visited.has(id)) continue
		visited.add(id)
		const parents = lookup(unhex(id))
		if (!parents) throw new FragmentError("missing")
		const d = depth(unhex(id))
		if (d >= deep) boundary.add(id)
		else {
			members.add(id)
			if (d > 0) checkpoints.add(id)
			for (const p of parents) if (!visited.has(hex(p))) queue.push(hex(p))
		}
	}
	// the fragments here whose heads are boundary commits are below this one
	for (const b of boundary) {
		for (const m of known(unhex(b))?.members ?? []) {
			members.delete(hex(m))
			checkpoints.delete(hex(m))
		}
	}
	return {
		head,
		members: [...members].map(unhex),
		boundary: [...boundary].map(unhex),
		checkpoints: [...checkpoints].map(unhex),
	}
}

// the new fragments for these heads: from each, every commit once, then each new fragment loses the
// members and checkpoints of every fragment reached through its boundary commits
export function build(heads: Uint8Array[], lookup: Lookup, known: Known): Fragment[] {
	const made = new Map<string, Fragment>()
	const here: Known = (head) => made.get(hex(head)) ?? known(head)
	const fresh: string[] = []
	const visited = new Set<string>()
	const queue = heads.map(hex)
	for (let id; (id = queue.pop()) !== undefined;) {
		if (visited.has(id)) continue
		visited.add(id)
		const bytes = unhex(id)
		const have = here(bytes)
		if (have) {
			for (const b of have.boundary) queue.push(hex(b))
			continue
		}
		if (depth(bytes) === 0) {
			for (const p of lookup(bytes) ?? []) queue.push(hex(p))
			continue
		}
		try {
			const fragment = walk(bytes, lookup, here)
			for (const b of fragment.boundary) queue.push(hex(b))
			made.set(id, fragment)
			fresh.push(id)
		} catch (e) {
			// a commit it needs is not here: no fragment for this head
			if (!(e instanceof FragmentError && e.code === "missing")) throw e
		}
	}
	// every fresh fragment is made: strip the members of all the fragments below it
	for (const id of fresh) {
		const fragment = made.get(id)!
		const below = new Set<string>(), seen = new Set<string>()
		const todo = fragment.boundary.map(hex)
		for (let b; (b = todo.pop()) !== undefined;) {
			if (seen.has(b)) continue
			seen.add(b)
			const f = here(unhex(b))
			if (!f) continue
			for (const m of f.members) below.add(hex(m))
			for (const x of f.boundary) todo.push(hex(x))
		}
		if (below.size) {
			fragment.members = fragment.members.filter((m) => !below.has(hex(m)))
			fragment.checkpoints = fragment.checkpoints.filter((m) => !below.has(hex(m)))
		}
	}
	return fresh.map((id) => made.get(id)!)
}
