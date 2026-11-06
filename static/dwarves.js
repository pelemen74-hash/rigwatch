// RigWatch dwarf crew in 3D: one dwarf per busy CPU thread, a wood
// pile that grows with today's energy use. Falls back to the SVG crew in
// app.js when WebGL is not available.
import * as THREE from "/vendor/three.module.min.js";

const TUNICS = [0xb5432f, 0x3f7d4e, 0x3c6aa8, 0x8a5aa8, 0xb7832f, 0x2f8a8a];
const BEARDS = [0xd9944f, 0xe8e2d6, 0x8a5a33, 0xc9a14a];
const SKIN = new THREE.Color(0xf1c27d);
const STRAIN = new THREE.Color(0xf07a5a);
const KWH_PER_LOG = 0.2;
const MAX_LOGS = 36;
const HIT_ANGLE = 0.02;    // blade biting into the log
const RAISED_ANGLE = -2.3; // axe over the shoulder

const canvas = document.getElementById("dwarfScene");
const stage = document.getElementById("dwarfStage");
const fallback = document.getElementById("dwarfCrew");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- geometry helpers ----------

// Merge simple parts into one vertex-coloured geometry: one draw call per dwarf
// instead of twenty.
function merge(parts) {
  const positions = [], normals = [], colors = [];
  for (const {geometry, color, matrix, capColor} of parts) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    // Caps (flat ends) of cylinders get their own colour: end grain, log tops
    const isCap = Array.from({length: g.attributes.normal.count}, (_, i) => Math.abs(g.attributes.normal.getY(i)) > 0.9);
    if (matrix) g.applyMatrix4(matrix);
    const pos = g.attributes.position, nor = g.attributes.normal;
    const base = new THREE.Color(color), cap = capColor != null ? new THREE.Color(capColor) : null;
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      const c = cap && isCap[i] ? cap : base;
      colors.push(c.r, c.g, c.b);
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return merged;
}

const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const ball = (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);
const cyl = (rt, rb, h, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg);

// A tapered limb from a to b (both [x, y, z])
function limb(a, b, r1, r2, color, radial = 12) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const direction = to.clone().sub(from);
  const matrix = new THREE.Matrix4().compose(
    from.clone().add(to).multiplyScalar(.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize()),
    new THREE.Vector3(1, 1, 1));
  return {geometry: new THREE.CylinderGeometry(r2, r1, direction.length(), radial), color, matrix};
}

// Curved, tapering horn as a chain of limb segments; side = -1 left, 1 right
function horn(side) {
  const parts = [], steps = 7;
  const point = t => [side * (.22 + .24 * t), 1.28 + .22 * t - .02 * t * t + .12 * t * t * t, .02 + .06 * t];
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    parts.push(limb(point(t0), point(t1), .062 * (1 - t0) + .01, .062 * (1 - t1) + .01, 0xe9dcbc, 10));
  }
  return parts;
}

// Bearded axe blade drawn in the (handle, down) plane and extruded
function axeHead() {
  const shape = new THREE.Shape();
  shape.moveTo(-.05, .05);
  shape.lineTo(.05, .05);
  shape.lineTo(.06, -.03);
  shape.quadraticCurveTo(.15, -.1, .15, -.27);
  shape.quadraticCurveTo(.03, -.23, -.1, -.29);
  shape.quadraticCurveTo(-.03, -.15, -.05, -.03);
  shape.lineTo(-.05, .05);
  const geometry = new THREE.ExtrudeGeometry(shape, {depth: .022, bevelEnabled: true, bevelThickness: .008, bevelSize: .008, bevelSegments: 2, curveSegments: 10});
  // shape x runs along the handle (+z), extrusion becomes the blade thickness (x)
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(.011, 0, 1.0);
  return geometry;
}

const LEATHER = 0x4a3324, DARK_LEATHER = 0x2a1b12, TROUSERS = 0x5a4632, IRON = 0x9aa3ab, DARK_IRON = 0x6d757c, GOLD = 0xd9ab3c;

// Legs, boots and the chopping block: never move
const lowerGeometry = merge([
  {geometry: ball(.13), color: DARK_LEATHER, matrix: M(-.13, .075, .05, 0, 0, 0, 1, .62, 1.45)},
  {geometry: ball(.13), color: DARK_LEATHER, matrix: M(.13, .075, .05, 0, 0, 0, 1, .62, 1.45)},
  {geometry: cyl(.115, .12, .09), color: LEATHER, matrix: M(-.13, .17, 0)},
  {geometry: cyl(.115, .12, .09), color: LEATHER, matrix: M(.13, .17, 0)},
  {geometry: cyl(.1, .11, .24), color: TROUSERS, matrix: M(-.13, .32, 0)},
  {geometry: cyl(.1, .11, .24), color: TROUSERS, matrix: M(.13, .32, 0)},
]);

// Chopping block with the log being split
const blockGeometry = merge([
  {geometry: cyl(.28, .32, .36, 18), color: 0x6b4226, capColor: 0xa8743f, matrix: M(0, .18, .95)},
  {geometry: cyl(.12, .12, .26, 14), color: 0x9a6a3a, capColor: 0xe0b07a, matrix: M(0, .49, .95)},
]);

// Upper body pivots at the hip (y = HIP) so the dwarf can lean into a swing
const HIP = .4;
const upperCache = new Map();
function upperGeometry(tunic, beard) {
  const key = `${tunic}-${beard}`;
  if (!upperCache.has(key)) {
    const h = y => y - HIP;
    // Tunic as a lathe: flared skirt, round belly, narrower chest
    const profile = [[0, .36], [.37, .36], [.39, .44], [.355, .56], [.36, .7], [.34, .83], [.29, .93], [.16, 1.0], [0, 1.01]]
      .map(([r, y]) => new THREE.Vector2(r, h(y)));
    const braid = side => [0, 1, 2, 3].map(k => ({geometry: ball(.048 - k * .004, 12, 10), color: beard, matrix: M(side * .1, h(.74 - k * .075), .31 - k * .012)}));
    upperCache.set(key, {
      cloth: merge([
        {geometry: new THREE.LatheGeometry(profile, 24), color: tunic},
        {geometry: cyl(.392, .392, .075, 24), color: DARK_LEATHER, matrix: M(0, h(.55), 0)},
        {geometry: box(.13, .13, .08), color: LEATHER, matrix: M(.27, h(.47), .27, 0, .75, 0)},
        // eyes, pupils, brows
        {geometry: ball(.042, 12, 10), color: 0xf4f1ea, matrix: M(-.085, h(1.125), .225)},
        {geometry: ball(.042, 12, 10), color: 0xf4f1ea, matrix: M(.085, h(1.125), .225)},
        {geometry: ball(.022, 10, 8), color: 0x1f160f, matrix: M(-.085, h(1.125), .262)},
        {geometry: ball(.022, 10, 8), color: 0x1f160f, matrix: M(.085, h(1.125), .262)},
        {geometry: box(.12, .04, .05), color: beard, matrix: M(-.09, h(1.175), .235, 0, 0, .22)},
        {geometry: box(.12, .04, .05), color: beard, matrix: M(.09, h(1.175), .235, 0, 0, -.22)},
        // big beard: jaw, long flowing part, moustache, two braids
        {geometry: ball(.24), color: beard, matrix: M(0, h(.94), .08, 0, 0, 0, 1.0, .68, .8)},
        {geometry: new THREE.ConeGeometry(.25, .62, 20), color: beard, matrix: M(0, h(.7), .17, Math.PI - .2, 0, 0, .92, 1, .65)},
        {geometry: new THREE.CapsuleGeometry(.04, .13, 6, 10), color: beard, matrix: M(-.075, h(1.025), .275, 0, 0, 1.2)},
        {geometry: new THREE.CapsuleGeometry(.04, .13, 6, 10), color: beard, matrix: M(.075, h(1.025), .275, 0, 0, -1.2)},
        ...braid(-1), ...braid(1),
        ...horn(-1).map(part => ({...part, matrix: new THREE.Matrix4().makeTranslation(0, -HIP, 0).multiply(part.matrix)})),
        ...horn(1).map(part => ({...part, matrix: new THREE.Matrix4().makeTranslation(0, -HIP, 0).multiply(part.matrix)})),
      ]),
      metal: merge([
        {geometry: new THREE.SphereGeometry(.272, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), color: IRON, matrix: M(0, h(1.2), 0)},
        {geometry: cyl(.28, .28, .065, 28), color: DARK_IRON, matrix: M(0, h(1.2), 0)},
        ...Array.from({length: 10}, (_, k) => ({geometry: ball(.018, 8, 6), color: GOLD, matrix: M(Math.sin(k / 10 * Math.PI * 2) * .284, h(1.2), Math.cos(k / 10 * Math.PI * 2) * .284)})),
        {geometry: box(.04, .13, .03), color: DARK_IRON, matrix: M(0, h(1.16), .275)},
        {geometry: ball(.15), color: IRON, matrix: M(-.31, h(.92), 0, 0, 0, .3, 1, .72, 1)},
        {geometry: ball(.15), color: IRON, matrix: M(.31, h(.92), 0, 0, 0, -.3, 1, .72, 1)},
        {geometry: box(.14, .11, .04), color: GOLD, matrix: M(0, h(.55), .39)},
        {geometry: new THREE.TorusGeometry(.04, .014, 8, 16), color: GOLD, matrix: M(-.1, h(.48), .3, Math.PI / 2)},
        {geometry: new THREE.TorusGeometry(.04, .014, 8, 16), color: GOLD, matrix: M(.1, h(.48), .3, Math.PI / 2)},
      ]),
    });
  }
  return upperCache.get(key);
}

// Face skin: head, ears, bulbous nose (own material per dwarf so it can blush)
const skinGeometry = merge([
  {geometry: ball(.25, 28, 20), color: 0xffffff, matrix: M(0, 1.1 - HIP, .02)},
  {geometry: ball(.06), color: 0xffffff, matrix: M(-.25, 1.1 - HIP, .02, 0, 0, 0, .55, 1, .85)},
  {geometry: ball(.06), color: 0xffffff, matrix: M(.25, 1.1 - HIP, .02, 0, 0, 0, .55, 1, .85)},
  {geometry: ball(.085), color: 0xf4c9b0, matrix: M(0, 1.085 - HIP, .265, 0, 0, 0, .95, .85, 1.1)},
]);

// Arms swing around the shoulder line; both gloves grip the handle
const SHOULDER = .9;
const SKIN_TONE = 0xf1c27d;
const armsCache = new Map();
function armsGeometry(tunic) {
  if (!armsCache.has(tunic)) {
    // Sleeved upper arm, bare forearm with a leather bracer, hand on the haft
    const arm = (side, hand) => {
      const shoulder = [side * .33, 0, 0], elbow = [side * .36, -.2, .2], wrist = [hand[0] + side * .03, hand[1], hand[2] - .06];
      return [
        {geometry: ball(.1), color: tunic, matrix: M(...shoulder)},
        limb(shoulder, elbow, .095, .085, tunic),
        {geometry: ball(.085), color: tunic, matrix: M(...elbow)},
        limb(elbow, wrist, .07, .06, SKIN_TONE),
        limb([elbow[0] + (wrist[0] - elbow[0]) * .45, elbow[1] + (wrist[1] - elbow[1]) * .45, elbow[2] + (wrist[2] - elbow[2]) * .45], wrist, .074, .068, DARK_LEATHER),
        {geometry: ball(.072), color: SKIN_TONE, matrix: M(hand[0], hand[1], hand[2], 0, 0, 0, 1.05, .95, 1.2)},
      ];
    };
    armsCache.set(tunic, merge([
      ...arm(-1, [-.035, 0, .44]),
      ...arm(1, [.035, 0, .58]),
    ]));
  }
  return armsCache.get(tunic);
}
// Axe haft with leather grip, and the iron head (separate material)
const axeWood = merge([
  {geometry: cyl(.03, .034, .86, 12), color: 0x7a4b25, matrix: M(0, 0, .68, Math.PI / 2)},
  {geometry: cyl(.038, .038, .2, 12), color: 0x3a2618, matrix: M(0, 0, .5, Math.PI / 2)},
]);
const axeMetal = merge([
  {geometry: axeHead(), color: 0xd5dce2},
  {geometry: cyl(.042, .042, .1, 12), color: DARK_IRON, matrix: M(0, 0, 1.0, Math.PI / 2)},
]);

const logGeometry = merge([{geometry: cyl(.13, .13, .9, 14), color: 0x6b4226, capColor: 0xe2b27a, matrix: M(0, 0, 0, Math.PI / 2, 0, 0)}]);

const sharedMaterial = new THREE.MeshStandardMaterial({vertexColors: true, roughness: .85, metalness: 0});
const metalMaterial = new THREE.MeshStandardMaterial({vertexColors: true, roughness: .38, metalness: .7});

// Soft studio surroundings for reflections: a dim gradient dome with a warm
// key panel and a cool rim panel
function studioEnvironment(renderer) {
  const env = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), new THREE.MeshBasicMaterial({side: THREE.BackSide, vertexColors: true}));
  const colors = [], top = new THREE.Color(0x7d8b9a), bottom = new THREE.Color(0x1c2128);
  const pos = dome.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const c = bottom.clone().lerp(top, (pos.getY(i) / 10 + 1) / 2);
    colors.push(c.r, c.g, c.b);
  }
  dome.geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  env.add(dome);
  const panel = (color, x, y, z, w, h) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({color, side: THREE.DoubleSide}));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  panel(0xfff1d6, -4, 6, 5, 5, 3);
  panel(0x8fb8ff, 6, 2, -5, 3, 4);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, .02).texture;
  pmrem.dispose();
  return texture;
}

// ---------- scene ----------

let renderer;
try {
  renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: "low-power"});
} catch (_) {
  renderer = null;
}

if (renderer) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer);
  const camera = new THREE.PerspectiveCamera(28, 2, .1, 100);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3a2a1e, 1.4));
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -.002;
  scene.add(sun, sun.target);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.ShadowMaterial({opacity: .38}));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const crewGroup = new THREE.Group();
  scene.add(crewGroup);
  const pile = new THREE.InstancedMesh(logGeometry, sharedMaterial, MAX_LOGS);
  pile.castShadow = pile.receiveShadow = true;
  pile.count = 0;
  scene.add(pile);

  // Particle pools: wood chips and sweat drops
  const chipGeometry = box(.07, .03, .07);
  const chipMaterial = new THREE.MeshStandardMaterial({color: 0xe0b07a, flatShading: true});
  const dropGeometry = ball(.035, 5, 4);
  const dropMaterial = new THREE.MeshStandardMaterial({color: 0x6cc6ff, emissive: 0x1b4a66, roughness: .2});
  const particles = [];
  function spawn(kind, position, velocity, life) {
    let p = particles.find(item => !item.alive && item.kind === kind);
    if (!p) {
      if (particles.length > 300) return;
      p = {kind, mesh: new THREE.Mesh(kind === "chip" ? chipGeometry : dropGeometry, kind === "chip" ? chipMaterial : dropMaterial), velocity: new THREE.Vector3()};
      p.mesh.castShadow = kind === "chip";
      particles.push(p);
      scene.add(p.mesh);
    }
    p.alive = true; p.age = 0; p.life = life;
    p.mesh.visible = true;
    p.mesh.position.copy(position);
    p.mesh.scale.setScalar(1);
    p.velocity.copy(velocity);
  }

  // "z" sprites for the sleeping dwarf
  const zCanvas = document.createElement("canvas");
  zCanvas.width = zCanvas.height = 64;
  const zc = zCanvas.getContext("2d");
  zc.fillStyle = "#c3ccd5"; zc.font = "bold 48px monospace"; zc.textAlign = "center"; zc.textBaseline = "middle";
  zc.fillText("z", 32, 34);
  const zMaterial = new THREE.SpriteMaterial({map: new THREE.CanvasTexture(zCanvas), transparent: true, depthWrite: false});
  const zSprites = [0, 1, 2].map(() => {
    const sprite = new THREE.Sprite(zMaterial.clone());
    sprite.visible = false;
    scene.add(sprite);
    return sprite;
  });

  const dwarves = [];
  let sleeping = false;
  let woodLogs = 0;
  let layoutKey = "";
  let width = 0, height = 0;

  const makeAxe = () => {
    const axe = new THREE.Group();
    axe.add(new THREE.Mesh(axeWood, sharedMaterial), new THREE.Mesh(axeMetal, metalMaterial));
    return axe;
  };

  function makeDwarf(index) {
    const group = new THREE.Group();
    const tunic = TUNICS[index % TUNICS.length], beard = BEARDS[(index * 3 + 1) % BEARDS.length];
    const block = new THREE.Mesh(blockGeometry, sharedMaterial);
    // Axe left stuck in the block while its owner naps
    const restingAxe = makeAxe();
    restingAxe.position.set(0, 1.6, .64);
    restingAxe.rotation.x = 1.0;
    restingAxe.visible = false;
    // Everything that lies down for a nap
    const pose = new THREE.Group();
    const lower = new THREE.Mesh(lowerGeometry, sharedMaterial);
    const upper = new THREE.Group();
    upper.position.y = HIP;
    const geometry = upperGeometry(tunic, beard);
    const skinMaterial = new THREE.MeshStandardMaterial({vertexColors: true, color: SKIN.clone(), roughness: .6});
    const arms = new THREE.Group();
    arms.position.set(0, SHOULDER - HIP, .02);
    const axe = makeAxe();
    arms.add(new THREE.Mesh(armsGeometry(tunic), sharedMaterial), axe);
    upper.add(new THREE.Mesh(geometry.cloth, sharedMaterial), new THREE.Mesh(geometry.metal, metalMaterial), new THREE.Mesh(skinGeometry, skinMaterial), arms);
    pose.add(lower, upper);
    group.add(block, restingAxe, pose);
    group.traverse(object => { if (object.isMesh) object.castShadow = object.receiveShadow = true; });
    // Turn towards the block on the right, three-quarter view to the camera
    group.rotation.y = .62;
    crewGroup.add(group);
    return {group, pose, upper, arms, axe, restingAxe, skinMaterial, phase: (index * .37) % 1, swing: 1, load: 0, pop: 0, sweatTimer: Math.random() * .5};
  }

  function perRow() {
    return Math.max(4, Math.min(8, Math.floor(width / 62)));
  }

  function layout() {
    const cols = perRow();
    const rows = Math.ceil(dwarves.length / cols);
    const spacingX = 1.75, spacingZ = 1.55;
    dwarves.forEach((dwarf, i) => {
      const row = Math.floor(i / cols), col = i % cols;
      const inRow = Math.min(cols, dwarves.length - row * cols);
      dwarf.group.position.set((col - (inRow - 1) / 2) * spacingX + (row % 2) * .35, 0, -row * spacingZ);
    });
    const crewHalf = (Math.min(cols, dwarves.length) - 1) / 2 * spacingX + .9;
    // Wood pile: triangle stack to the right of the crew
    const pileX = crewHalf + .9;
    const matrix = new THREE.Matrix4();
    let placed = 0, rowCount = 1;
    while (rowCount * (rowCount + 1) / 2 < woodLogs) rowCount++;
    for (let level = 0; level < rowCount && placed < woodLogs; level++) {
      const logsInLevel = rowCount - level;
      for (let k = 0; k < logsInLevel && placed < woodLogs; k++) {
        matrix.makeTranslation(pileX + (k + level / 2) * .27, .13 + level * .235, -.2);
        pile.setMatrixAt(placed++, matrix);
      }
    }
    pile.count = placed;
    pile.instanceMatrix.needsUpdate = true;
    const pileWidth = placed ? rowCount * .27 + .2 : 0;

    // Fit the camera to crew + pile: project the bounding box and close in
    // until it fills the frame
    const minX = -crewHalf - .3, maxX = placed ? pileX + pileWidth : crewHalf + .6;
    const box = new THREE.Box3(new THREE.Vector3(minX, 0, -(rows - 1) * spacingZ - .45), new THREE.Vector3(maxX, 1.8, 1.25));
    // A napping dwarf stretches out behind his block
    if (sleeping) { box.min.x -= 1.8; box.min.z -= .5; box.max.y = 1.2; }
    const target = box.getCenter(new THREE.Vector3());
    const elevation = .42;
    const direction = new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation));
    const corners = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    const right = new THREE.Vector3(), up = new THREE.Vector3(), p = new THREE.Vector3();
    let distance = 12, spanX = 0, spanY = 0;
    const fit = () => {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), tanH = tanV * camera.aspect;
      for (let i = 0; i < 8; i++) {
        camera.position.copy(target).addScaledVector(direction, distance);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const corner of corners) {
          p.copy(corner).project(camera);
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
        }
        right.setFromMatrixColumn(camera.matrixWorld, 0);
        up.setFromMatrixColumn(camera.matrixWorld, 1);
        target.addScaledVector(right, (x0 + x1) / 2 * distance * tanH).addScaledVector(up, (y0 + y1) / 2 * distance * tanV);
        spanX = (x1 - x0) / 2; spanY = (y1 - y0) / 2;
        distance *= Math.max(spanX, spanY) / .97;
      }
      camera.position.copy(target).addScaledVector(direction, distance);
      camera.lookAt(target);
    };
    // Start tall enough for the rows, then shrink to what the crew needs so
    // a wide scene on a phone does not leave an empty band above it
    setHeight(Math.round(Math.min(250, 118 + (rows - 1) * 44)));
    fit();
    if (spanY < spanX * .9) {
      setHeight(Math.max(96, Math.round(height * spanY / spanX) + 6));
      fit();
    }
    const centerX = target.x, centerZ = target.z, sceneWidth = maxX - minX, depth = box.max.z - box.min.z;

    sun.position.set(centerX - 4, 9, centerZ + 6);
    sun.target.position.copy(target);
    const extent = Math.max(sceneWidth, depth) / 2 + 2;
    Object.assign(sun.shadow.camera, {left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 30});
    sun.shadow.camera.updateProjectionMatrix();
  }

  // Only the width comes from the page; layout() picks the height to fit
  function resize() {
    const w = stage.clientWidth;
    if (!w || w === width) return;
    width = w;
    layoutKey = "";
  }

  function setHeight(h) {
    height = h;
    stage.style.height = `${h}px`;
    renderer.setSize(width, h, false);
  }

  function update(state) {
    if (!state) return;
    const loads = state.loads || [];
    sleeping = !loads.length;
    const wanted = sleeping ? 1 : loads.length;
    while (dwarves.length < wanted) dwarves.push(makeDwarf(dwarves.length));
    while (dwarves.length > wanted) crewGroup.remove(dwarves.pop().group);
    dwarves.forEach((dwarf, i) => {
      dwarf.load = sleeping ? 0 : loads[i];
      dwarf.swing = 1.6 - Math.min(dwarf.load, 100) / 100 * 1.15;
    });
    if (state.kwh != null) woodLogs = Math.min(MAX_LOGS, Math.floor(state.kwh / KWH_PER_LOG));
    resize();
    const key = `${dwarves.length}|${sleeping}|${woodLogs}|${width}`;
    if (key !== layoutKey) { layoutKey = key; layout(); }
    if (reducedMotion) render(0);
  }

  // Chop curve: hold up, swing down, small rebound, lift back up
  function axeAngle(p) {
    if (p < .12) return RAISED_ANGLE;
    if (p < .5) { const t = (p - .12) / .38; return RAISED_ANGLE + (HIT_ANGLE - RAISED_ANGLE) * t * t; }
    if (p < .6) return HIT_ANGLE - .08 * Math.sin((p - .5) / .1 * Math.PI);
    const t = (p - .6) / .4;
    return HIT_ANGLE + (RAISED_ANGLE - HIT_ANGLE) * (1 - (1 - t) * (1 - t));
  }

  const tmp = new THREE.Vector3();
  let clock = 0;
  function render(dt) {
    clock += dt;
    dwarves.forEach((dwarf, i) => {
      dwarf.pop = Math.min(1, dwarf.pop + dt * 4);
      const s = reducedMotion ? 1 : 1 - Math.pow(1 - dwarf.pop, 3);
      const asleep = sleeping;
      dwarf.axe.visible = !asleep;
      dwarf.restingAxe.visible = asleep;
      if (asleep) {
        // Napping on his back next to the block, hands folded on the belly,
        // chest rising and falling
        // lie down first, then turn so he stretches out across the view
        dwarf.pose.rotation.set(-Math.PI / 2, .95, .1, "YXZ");
        dwarf.pose.position.set(-.15, .37, .1);
        dwarf.arms.rotation.x = 1.42;
        dwarf.upper.rotation.x = 0;
        dwarf.upper.scale.set(1, 1, 1 + Math.sin(clock * 1.7) * .035);
        dwarf.group.scale.setScalar(s);
        dwarf.skinMaterial.color.copy(SKIN);
        return;
      }
      dwarf.pose.rotation.set(0, 0, 0, "XYZ");
      dwarf.pose.position.set(0, 0, 0);
      dwarf.upper.scale.set(1, 1, 1);
      dwarf.group.scale.setScalar(s);
      const before = dwarf.phase;
      dwarf.phase = (dwarf.phase + dt / dwarf.swing) % 1;
      const angle = reducedMotion ? HIT_ANGLE : axeAngle(dwarf.phase);
      // Lean back with the axe up, put the whole body into the strike
      const lean = -.07 + (angle - RAISED_ANGLE) / (HIT_ANGLE - RAISED_ANGLE) * .2;
      dwarf.upper.rotation.x = lean;
      dwarf.arms.rotation.x = angle - lean;
      const hit = before < .5 && (dwarf.phase >= .5 || dwarf.phase < before);
      if (hit && !reducedMotion) {
        dwarf.group.localToWorld(tmp.set(0, .62, .95));
        for (let k = 0; k < 3; k++) {
          spawn("chip", tmp, new THREE.Vector3((Math.random() - .5) * 2.4, 1.6 + Math.random() * 1.4, (Math.random() - .3) * 1.6), .7);
        }
      }
      // Blush when straining, sweat when working hard
      dwarf.skinMaterial.color.copy(SKIN).lerp(STRAIN, Math.max(0, Math.min(1, (dwarf.load - 85) / 15)));
      if (dwarf.load >= 70 && !reducedMotion) {
        dwarf.sweatTimer -= dt;
        if (dwarf.sweatTimer <= 0) {
          dwarf.sweatTimer = .35 + Math.random() * .3;
          const side = Math.random() < .5 ? -1 : 1;
          dwarf.upper.localToWorld(tmp.set(side * .2, 1.22 - HIP, .14));
          spawn("drop", tmp, new THREE.Vector3(side * .25, .4, 0), .65);
        }
      }
    });

    for (const p of particles) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) { p.alive = false; p.mesh.visible = false; continue; }
      p.velocity.y -= 9 * dt;
      p.mesh.position.addScaledVector(p.velocity, dt);
      if (p.mesh.position.y < .02) { p.mesh.position.y = .02; p.velocity.set(0, 0, 0); }
      p.mesh.rotation.x += dt * 9; p.mesh.rotation.y += dt * 7;
      p.mesh.scale.setScalar(1 - Math.max(0, (p.age / p.life - .7) / .3));
    }

    zSprites.forEach((sprite, k) => {
      sprite.visible = sleeping && dwarves.length > 0;
      if (!sprite.visible) return;
      const t = (clock * .45 + k / 3) % 1;
      dwarves[0].upper.localToWorld(tmp.set(0, 1.1 - HIP, .3));
      sprite.position.set(tmp.x + t * .5, tmp.y + t * .8, tmp.z);
      sprite.scale.setScalar(.18 + t * .2);
      sprite.material.opacity = Math.sin(t * Math.PI);
    });

    renderer.render(scene, camera);
  }

  let visible = true, last = performance.now();
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; }).observe(canvas);
  // Only the stage width drives the layout; its height is ours to set
  let observedWidth = 0;
  new ResizeObserver(entries => {
    const w = Math.round(entries[0].contentRect.width);
    if (w === observedWidth) return;
    observedWidth = w;
    requestAnimationFrame(() => update(window.rigDwarfState));
  }).observe(stage);

  function frame(now) {
    const dt = Math.min(.05, (now - last) / 1000);
    last = now;
    if (visible && !reducedMotion && width) render(dt);
    requestAnimationFrame(frame);
  }

  stage.classList.remove("hidden");
  fallback.classList.add("hidden");
  resize();
  window.rigDwarves = {update};
  update(window.rigDwarfState || {loads: []});
  requestAnimationFrame(frame);
}
