// a log's store on disk (deno): records appended to dir/log as frames (4 bytes big-endian length,
// then the record), the snapshot in dir/snapshot, written whole beside it then renamed into place,
// and the device's key in dir/key, written once; dir made on the first write. a frame cut short by
// a crash is cut off when loaded, so the next append starts clean. records are read back from the
// file by where they are: in memory, only where each one holding steps starts and how long it is.
// sync: every append so far on disk, through a power cut
//
// open steps (this device's, not yet in a closed run): in memory, and in dir/open as frames, written
// only by a sync, after the log's: those not yet there appended; and once every step there is in a
// run on disk, it is emptied first. a step is written to dir/open only if no run held it by the sync
// after it. loaded: a frame cut short cut off (and that synced), a step held already passed over
//
//   const log = createLog({ store: fileStore("./data/pigs"), writes: true })
//   await log.close()
import { createIndex, type Store } from "./log.ts"

// steps as frames back to back
const framed = (steps: Uint8Array[]) => {
	const out = new Uint8Array(steps.reduce((k, s) => k + 4 + s.length, 0))
	const view = new DataView(out.buffer)
	let at = 0
	for (const s of steps) view.setUint32(at, s.length), out.set(s, at + 4), at += 4 + s.length
	return out
}
// the whole frames at the start of bytes: each record, and where they end
const frames = (bytes: Uint8Array) => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = []
	let at = 0
	// a record is never empty: a zero length is a tail never written (a power cut), and ends it
	while (
		at + 4 <= bytes.length && view.getUint32(at) > 0 &&
		at + 4 + view.getUint32(at) <= bytes.length
	) {
		const size = view.getUint32(at)
		out.push({ at: at + 4, record: bytes.slice(at + 4, at + 4 + size) })
		at += 4 + size
	}
	return { frames: out, end: at }
}

export function fileStore(dir: string): Store {
	const records = `${dir}/log`, snap = `${dir}/snapshot`, keyfile = `${dir}/key`
	const opens = `${dir}/open`
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
	// dir/open: the n of its first step and how many follow; dirty: it holds a frame that is no
	// open step (held, or not one)
	let filed = { first: 0, count: 0 }, dirty = false
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
			index.clear()
			const log = frames(bytes)
			for (const { at, record } of log.frames) {
				const held = each(record)
				if (held) index.hold(held, [at, record.length])
			}
			if (log.end < bytes.length) await Deno.truncate(records, log.end)
			end = log.end
			const open = await read(opens) ?? new Uint8Array(), o = frames(open)
			filed = { first: 0, count: 0 }, dirty = false
			for (const { record } of o.frames) {
				const held = each(record)
				if (!held) dirty = true
				else {
					index.open(record, held)
					if (!filed.count) filed.first = held[1]
					filed.count++
				}
			}
			// cut where it was torn, and that on disk: what is appended next lands after a whole frame
			if (o.end < open.length) {
				await Deno.truncate(opens, o.end)
				const f = await Deno.open(opens, { write: true })
				await f.syncData().finally(() => f.close())
			}
			return await read(snap)
		},
		open: index.open,
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
		// the log on disk, then dir/open made to hold the open steps
		sync() {
			const p = writing.catch(() => {}).then(async () => {
				if (end) {
					const f = await Deno.open(records, { write: true })
					await f.syncData().finally(() => f.close())
				}
				const o = index.opened(), steps = o?.steps ?? []
				const first = steps.length ? o!.first : Infinity
				// emptied when every step there is in a run on disk now (and none is open)
				const stale = dirty || (filed.count > 0 && filed.first < first)
				const empty = stale && !(filed.count > 0 && filed.first + filed.count > first)
				if (empty) filed = { first, count: 0 }, dirty = false
				else if (!filed.count) filed.first = first
				const write = steps.slice(Math.max(0, filed.first + filed.count - first))
				if (!write.length && !empty) return
				await ready()
				await Deno.writeFile(opens, framed(write), { append: !empty })
				const g = await Deno.open(opens, { write: true })
				await g.syncData().finally(() => g.close())
				filed.count += write.length
			})
			writing = p
			return p
		},
		close() {
			file?.close()
			file = undefined
		},
	}
}
