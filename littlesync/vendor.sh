#!/bin/sh
# Copy the littlesync gateway (ermine's playground/together/stacks/littlesync/gateway/main.ts) and
# every local file it imports from an ermine checkout into this folder, at the same paths, so the
# image builds it with nothing from outside this repo. deno.json maps the ermine workspace names
# (@ermine/...) it imports to the copies; deno.lock pins its npm packages, fetched at build time.
#
#   sh littlesync/vendor.sh [path to ermine]    (default ../ermine, beside this repo)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
ermine=$(cd "${1:-$here/../../ermine}" && pwd)
main=playground/together/stacks/littlesync/gateway/main.ts

# The local modules main.ts reaches, relative to the ermine checkout, and the import map for the
# workspace names among their imports.
info=$(cd "$ermine" && deno info --json "$main")
files=$(echo "$info" | deno eval --quiet '
	const root = Deno.args[0]
	const info = JSON.parse(await new Response(Deno.stdin.readable).text())
	const local = (s) => decodeURIComponent(new URL(s).pathname).slice(root.length + 1)
	const imports = {}
	for (const m of info.modules) {
		if (!m.specifier.startsWith("file://")) continue
		console.log(local(m.specifier))
		for (const d of m.dependencies ?? []) {
			const to = d.code?.specifier ?? d.type?.specifier
			if (d.specifier.startsWith("@") && to?.startsWith("file://")) {
				imports[d.specifier] = "./" + local(to)
			}
		}
	}
	const sorted = Object.fromEntries(Object.entries(imports).sort())
	Deno.writeTextFileSync(Deno.args[1], JSON.stringify({ imports: sorted }, null, "\t") + "\n")
' "$ermine" "$here/deno.json")

for dir in core ermine extensions playground; do
	rm -rf "${here:?}/$dir"
done
for f in $files; do
	mkdir -p "$here/$(dirname "$f")"
	cp "$ermine/$f" "$here/$f"
done

# Where it came from: the commit, and whether the files differed from it.
{
	echo "ermine $(git -C "$ermine" rev-parse HEAD)"
	changed=$(cd "$ermine" && git status --porcelain -- $files | cut -c4- | tr '\n' ' ')
	if [ -n "$changed" ]; then
		echo "with uncommitted changes to: $changed"
	fi
} > "$here/VENDORED"

# Pin the npm packages it uses.
rm -f "$here/deno.lock"
(cd "$here" && deno install --quiet --entrypoint "$main")
echo "vendored $(echo "$files" | wc -l | tr -d ' ') files from $ermine into $here"
