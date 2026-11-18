#!/bin/sh
# Bundles site-src/ into site/ so GitHub Pages can serve it without a build step.
set -eu
cd "$(dirname "$0")/.."
npx --yes esbuild@0.28.2 site-src/background.ts \
  --bundle --minify --format=esm --target=es2022 \
  --legal-comments=none \
  --banner:js="/* muxtra.dev background. Gradient engine (c) gradients.sh, MIT. Simplex noise (c) Ian McEwan, Stefan Gustavson, Ashima Arts, MIT. Source: third_party/gradients-sh */" \
  --outfile=site/background.js

# Stamp each asset link in index.html with a short content hash, so a new
# deploy is never stuck behind an old cached copy at the CDN.
for asset in styles.css background.js sky.js favicon.svg apple-touch-icon.png; do
  hash=$(shasum -a 256 "site/$asset" | cut -c1-10)
  sed -i.bak -E "s#${asset}\?v=[0-9a-f]+#${asset}?v=${hash}#g" site/index.html
done
rm -f site/index.html.bak
