#!/bin/sh
# Copy the tippet galaxy (ermine's experiments/tippet/galaxy.ts) and every local file it imports
# from an ermine checkout into this folder, at the same paths, beside the gateway's (vendor.sh), and
# add the workspace names it imports to deno.json. Files the gateway already has are copied over
# only when they are the same; one that differs stops it, so the gateway never changes by this.
#
#   sh littlesync/vendor-tippet.sh [path to ermine]    (default ../ermine, beside this repo)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
ermine=$(cd "${1:-$here/../../ermine}" && pwd)
main=experiments/tippet/typescript/galaxy.ts

info=$(cd "$ermine" && deno info --json "$main")
files=$(echo "$info" | deno eval --quiet '
	const [root, map] = Deno.args
	const info = JSON.parse(await new Response(Deno.stdin.readable).text())
	const local = (s) => decodeURIComponent(new URL(s).pathname).slice(root.length + 1)
	const json = JSON.parse(Deno.readTextFileSync(map))
	for (const m of info.modules) {
		if (!m.specifier.startsWith("file://")) continue
		console.log(local(m.specifier))
		for (const d of m.dependencies ?? []) {
			const to = d.code?.specifier ?? d.type?.specifier
			if (d.specifier.startsWith("@") && to?.startsWith("file://")) {
				json.imports[d.specifier] = "./" + local(to)
			}
		}
	}
	json.imports = Object.fromEntries(Object.entries(json.imports).sort())
	Deno.writeTextFileSync(map, JSON.stringify(json, null, "\t") + "\n")
' "$ermine" "$here/deno.json")

rm -rf "${here:?}/experiments"
for f in $files; do
	if [ -f "$here/$f" ] && [ "${f#experiments/}" = "$f" ] && ! cmp -s "$ermine/$f" "$here/$f"; then
		echo "vendor-tippet.sh: $f differs from the gateway's copy; vendor both again (vendor.sh)" >&2
		exit 1
	fi
	mkdir -p "$here/$(dirname "$f")"
	cp "$ermine/$f" "$here/$f"
done

{
	echo "tippet: ermine $(git -C "$ermine" rev-parse HEAD)"
	changed=$(cd "$ermine" && git status --porcelain --untracked-files=all -- $files | cut -c4- | tr '\n' ' ')
	if [ -n "$changed" ]; then
		echo "tippet: with uncommitted or new files: $changed"
	fi
} > "$here/VENDORED-tippet"
echo "vendored $(echo "$files" | wc -l | tr -d ' ') files from $ermine into $here"
