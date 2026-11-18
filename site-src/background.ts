// Live "Blue Hour" background for muxtra.dev, drawn by the vendored gradients.sh engine.
// It reacts to the cursor and to scroll speed, and holds one still frame for reduced motion.
import { mountGradient, normalizeParams } from "../third_party/gradients-sh/gradient-engine"

const blueHour = normalizeParams({
  background: "#010309",
  blur: 0.4,
  colors: ["#eef8ff", "#8fd0f5", "#3d6fd0", "#1b1846"],
  dither: { cell: 3, enabled: false, levels: 8 },
  grain: 0.16,
  // Stronger than the preset (0.2 and 0.1) so the cursor is easy to feel.
  interaction: { pointer: 0.6, scroll: 0.25 },
  kind: "radial-glow",
  loopSeconds: 10,
  scale: 1,
  seed: 31,
  speed: 0.9,
  warp: 0.35,
})

const canvas = document.getElementById("glow")
if (canvas instanceof HTMLCanvasElement) {
  mountGradient(canvas, blueHour, { maxDpr: 1.5 })
}
