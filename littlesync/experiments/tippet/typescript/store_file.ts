// a log's store on disk (deno): records appended to dir/log as frames (4 bytes big-endian length,
// then the record), the snapshot in dir/snapshot, written whole beside it then renamed into place,
// and the device's key in dir/key, written once; dir made on the first write. a frame cut short by
// a crash is cut off when loaded, so the next append starts clean. steps are read back from the
// file by where they are: in memory, only where each one starts and how long it is. sync: every
// append so far on disk, through a power cut
//
//   const log = createLog({ store: fileStore("./data/pigs"), writes: true })
//   await log.close()
import type { At, Store } from "./log.ts"

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
	// each step held: where its record starts in the file and how long it is, by device, two
	// numbers a step; written: its bytes until they are on disk
	let where = new Map<string, number[]>()
	const written = new Map<string, Uint8Array>()
	const name = ([d, n]: At) => `${n} ${d}`
	// the file's length, with every append so far
	let end = 0
	let writing: Promise<unknown> = Promise.resolve()
	let file: Deno.FsFile | undefined
	const hold = ([d, n]: At, at: number, size: number) => {
		let list = where.get(d)
		if (!list) where.set(d, list = [])
		list[2 * n - 2] = at, list[2 * n - 1] = size
	}

	return {
		async load(each) {
			const bytes = await read(records) ?? new Uint8Array()
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			where = new Map()
			let at = 0
			// a record is never empty: a zero length is a tail never written (a power cut), and ends it
			while (
				at + 4 <= bytes.length && view.getUint32(at) > 0 &&
				at + 4 + view.getUint32(at) <= bytes.length
			) {
				const size = view.getUint32(at), step = each(bytes.slice(at + 4, at + 4 + size))
				if (step) hold(step, at + 4, size)
				at += 4 + size
			}
			if (at < bytes.length) await Deno.truncate(records, at)
			end = at
			return await read(snap)
		},
		append(record, step) {
			const frame = new Uint8Array(4 + record.length)
			new DataView(frame.buffer).setUint32(0, record.length)
			frame.set(record, 4)
			if (step) hold(step, end + 4, record.length), written.set(name(step), record)
			end += frame.length
			writing = writing.catch(() => {}).then(async () => {
				await ready()
				await Deno.writeFile(records, frame, { append: true })
				if (step) written.delete(name(step))
			})
			return writing as Promise<void>
		},
		get(d, n) {
			const unwritten = written.get(name([d, n]))
			if (unwritten) return unwritten
			const list = where.get(d)!, out = new Uint8Array(list[2 * n - 1])
			file ??= Deno.openSync(records)
			file.seekSync(list[2 * n - 2], Deno.SeekMode.Start)
			for (let at = 0; at < out.length;) {
				const got = file.readSync(out.subarray(at))
				if (got === null) throw new Error("the store's file is shorter than it was")
				at += got
			}
			return out
		},
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
