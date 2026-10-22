// a log's store on disk (deno): records appended to dir/log as frames (4 bytes big-endian length,
// then the record), and the snapshot in dir/snapshot, written whole beside it then renamed into
// place. a frame cut short by a crash is cut off when loaded, so the next append starts clean
//
//   const log = createLog({ store: fileStore("./data/pigs"), signer })
import type { Store } from "./log.ts"

export function fileStore(dir: string): Store {
	const records = `${dir}/log`, snap = `${dir}/snapshot`
	const ready = Deno.mkdir(dir, { recursive: true })
	const read = (path: string) =>
		Deno.readFile(path).catch((e) => {
			if (e instanceof Deno.errors.NotFound) return undefined
			throw e
		})
	return {
		async load() {
			await ready
			const bytes = await read(records) ?? new Uint8Array()
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			const out: Uint8Array[] = []
			let at = 0
			// a record is never empty: a zero length is a tail never written (a power cut), and ends it
			while (
				at + 4 <= bytes.length && view.getUint32(at) > 0 &&
				at + 4 + view.getUint32(at) <= bytes.length
			) {
				out.push(bytes.slice(at + 4, at + 4 + view.getUint32(at)))
				at += 4 + view.getUint32(at)
			}
			if (at < bytes.length) await Deno.truncate(records, at)
			return { records: out, snapshot: await read(snap) }
		},
		async append(record) {
			await ready
			const frame = new Uint8Array(4 + record.length)
			new DataView(frame.buffer).setUint32(0, record.length)
			frame.set(record, 4)
			await Deno.writeFile(records, frame, { append: true })
		},
		async snapshot(bytes) {
			await ready
			await Deno.writeFile(`${snap}.new`, bytes)
			await Deno.rename(`${snap}.new`, snap)
		},
	}
}
