// One-off: copy every document from the old automerge-repo server's Postgres
// storage (starlight) into the Subduction server, under the same document IDs.
//
// Rows are automerge-repo storage chunks keyed [docId, kind, hash]; "snapshot"
// and "incremental" chunks rebuild a document, "sync-state" rows are skipped.
// Each rebuilt document is saved whole and handed to automerge-subduction-ingest,
// which uploads it under the zero-padded legacy ID, so old automerge: URLs work.
//
// Env: DATABASE_URL, AUTOMERGE_TABLE (default "starlight"), SERVER (a ws(s) url),
// SERVICE_NAME (default: the server's host), DRY_RUN=1 to rebuild and report
// without uploading.

import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import * as A from "@automerge/automerge";
import pg from "pg";

const run = promisify(execFile);
const table = process.env.AUTOMERGE_TABLE ?? "starlight";
const server = process.env.SERVER;
const dryRun = process.env.DRY_RUN === "1";
const serviceName = process.env.SERVICE_NAME ? ["--service-name", process.env.SERVICE_NAME] : [];
if (!server && !dryRun) throw new Error("SERVER is required unless DRY_RUN=1");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query(`select key, value from ${pg.escapeIdentifier(table)}`);
await pool.end();

// key is a bytea[]: [docId, kind, hash]
const docs = new Map();
const kinds = {};
for (const row of rows) {
	const [id, kind] = row.key.map(part => Buffer.from(part).toString("utf8"));
	kinds[kind] = (kinds[kind] ?? 0) + 1;
	if (kind !== "snapshot" && kind !== "incremental") continue;
	if (!docs.has(id)) docs.set(id, { snapshots: [], incrementals: [] });
	docs.get(id)[kind === "snapshot" ? "snapshots" : "incrementals"].push(Uint8Array.from(row.value));
}
console.log(`${rows.length} rows in ${table}: ${JSON.stringify(kinds)}; ${docs.size} documents`);

const dir = await mkdtemp(path.join(tmpdir(), "starlight-"));
const failed = [];
let uploaded = 0;
let bytes = 0;
for (const [id, chunks] of docs) {
	let doc;
	try {
		doc = A.init();
		for (const chunk of [...chunks.snapshots, ...chunks.incrementals]) doc = A.loadIncremental(doc, chunk);
	} catch (e) {
		failed.push([id, `rebuild: ${e.message}`]);
		continue;
	}
	const saved = A.save(doc);
	bytes += saved.length;
	const changes = A.getAllChanges(doc).length;
	if (changes === 0) {
		failed.push([id, "no changes"]);
		continue;
	}
	if (dryRun) {
		console.log(`would upload ${id}: ${changes} changes, ${saved.length} bytes`);
		continue;
	}
	const file = path.join(dir, `${id}.am`);
	await writeFile(file, saved);
	try {
		await run(
			"automerge-subduction-ingest",
			["--server", server, ...serviceName, "--doc-id", `automerge:${id}`, "--ephemeral-key", file],
			{ timeout: 120_000 },
		);
		uploaded++;
		console.log(`uploaded ${id}: ${changes} changes, ${saved.length} bytes`);
	} catch (e) {
		const lines = (e.stderr || e.message).split("\n").filter(l => l.trim() && !/BACKTRACE|^\s*(at |\d+:)/.test(l));
		failed.push([id, `upload: ${lines.slice(-3).join(" / ")}`]);
	}
}

console.log(`${dryRun ? "dry run: " : ""}${uploaded} uploaded, ${failed.length} failed, ${bytes} bytes of documents`);
for (const [id, why] of failed) console.log(`failed ${id}: ${why}`);
process.exit(failed.length ? 1 : 0);
