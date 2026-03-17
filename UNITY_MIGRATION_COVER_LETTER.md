# Unity Migration Cover Letter: Throwing Cubes Mechanic & Visual

**Audience:** AI assistant or developer working on a Unity project  
**Source:** `test-your-luck` — a web dice simulator (Three.js + Rapier)  
**Scope:** Migrate only the **throwing cubes mechanic and visuals**. No deterministic physics, no result tracking, no scoring.

---

## What to Replicate

1. **Physics:** Cubes thrown inside a box, bounce off walls and floor, settle naturally
2. **Visuals:** Glass-like cubes with pips (dice faces), wooden box, trails, collision particles
3. **Throw:** Single action that spawns cubes in air and applies velocity + spin toward the floor

---

## Physics Specification

### World
- **Gravity:** `(0, -9.81, 0)` (Y-down)
- **Fixed timestep:** `1/60` (60 Hz)
- **CCD (Continuous Collision Detection):** Enable on dice to prevent tunneling through walls at high speed

### Box (6 walls: floor, ceiling, 4 sides)
- **Inner dimensions:** 14 × 16 × 14 (X × Y × Z)
- **Wall thickness:** 0.05
- **Wall colliders:** Static, friction 0.5, restitution 0.2
- **Half-extents for each wall (cuboid):**
  - Floor: center `(0, -8.025, 0)`, half `(7.05, 0.025, 7.05)`
  - Ceiling: center `(0, 8.025, 0)`, half `(7.05, 0.025, 7.05)`
  - Left: center `(-7.025, 0, 0)`, half `(0.025, 8.05, 7.05)`
  - Right: center `(7.025, 0, 0)`, half `(0.025, 8.05, 7.05)`
  - Back: center `(0, 0, -7.025)`, half `(7.05, 8.05, 0.025)`
  - Front: center `(0, 0, 7.025)`, half `(7.05, 8.05, 0.025)`

### Dice (cubes)
- **Size:** 1×1×1 unit (half-extent 0.5)
- **Mass:** 3 (default)
- **Friction:** 0.5
- **Restitution:** 0.15
- **Linear damping:** 0.1
- **Angular damping:** 0.2
- **Collider:** Box (cuboid), half-extents `(0.5, 0.5, 0.5)`

---

## Throw Logic (Simplified — No Determinism)

**Spawn region** (random center inside box, away from walls):
- X: `-4` to `4` (half box minus margin)
- Y: `5` (fixed — upper half of box)
- Z: `-4` to `4`

**Spawn layout (grid):** For N dice, arrange in a square grid with spacing 1.5. Example for 6 dice: 2×3 grid, each die offset from spawn center.

**Target:** Floor center `(0, -7.5, 0)` — dice fall toward the floor.

**Per-die throw:**
1. Set position: spawn center + grid offset
2. Direction: from position toward target, normalized
3. Add random direction jitter: `±0.35` on each axis, re-normalize
4. Speed: `(2.5 + random * 3) * power` — power default 1
5. Linear velocity: `direction * speed`
6. Angular velocity: `(random - 0.5) * 2` on each axis (spin)

Use `Random.Range` or equivalent — no seeded RNG required.

---

## Visual Specification

### Dice (cubes)
- **Geometry:** 1×1×1 cube
- **Material (glass-like):**
  - Color: red `#b91c1c` (0xb91c1c)
  - Transparency: 0.92
  - Transmission/refraction: high (glass look)
  - IOR: 1.5
  - Roughness: 0.12 (glossy)
  - Clearcoat: 0.15
  - Metalness: 0
  - Environment map intensity: 1.2
- **Edges:** Subtle dark red line overlay (color `#4a0a0a`, opacity 0.5)
- **Pips:** White circles on each face. Standard dice layout:
  - Face +Y: 1 pip (center)
  - Face -Y: 6 pips (2×3 grid)
  - Face +X: 3 pips (diagonal)
  - Face -X: 4 pips (2×2)
  - Face +Z: 2 pips (diagonal)
  - Face -Z: 5 pips (4 corners + center)
- **Pip size:** Radius 0.08, positioned at ±0.25 from face center
- **Pip color:** White

### Box (wooden tray)
- **Floor:** Dark `#0f0f0f`, matte (roughness 1)
- **Walls:** Dark `#121212`, matte, rounded corners (radius 0.08)
- **Wall height (visual):** 4 units (physics box is taller; walls are low so dice are visible)
- **Inner floor:** Dark `#0a0a0a` with subtle grid texture (8×8 lines, color `#1a1a1a`)
- **Border:** 0.8 wide strip around inner floor, color `#0f0f0f`
- **Corner accents:** Small vertical strips, 0.12 × 0.4 × 0.12, rounded

### Velocity Trails
- **When:** Only when cube velocity magnitude > 0.3
- **Shape:** Ribbon along recent positions (last ~18 points)
- **Width:** 0.2
- **Appearance:** White gradient (transparent at tail, opaque at head), opacity 0.35
- **Update:** Each frame, add current position if moving; drop oldest when full

### Collision Particles
- **Trigger:** On collision (dice–dice or dice–wall)
- **Spawn:** 6 particles per collision
- **Position:** Collision point
- **Velocity:** Random hemisphere (upward bias), speed 0.5–1.5
- **Lifetime:** 0.21–0.39 s
- **Size:** 0.25
- **Color:** White, opacity 0.25, fade out over lifetime
- **Motion:** Move with velocity, damp velocity by 0.92 each frame

---

## Lighting & Scene
- **Ambient:** 0.35 intensity
- **Directional light:** 0.8 intensity, position `(5, 8, 5)` (above and to the side)
- **Shadows:** Enable on directional light, soft shadows
- **Background:** Black
- **Environment:** Reflection probe or similar for dice reflections
- **Fog (optional):** Dark gray, start 60, end 140

---

## Unity Implementation Hints

| Component | Unity Equivalent |
|-----------|------------------|
| Rigidbody | `Rigidbody` + `BoxCollider` |
| Throw | `AddForce` (impulse) + `AddTorque` |
| CCD | `Rigidbody.collisionDetectionMode = CollisionDetectionMode.Continuous` |
| Glass material | URP/HDRP Lit shader: Transparency + Refraction, or custom |
| Trails | `TrailRenderer` component |
| Particles | `ParticleSystem` with burst on collision |
| Box colliders | 6 static `BoxCollider` on empty GameObjects or one mesh collider |

### Minimal Flow
1. On "Throw" input: reset dice positions to spawn region (grid layout)
2. For each die: `AddForce(direction * speed)` and `AddTorque(randomAngular)`
3. Sync visual mesh transform from Rigidbody each frame
4. Trail: enable when `rigidbody.velocity.magnitude > 0.3`
5. OnCollisionEnter: spawn particle burst at contact point

---

## Source Files (Reference)

- Physics: `src/physics.ts` — walls, dice creation, throw application
- Visuals: `src/visuals.ts` — box, dice mesh, pips, trails
- Particles: `src/particles.ts` — collision particles
- Scene: `src/scene.ts` — lighting, camera

---

*This document describes the subset of the original project needed for a standalone "throw cubes in a box" experience in Unity. No game logic, scoring, or deterministic replay is required.*
