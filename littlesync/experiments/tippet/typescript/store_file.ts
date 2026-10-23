// a log's store on disk (deno): records appended to dir/log as frames (4 bytes big-endian length,
// then the record), the snapshot in dir/snapshot, written whole beside it then renamed into place,
// and the device's key in dir/key, written once; dir made on the first write. a frame cut short by
// a crash is cut off when loaded, so the next append starts clean. records are read back from the
// file by where they are: in memory, only where each one holding steps starts and how long it is.
// sync: every append so far on disk, through a power cut
//
//   const log = createLog({ store: fileStore("./data/pigs"), writes: true })
//   await log.close()
import { createIndex, type Store } from "./log.ts"

export function fileStore(dir: string): Store {
	const records = `${dir}/log`, snap = `${dir}/snapshot`, keyfile = `${dir}/key`
	// dir, made on the first write
	let made: Promise<void> | undefined
	const ready = () => made ??= Deno.mkdir(dir, { recursive: true })
	const read = (path: string) =>
		Deno.readFile(path).catch((e) => {
			if (e instanceof Deno.errors.NotFound) return undefined
			throw e
		})
	// records holding steps, by where they start: their bytes until they are on disk
	const written = new Map<number, Uint8Array>()
	// the file's length, with every append so far
	let end = 0
	let writing: Promise<unknown> = Promise.resolve()
	let file: Deno.FsFile | undefined
	// a record, by where it starts and how long it is
	const index = createIndex<[number, number]>(([at, size]) => {
		const unwritten = written.get(at)
		if (unwritten) return unwritten
		const out = new Uint8Array(size)
		file ??= Deno.openSync(records)
		file.seekSync(at, Deno.SeekMode.Start)
		for (let got = 0; got < out.length;) {
			const n = file.readSync(out.subarray(got))
			if (n === null) throw new Error("the store's file is shorter than it was")
			got += n
		}
		return out
	})

	return {
		async load(each) {
			const bytes = await read(records) ?? new Uint8Array()
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			index.clear()
			let at = 0
			// a record is never empty: a zero length is a tail never written (a power cut), and ends it
			while (
				at + 4 <= bytes.length && view.getUint32(at) > 0 &&
				at + 4 + view.getUint32(at) <= bytes.length
			) {
				const size = view.getUint32(at), held = each(bytes.slice(at + 4, at + 4 + size))
				if (held) index.hold(held, [at + 4, size])
				at += 4 + size
			}
			if (at < bytes.length) await Deno.truncate(records, at)
			end = at
			return await read(snap)
		},
		append(record, held) {
			const frame = new Uint8Array(4 + record.length), at = end + 4
			new DataView(frame.buffer).setUint32(0, record.length)
			frame.set(record, 4)
			if (held) index.hold(held, [at, record.length]), written.set(at, record)
			end += frame.length
			writing = writing.catch(() => {}).then(async () => {
				await ready()
				await Deno.writeFile(records, frame, { append: true })
				written.delete(at)
			})
			return writing as Promise<void>
		},
		run: index.run,
		get: index.get,
		drop: index.drop,
		async snapshot(bytes) {
			await ready()
			await Deno.writeFile(`${snap}.new`, bytes)
			await Deno.rename(`${snap}.new`, snap)
		},
		async key(seed) {
			await ready()
			try {
				await Deno.writeFile(keyfile, seed, { createNew: true, mode: 0o600 })
				return seed
			} catch (e) {
				if (!(e instanceof Deno.errors.AlreadyExists)) throw e
				const key = await Deno.readFile(keyfile)
				if (key.length !== 32) throw new Error(`${keyfile} is not a key`)
				return key
			}
		},
		async sync() {
			await writing
			const f = await Deno.open(records, { write: true })
			await f.syncData().finally(() => f.close())
		},
		close() {
			file?.close()
			file = undefined
		},
	}
}
