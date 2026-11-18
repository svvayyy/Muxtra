// Starfield and a Keplerian orbit for the hero.
// The planet follows Kepler's equation, so it really does slow down near aphelion.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

// ---------- Orbit ----------

const A = 300 // semi-major axis
const E = 0.6 // eccentricity
const B = A * Math.sqrt(1 - E * E)
const TILT = 0.32 // squash the ellipse so it reads as an inclined orbit
const PERIOD = 16000 // ms per orbit

// Position relative to the sun (at the focus) for eccentric anomaly ea.
// Perihelion sits left of the sun, aphelion far to the right.
function orbitPoint(ea) {
  return {
    x: -A * (Math.cos(ea) - E),
    y: B * Math.sin(ea) * TILT,
    depth: Math.sin(ea),
  }
}

// Solve Kepler's equation M = E - e sin E with Newton's method.
function eccentricAnomaly(meanAnomaly) {
  let ea = meanAnomaly
  let steps = 6
  while (steps-- > 0) {
    ea -= (ea - E * Math.sin(ea) - meanAnomaly) / (1 - E * Math.cos(ea))
  }
  return ea
}

const path = document.getElementById("orbit-path")
const planet = document.getElementById("planet")
const peri = document.getElementById("apsis-peri")
const aph = document.getElementById("apsis-aph")

if (path && planet) {
  const points = Array.from({ length: 181 }, (_, i) => {
    const p = orbitPoint((i / 180) * Math.PI * 2)
    return `${p.x.toFixed(2)} ${p.y.toFixed(2)}`
  })
  path.setAttribute("d", `M${points.join("L")}Z`)

  peri.setAttribute("transform", `translate(${-A * (1 - E)} 0)`)
  aph.setAttribute("transform", `translate(${A * (1 + E)} 0)`)

  const place = (ea) => {
    const p = orbitPoint(ea)
    // Slightly smaller and dimmer on the far side of the orbit.
    const scale = 1 - 0.18 * Math.max(0, -p.depth)
    planet.setAttribute("transform", `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${scale.toFixed(3)})`)
    planet.style.opacity = (1 - 0.3 * Math.max(0, -p.depth)).toFixed(3)
  }

  if (reduceMotion) {
    place(Math.PI)
  } else {
    // Start just after perihelion so the slow-down at aphelion shows quickly.
    const start = performance.now() - PERIOD * 0.12
    const tick = (now) => {
      const meanAnomaly = (((now - start) % PERIOD) / PERIOD) * Math.PI * 2
      place(eccentricAnomaly(meanAnomaly))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
}

// ---------- Stars ----------

const canvas = document.getElementById("sky")
const ctx = canvas ? canvas.getContext("2d") : null
let stars = []
let meteor = null
let nextMeteor = 0
let width = 0
let height = 0

function seededRandom(seed) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

function makeStars() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = window.innerWidth
  height = window.innerHeight
  canvas.width = Math.round(width * dpr)
  canvas.height = Math.round(height * dpr)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const rand = seededRandom(20261117)
  const count = Math.min(520, Math.round((width * height) / 2600))
  stars = Array.from({ length: count }, () => {
    const warm = rand() < 0.12
    const cool = !warm && rand() < 0.25
    return {
      x: rand() * width,
      y: rand() * height,
      r: rand() < 0.92 ? 0.35 + rand() * 0.7 : 1.1 + rand() * 0.6,
      base: 0.25 + rand() * 0.6,
      speed: 0.4 + rand() * 1.6,
      phase: rand() * Math.PI * 2,
      color: warm ? "255, 214, 170" : cool ? "180, 200, 255" : "235, 240, 255",
    }
  })
}

function drawStars(time) {
  ctx.clearRect(0, 0, width, height)
  const t = time / 1000
  for (const s of stars) {
    const twinkle = reduceMotion ? 1 : 0.72 + 0.28 * Math.sin(t * s.speed + s.phase)
    ctx.fillStyle = `rgba(${s.color}, ${(s.base * twinkle).toFixed(3)})`
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawMeteor(time) {
  if (!meteor && time > nextMeteor) {
    const fromLeft = Math.random() < 0.5
    meteor = {
      x: (fromLeft ? 0.1 : 0.55) * width + Math.random() * width * 0.35,
      y: Math.random() * height * 0.35,
      dx: fromLeft ? 1 : -1,
      born: time,
      life: 900,
    }
  }
  if (!meteor) return
  const age = (time - meteor.born) / meteor.life
  if (age >= 1) {
    meteor = null
    nextMeteor = time + 9000 + Math.random() * 12000
    return
  }
  const travel = 260 * age
  const headX = meteor.x + meteor.dx * travel
  const headY = meteor.y + travel * 0.45
  const tailX = headX - meteor.dx * 90
  const tailY = headY - 40
  const fade = Math.sin(age * Math.PI)
  const grad = ctx.createLinearGradient(tailX, tailY, headX, headY)
  grad.addColorStop(0, "rgba(255, 220, 180, 0)")
  grad.addColorStop(1, `rgba(255, 236, 210, ${(0.8 * fade).toFixed(3)})`)
  ctx.strokeStyle = grad
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(tailX, tailY)
  ctx.lineTo(headX, headY)
  ctx.stroke()
}

if (ctx) {
  makeStars()
  let resizeTimer = 0
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      makeStars()
      if (reduceMotion) drawStars(0)
    }, 120)
  })

  if (reduceMotion) {
    drawStars(0)
  } else {
    nextMeteor = performance.now() + 4000
    const frame = (time) => {
      drawStars(time)
      drawMeteor(time)
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }
}
