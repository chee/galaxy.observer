// a node's tables at a head, packed (extensions/subduction/plan.org, Rewrite for the new shape, 5):
// each kept table's entry, value and change, as pack.ts writes a node. read back as new objects
// each time: replay applies to them in place
import { pack, unpack } from "@ermine/formats/pack"
import type { Tables } from "./replay.ts"

// the id a snapshot's entries are under: the node is the snapshot's, so none of its own
const AT = ""

export function snapshot(tables: Tables): Uint8Array {
	return pack(Object.entries(tables).map(([table, entry]) => [table, AT, entry] as const), {
		op: false,
	})
}

export function tablesOf(bytes: Uint8Array): Tables {
	const out: Tables = {}
	for (const [table, , entry] of unpack(bytes)) out[table as string] = entry
	return out
}

// two nodes' tables the same: the same tables, each one's entry packed alike
export function alike(a: Tables, b: Tables): boolean {
	const by = (x: string, y: string) => x < y ? -1 : x > y ? 1 : 0
	const ka = Object.keys(a).sort(by), kb = Object.keys(b).sort(by)
	return ka.length === kb.length && ka.every((t, i) => {
		if (kb[i] !== t) return false
		const x = snapshot({ [t]: a[t] }), y = snapshot({ [t]: b[t] })
		return x.length === y.length && x.every((v, j) => v === y[j])
	})
}
