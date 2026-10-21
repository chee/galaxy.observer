#!/bin/sh
# Compile the vendored gateway into one executable (Deno and the npm packages inside), for the
# image. Needs Deno and the network (npm, and Deno's runtime for the executable).
#
#   sh littlesync/build.sh OUT
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
main=playground/together/stacks/littlesync/gateway/main.ts
cd "$here"

# Fetch what deno.lock pins, then leave out the parts of @automerge/subduction the gateway never
# loads (its debug, CommonJS and browser builds: ~200 MB of the package's ~250 MB).
deno install --frozen --quiet --entrypoint "$main"
pkg=$(deno info --frozen --json "$main" | deno eval --quiet '
	const info = JSON.parse(await new Response(Deno.stdin.readable).text())
	const pkg = Object.values(info.npmPackages).find((p) => p.name === "@automerge/subduction")
	console.log(pkg.localPath)
')
set --
for unused in dist/cjs dist/iife dist/subduction-debug.wasm dist/wasm_bindgen/web-debug \
	dist/esm/debug-wasm-base64.js dist/esm/wasm-base64.js; do
	set -- "$@" --exclude "$pkg/$unused"
done

deno compile --frozen --quiet --allow-net --allow-env "$@" --output "$out" "$main"
