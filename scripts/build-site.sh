#!/bin/sh
# Bundles site-src/ into site/ so GitHub Pages can serve it without a build step.
set -eu
cd "$(dirname "$0")/.."
npx --yes esbuild@0.28.2 site-src/background.ts \
  --bundle --minify --format=esm --target=es2022 \
  --legal-comments=none \
  --banner:js="/* muxtra.dev background. Gradient engine (c) gradients.sh, MIT. Simplex noise (c) Ian McEwan, Stefan Gustavson, Ashima Arts, MIT. Source: third_party/gradients-sh */" \
  --outfile=site/background.js
