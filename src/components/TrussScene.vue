<script setup lang="ts">
// Orbitable view of the truss structure behind the LED wall.
//
// The Front view is the one that matters: it is the audience's eye line, and
// if you can see any truss from there the structure is wrong. Everything is
// drawn to scale in metres, so what you see is what gets built.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { lengthColor, type TrussPlan } from '../lib/truss'

// Only the plan comes in: it carries the sanitised spec it was solved from, so
// the render can never disagree with the parts list beside it.
const props = defineProps<{ plan: TrussPlan }>()

type View = 'orbit' | 'front' | 'side' | 'top'

const host = ref<HTMLDivElement | null>(null)
const view = ref<View>('orbit')
const seeThrough = ref(false)

// three.js objects are big mutable graphs; reactivity over them buys nothing
// and costs a proxy on every frame.
const renderer = shallowRef<THREE.WebGLRenderer | null>(null)
const scene = shallowRef<THREE.Scene | null>(null)
const camera = shallowRef<THREE.PerspectiveCamera | null>(null)
const controls = shallowRef<OrbitControls | null>(null)
const structure = shallowRef<THREE.Group | null>(null)
const wallMaterial = shallowRef<THREE.MeshLambertMaterial | null>(null)

let frameHandle = 0
let observer: ResizeObserver | null = null
// Wall size the camera was last placed for. Editing a rule rebuilds the
// geometry, and yanking the camera back to the preset each time would make
// the tab unusable while you tune numbers - so it only re-frames when the
// wall itself changes size.
let framedFor = ''

/** Reads a theme token so the canvas matches light and dark mode. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/** A box with its edges picked out, which is what makes truss read as truss
 *  rather than as a featureless bar at this scale. */
function piece(
  width: number,
  height: number,
  depth: number,
  colour: string,
  position: THREE.Vector3
): THREE.Group {
  const group = new THREE.Group()
  const geometry = new THREE.BoxGeometry(width, height, depth)
  const material = new THREE.MeshLambertMaterial({ color: colour })
  group.add(new THREE.Mesh(geometry, material))
  group.add(
    new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 })
    )
  )
  group.position.copy(position)
  return group
}

function buildStructure(): THREE.Group {
  const { plan } = props
  const spec = plan.spec
  const group = new THREE.Group()
  const s = spec.section
  const half = s / 2

  // The wall, one box per panel. Panels face the audience, so they sit just in
  // front of z = 0 and every truss lives behind them. Drawn as instances of a
  // single box: a big wall is thousands of panels but still one draw call.
  //
  // The panels are shrunk a few millimetres so a seam of empty space is left
  // between them. With real thickness those seams have depth, which is what
  // makes the grid read without any lines drawn over the top.
  const seam = Math.min(0.008, spec.panelWidth / 8, spec.panelHeight / 8)
  const panelGeometry = new THREE.BoxGeometry(
    spec.panelWidth - seam,
    spec.panelHeight - seam,
    spec.panelDepth
  )
  const wallMat = new THREE.MeshLambertMaterial({
    color: 0x23262f,
    transparent: true,
    opacity: seeThrough.value ? 0.25 : 1,
  })
  wallMaterial.value = wallMat

  const panels = new THREE.InstancedMesh(
    panelGeometry,
    wallMat,
    spec.panelsWide * spec.panelsHigh
  )
  const placement = new THREE.Object3D()
  let instance = 0
  for (let col = 0; col < spec.panelsWide; col += 1) {
    for (let row = 0; row < spec.panelsHigh; row += 1) {
      placement.position.set(
        (col + 0.5) * spec.panelWidth,
        (row + 0.5) * spec.panelHeight,
        -spec.panelDepth / 2
      )
      placement.updateMatrix()
      panels.setMatrixAt(instance, placement.matrix)
      instance += 1
    }
  }
  panels.instanceMatrix.needsUpdate = true
  group.add(panels)

  // A frame around the whole wall, so the outline stays crisp from the front
  // even where a dark panel meets a dark background.
  const outline = new THREE.BoxGeometry(plan.wallWidth, plan.wallHeight, spec.panelDepth)
  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(outline),
    new THREE.LineBasicMaterial({ color: 0x5a6172, transparent: true, opacity: 0.9 })
  )
  // EdgesGeometry copies what it needs, so the box it was derived from is
  // finished with the moment it is built.
  outline.dispose()
  frame.position.set(plan.wallWidth / 2, plan.wallHeight / 2, -spec.panelDepth / 2)
  group.add(frame)

  const ubColour = lengthColor(s, spec.stock, 'ub')

  for (const x of plan.positions) {
    // Universal box at the elbow, on the ground against the wall.
    group.add(piece(s, s, s, ubColour, new THREE.Vector3(x, half, half)))

    // Vertical run, stacked straight onto the box.
    let y = s
    for (const segment of plan.leg.segments) {
      group.add(
        piece(s, segment, s, lengthColor(segment, spec.stock), new THREE.Vector3(x, y + segment / 2, half))
      )
      y += segment
    }

    // Foot, running back away from the audience out of sight.
    if (plan.leg.foot > 0) {
      group.add(
        piece(
          s,
          s,
          plan.leg.foot,
          lengthColor(plan.leg.foot, spec.stock),
          new THREE.Vector3(x, half, s + plan.leg.foot / 2)
        )
      )
    }
  }

  if (plan.connector) {
    const colour = lengthColor(plan.connector.length, spec.stock)
    for (const height of plan.connector.heights) {
      for (let i = 1; i < plan.positions.length; i += 1) {
        const midpoint = (plan.positions[i - 1] + plan.positions[i]) / 2
        group.add(
          piece(plan.connector.length, s, s, colour, new THREE.Vector3(midpoint, height, half))
        )
      }
    }
  }

  return group
}

/** Ground, grid, and a marker showing which side the audience is on. */
function buildGround(): THREE.Group {
  const group = new THREE.Group()
  const span = Math.max(props.plan.wallWidth, 6) * 2

  const grid = new THREE.GridHelper(span, Math.round(span), 0x6b7280, 0x6b7280)
  grid.position.set(props.plan.wallWidth / 2, 0, 0)
  const gridMaterial = grid.material as THREE.Material
  gridMaterial.transparent = true
  gridMaterial.opacity = 0.18
  group.add(grid)

  // A cone on the audience side, pointing at the wall.
  const marker = new THREE.Mesh(
    new THREE.ConeGeometry(0.28, 0.7, 4),
    new THREE.MeshLambertMaterial({ color: 0x2f6fed })
  )
  marker.rotation.x = Math.PI / 2
  marker.position.set(props.plan.wallWidth / 2, 0.28, -Math.max(2, props.plan.wallWidth * 0.35))
  group.add(marker)

  return group
}

/** Camera placement for each preset. Front is deliberately dead-on. */
function frameView(next: View) {
  const cam = camera.value
  const ctl = controls.value
  if (!cam || !ctl) return

  const { wallWidth: w, wallHeight: h } = props.plan
  const reach = Math.max(w, h) + 4

  const target = new THREE.Vector3(w / 2, h * 0.45, 0.4)
  let position: THREE.Vector3

  switch (next) {
    case 'front':
      // Where the audience stands. Nothing should be visible past the wall.
      position = new THREE.Vector3(w / 2, h / 2, -reach * 1.3)
      target.set(w / 2, h / 2, 0)
      break
    case 'side':
      position = new THREE.Vector3(w + reach * 0.7, h * 0.5, w * 0.15 + 1)
      break
    case 'top':
      position = new THREE.Vector3(w / 2, reach * 1.4, 1.5)
      break
    default:
      position = new THREE.Vector3(w + reach * 0.35, h * 0.9 + 1, reach * 0.85)
  }

  cam.position.copy(position)
  ctl.target.copy(target)
  ctl.update()
}

function rebuild() {
  const sc = scene.value
  if (!sc) return

  if (structure.value) {
    sc.remove(structure.value)
    disposeTree(structure.value)
  }
  const group = new THREE.Group()
  group.add(buildGround())
  group.add(buildStructure())
  sc.add(group)
  structure.value = group

  sc.background = new THREE.Color(token('--bg', '#f5f5f7'))

  const size = `${props.plan.wallWidth}x${props.plan.wallHeight}`
  if (size !== framedFor) {
    framedFor = size
    frameView(view.value)
  }
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((object) => {
    const withGeometry = object as THREE.Mesh
    withGeometry.geometry?.dispose()
    const material = withGeometry.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose()
  })
}

function resize() {
  const el = host.value
  const cam = camera.value
  const r = renderer.value
  if (!el || !cam || !r) return
  const width = el.clientWidth
  const height = el.clientHeight
  if (width === 0 || height === 0) return
  cam.aspect = width / height
  cam.updateProjectionMatrix()
  r.setSize(width, height, false)
}

onMounted(() => {
  const el = host.value
  if (!el) return

  const sc = new THREE.Scene()
  sc.background = new THREE.Color(token('--bg', '#f5f5f7'))

  const cam = new THREE.PerspectiveCamera(50, 1, 0.1, 500)

  const r = new THREE.WebGLRenderer({ antialias: true })
  r.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  el.appendChild(r.domElement)

  sc.add(new THREE.AmbientLight(0xffffff, 1.5))
  const key = new THREE.DirectionalLight(0xffffff, 1.8)
  key.position.set(4, 8, 6)
  sc.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.6)
  fill.position.set(-6, 4, -5)
  sc.add(fill)

  const ctl = new OrbitControls(cam, r.domElement)
  ctl.enableDamping = true
  ctl.dampingFactor = 0.08
  // Stop the camera dropping below the floor, which is disorienting.
  ctl.maxPolarAngle = Math.PI / 2 - 0.02

  scene.value = sc
  camera.value = cam
  renderer.value = r
  controls.value = ctl

  rebuild()
  resize()

  observer = new ResizeObserver(resize)
  observer.observe(el)

  const tick = () => {
    frameHandle = requestAnimationFrame(tick)
    ctl.update()
    r.render(sc, cam)
  }
  tick()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(frameHandle)
  observer?.disconnect()
  controls.value?.dispose()
  if (structure.value) disposeTree(structure.value)
  const r = renderer.value
  if (r) {
    r.domElement.remove()
    r.dispose()
  }
})

watch(() => props.plan, rebuild)
watch(view, (next) => frameView(next))
watch(seeThrough, (next) => {
  const material = wallMaterial.value
  if (!material) return
  material.opacity = next ? 0.25 : 1
  material.needsUpdate = true
})

const VIEWS: { id: View; label: string; title: string }[] = [
  { id: 'orbit', label: 'Orbit', title: 'Three-quarter view from behind' },
  { id: 'front', label: 'Front', title: 'What the audience sees — nothing should stick out' },
  { id: 'side', label: 'Side', title: 'Shows how far the feet reach back' },
  { id: 'top', label: 'Top', title: 'Leg spacing across the wall' },
]
</script>

<template>
  <div class="scene">
    <div class="scene-bar">
      <div class="views">
        <button
          v-for="v in VIEWS"
          :key="v.id"
          class="btn small"
          :class="{ active: view === v.id }"
          :title="v.title"
          @click="view = v.id"
        >
          {{ v.label }}
        </button>
      </div>
      <label class="ghost-toggle">
        <input v-model="seeThrough" type="checkbox" />
        See through the wall
      </label>
    </div>

    <div ref="host" class="canvas-host" />

    <p v-if="view === 'front'" class="front-note" :class="{ bad: !plan.hidden }">
      {{
        plan.hidden
          ? 'Head on, the structure sits entirely behind the wall.'
          : 'Part of the structure is visible from here. Check the warnings above.'
      }}
    </p>
    <p v-else class="hint">Drag to orbit, scroll to zoom, right-drag to pan.</p>
  </div>
</template>

<style scoped>
.scene {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.scene-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.views {
  display: flex;
  gap: 6px;
}

.btn.small {
  padding: 5px 11px;
  font-size: 13px;
}

.btn.active {
  background: var(--accent-bg);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.ghost-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-muted);
}

.canvas-host {
  width: 100%;
  height: 460px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  /* The canvas is sized from this element, so it must not collapse. */
  min-height: 260px;
  touch-action: none;
}

.canvas-host :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.front-note {
  margin: 0;
  font-size: 13px;
  color: var(--success);
}

.front-note.bad {
  color: var(--danger);
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

@media (max-width: 860px) {
  .canvas-host {
    height: 320px;
  }
}
</style>
