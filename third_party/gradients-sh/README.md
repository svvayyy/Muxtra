# gradients.sh gradient engine (vendored)

The animated background on muxtra.dev uses the free, MIT-licensed gradient
engine from [gradients.sh](https://gradients.sh/license), with the
"Blue Hour" preset of the radial glow component.

- Source: the `gradient-engine` shadcn registry item at `https://gradients.sh/r/gradient-engine.json`, fetched November 2026.
- Changes: unused shader kinds were removed, and `kinds.ts` registers only `mesh` and `radial-glow`. Nothing else was modified.
- License: [MIT](LICENSE).

The site loads a bundle built from this source by `scripts/build-site.sh`.
