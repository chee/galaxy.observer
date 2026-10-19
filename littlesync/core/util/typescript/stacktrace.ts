export type FileLocation = { file: string; line: number; column?: number; function?: string }

// one line of a stack, as V8 writes it ("    at fn (file:1:2)", "    at file:1:2")
// or as JavaScriptCore and SpiderMonkey do ("fn@file:1:2", "@file:1:2")
const V8 = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/
const AT = /^(.*?)@(.+?):(\d+):(\d+)\s*$/

// the frames of a stack, top first; lines that are not frames are left out.
// one way of writing per stack: a V8 stack's message line is never read as a frame
export function frames(stack: string): FileLocation[] {
	const lines = stack.split("\n")
	const way = lines.some((l) => V8.test(l)) ? V8 : AT
	const out: FileLocation[] = []
	for (const raw of lines) {
		const m = way.exec(raw)
		if (!m) continue
		const [, name, file, line, column] = m
		const site: FileLocation = { file, line: Number(line), column: Number(column) }
		if (name) site.function = name
		out.push(site)
	}
	return out
}

// the first frame whose file is not one of ours
export function outside(stack: string, ours: ReadonlySet<string>): FileLocation | undefined {
	return frames(stack).find((f) => !ours.has(f.file))
}

type V8Error = {
	captureStackTrace?: (holder: object, entry?: unknown) => void
	stackTraceLimit?: number
}

// the site of the call into entry: the first frame now on the stack outside ours.
// entry, where the engine allows, cuts the frames above it
export function capture(ours: ReadonlySet<string>, entry?: unknown): FileLocation | undefined {
	const E = Error as unknown as V8Error
	const limit = E.stackTraceLimit
	if (typeof limit === "number" && limit < 10) E.stackTraceLimit = 10
	try {
		const holder: { stack?: string } = {}
		if (typeof E.captureStackTrace === "function" && typeof entry === "function") {
			E.captureStackTrace(holder, entry)
		} else holder.stack = new Error().stack
		return typeof holder.stack === "string" ? outside(holder.stack, ours) : undefined
	} finally {
		if (typeof limit === "number") E.stackTraceLimit = limit
	}
}
