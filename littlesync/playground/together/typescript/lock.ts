// the lock: what a commit is closed into before any carrier takes it, and opened from where it lands
// (encryption, or nothing). a carrier (the subduction stack, a gateway) calls it; none of them owns
// it. doc: the document's id, its bytes (18 or 34, its code says which: ermine/ids); name and parents: the commit's, given so a lock can bind them
// (they travel in clear: a carrier needs the history's shape). name: a commit's, or a fragment's: the
// multihash of its BLAKE3 (1e20 then the digest, as a commit's name is). only "unlocked" is built

// what a lock's open gives: the bytes close was given; not yet (no key here yet: wait); or never
// (refused: the text is shown beside the code lock wherever the refusal shows). a stored commit or a
// fragment that waits is held and opened again when the lock changes (the device's changed); an
// ephemeral commit that waits is dropped, and comes back with its device's next beat (it is sent again)
export type Opened = Uint8Array | { wait: true } | { refused: string }

export type Lock = {
	close(
		doc: Uint8Array,
		name: Uint8Array,
		parents: Uint8Array[],
		bytes: Uint8Array,
	): Uint8Array | Promise<Uint8Array>
	open(doc: Uint8Array, bytes: Uint8Array): Opened | Promise<Opened>
}

// close and open give back what they are given
export const unlocked: Lock = { close: (_d, _n, _p, bytes) => bytes, open: (_d, bytes) => bytes }
