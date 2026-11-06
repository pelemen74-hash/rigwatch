// RigWatch: the rig itself in 3D, modelled after photos of the open frame.
// Fans spin with the live RPM, cards glow with their hotspot temperature.
// 1 unit = 10 cm.
import * as THREE from "/vendor/three.module.min.js";

const GPU_COLORS = ["#26d6d0", "#b58cff", "#ffb627", "#62df88", "#ff4d3d", "#4d8dff"];
const RAIL_Y = 2.4;
// Printed labels for the parts ("rig" section of config.json). Things like the
// PSU model cannot be read from software; empty means unlabelled.
const config = await fetch("/api/config", {cache: "no-store"}).then(response => response.json()).catch(() => ({}));
const LABELS = {psu_name: "", gpu_brand: "", board_label: "", radiator_label: "", ...config.rig};

// Series name printed on the card's top edge, from the detected GPU name
function seriesName(gpuName = "") {
  if (/radeon|amd/i.test(gpuName)) return "RADEON";
  if (/geforce|nvidia|rtx|gtx/i.test(gpuName)) return "GEFORCE";
  if (/\barc\b|intel/i.test(gpuName)) return "ARC";
  return "";
}

// Card positions along the front rail, left to right as GPU 1..n. Up to six
// cards keep the gap above the CPU cooler like the real frame; more cards
// spread evenly across the whole rail.
function cardPositions(count) {
  if (count > 6) return Array.from({length: count}, (_, i) => -2.75 + i * 5.6 / (count - 1));
  const step = count > 4 ? .7 : .85;
  const left = Math.ceil(count / 2), right = count - left;
  return [
    ...Array.from({length: left}, (_, i) => -.95 - (left - 1 - i) * step),
    ...Array.from({length: right}, (_, i) => 1.55 + i * step),
  ];
}
const FAN_SPEED = 1 / 600;   // turns per second per RPM: 1/10 of real speed

const stage = document.getElementById("rigStage");
const canvas = document.getElementById("rigCanvas");
const labelLayer = document.getElementById("rigLabels");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function merge(parts) {
  const positions = [], normals = [], colors = [];
  for (const {geometry, color, matrix} of parts) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    const pos = g.attributes.position, nor = g.attributes.normal, c = new THREE.Color(color);
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      colors.push(c.r, c.g, c.b);
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return merged;
}

const M = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));

function textTexture(text, {width = 512, height = 64, font = "bold 44px sans-serif", color = "#e8edf2", background = null, letterSpacing = "6px"} = {}) {
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  const ctx = c.getContext("2d");
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, width, height); }
  ctx.fillStyle = color; ctx.font = font; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  if ("letterSpacing" in ctx) ctx.letterSpacing = letterSpacing;
  ctx.fillText(text, width / 2, height / 2 + 2);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const mat = (color, roughness = .7, metalness = .2, extra = {}) => new THREE.MeshStandardMaterial({color, roughness, metalness, ...extra});
const vertexMat = new THREE.MeshStandardMaterial({vertexColors: true, roughness: .55, metalness: .25});
const steel = mat(0x15181c, .45, .6);
const shroudMat = mat(0x1c1f23, .55, .35);

function mesh(geometry, material, x = 0, y = 0, z = 0, parent = null) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

// Fan rotor in the XY plane, spinning around Z: nine pitched blades and the
// optional "X" logo on the hub (XFX style)
function rotorGeometry(radius, bladeColor, logo = true) {
  const parts = [];
  for (let k = 0; k < 9; k++) {
    const blade = new THREE.Matrix4().makeRotationZ(k * Math.PI * 2 / 9)
      .multiply(M(radius * .55, 0, 0, .55, 0, .25));
    parts.push({geometry: new THREE.BoxGeometry(radius * .62, radius * .3, .012), color: bladeColor, matrix: blade});
  }
  parts.push({geometry: new THREE.CylinderGeometry(radius * .3, radius * .3, .05, 16), color: 0x16191c, matrix: M(0, 0, .01, Math.PI / 2)});
  if (logo) {
    parts.push({geometry: new THREE.BoxGeometry(radius * .36, radius * .07, .01), color: 0xc9d0d6, matrix: M(0, 0, .04, 0, 0, Math.PI / 4)});
    parts.push({geometry: new THREE.BoxGeometry(radius * .36, radius * .07, .01), color: 0xc9d0d6, matrix: M(0, 0, .04, 0, 0, -Math.PI / 4)});
  }
  return merge(parts);
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: "low-power"});
} catch (_) {
  renderer = null;
}

if (!renderer) {
  document.getElementById("rigFallback").textContent = "3D wird von diesem Browser nicht unterstützt";
} else {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.HemisphereLight(0x8fa3b8, 0x101318, 3));
  const envPanel = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({color: 0xfff1d6, side: THREE.DoubleSide}));
  envPanel.position.set(-4, 6, 5);
  envPanel.lookAt(0, 0, 0);
  envScene.add(envPanel, new THREE.Mesh(new THREE.SphereGeometry(20, 16, 8), new THREE.MeshStandardMaterial({color: 0x2a323c, side: THREE.BackSide})));
  scene.environment = pmrem.fromScene(envScene, .03).texture;
  pmrem.dispose();
  const camera = new THREE.PerspectiveCamera(32, 2, .1, 200);
  scene.add(new THREE.HemisphereLight(0xc4d6ff, 0x2a2018, 1.8));
  const key = new THREE.DirectionalLight(0xfff0dc, 3.0);
  key.position.set(-5, 10, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, {left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30});
  key.shadow.bias = -.001;
  const rim = new THREE.DirectionalLight(0x7fb4ff, .9);
  rim.position.set(6, 4, -6);
  scene.add(key, rim);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(9, 48), new THREE.ShadowMaterial({opacity: .45}));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const rig = new THREE.Group();
  scene.add(rig);

  // ---- frame: square steel tubes ----
  const tube = .14;
  const bar = (sx, sy, sz, x, y, z) => mesh(new THREE.BoxGeometry(sx, sy, sz), steel, x, y, z, rig);
  for (const z of [-1.95, 1.95]) {
    bar(6.3, tube, tube, 0, .07, z);            // bottom rails
    bar(6.3, tube, tube, 0, RAIL_Y, z);         // top rails, cards bolt to the front one
  }
  for (const x of [-3.08, 3.08]) {
    bar(tube, tube, 4.0, x, .07, 0);
    bar(tube, tube, 4.0, x, RAIL_Y, 0);
    for (const z of [-1.95, 1.95]) bar(tube, RAIL_Y, tube, x, RAIL_Y / 2, z);
  }
  bar(6.3, .1, .3, 0, RAIL_Y - .02, -.55);       // middle support under the cards
  mesh(new THREE.BoxGeometry(6.1, .03, 3.85), mat(0x101317, .8, .3), 0, .15, 0, rig);  // tray
  const screwGeometry = new THREE.CylinderGeometry(.05, .05, .04, 8);
  const screwMat = mat(0xb8bec4, .3, .9);

  // ---- motherboard with I/O cover, RAM, NVMe ----
  const board = new THREE.Group();
  board.position.set(.75, .18, .15);
  rig.add(board);
  mesh(new THREE.BoxGeometry(3.05, .04, 2.44), mat(0x16191d, .8, .2), 0, .02, 0, board);
  const carbon = mesh(new THREE.BoxGeometry(1.5, .32, .55), mat(0x2b2f35, .35, .55), -.6, .2, 1.0, board);
  if (LABELS.board_label) carbon.material.map = textTexture(LABELS.board_label, {width: 512, height: 128, font: "italic bold 52px sans-serif", color: "#cfd6dc", background: "#2b2f35"});
  mesh(new THREE.BoxGeometry(1.5, .02, .04), mat(0x55e0a0, .4, 0, {emissive: 0x2fbf80, emissiveIntensity: 1.2}), -.6, .37, 1.27, board);
  for (let k = 0; k < 4; k++) mesh(new THREE.BoxGeometry(.06, .34, 1.35), mat(0x1d2025, .5, .4), .62 + k * .1, .2, -.05, board);
  mesh(new THREE.BoxGeometry(.8, .03, .22), mat(0x2b3138, .4, .5), -.5, .05, -.5, board);   // NVMe heatsink
  mesh(new THREE.BoxGeometry(.75, .08, .5), mat(0x23272c, .5, .5), -1.0, .07, .25, board);  // VRM heatsink

  // ---- AIO pump with glowing logo ring ----
  const pump = new THREE.Group();
  pump.position.set(.25, .2, .2);
  rig.add(pump);
  mesh(new THREE.CylinderGeometry(.38, .4, .32, 24), mat(0x1a1d21, .4, .6), 0, .17, 0, pump);
  const ringMat = mat(0xffffff, .3, 0, {emissive: 0xbfe4ff, emissiveIntensity: 1.6});
  const ring = mesh(new THREE.TorusGeometry(.33, .035, 8, 32), ringMat, 0, .34, 0, pump);
  ring.rotation.x = Math.PI / 2;
  const capMat = mat(0x0d0f12, .3, .3, {emissive: 0x4a90d9, emissiveIntensity: .35});
  mesh(new THREE.CylinderGeometry(.3, .3, .02, 24), capMat, 0, .335, 0, pump);
  const pumpLight = new THREE.PointLight(0x9fd2ff, 1.2, 2.2);
  pumpLight.position.set(0, .7, 0);
  pump.add(pumpLight);

  // ---- PSU, front left ----
  const psu = new THREE.Group();
  psu.position.set(-2.2, .17, 1.05);
  rig.add(psu);
  mesh(new THREE.BoxGeometry(1.5, .86, 1.6), mat(0x16191c, .6, .4), 0, .43, 0, psu);
  if (LABELS.psu_name) {
    // model name on top, on the left side and on the front, like the printed labels
    const psuText = new THREE.MeshStandardMaterial({map: textTexture(LABELS.psu_name, {width: 512, height: 112, font: "bold 92px sans-serif", color: "#ffffff", letterSpacing: "4px"}), transparent: true, emissive: 0xffffff, emissiveIntensity: .25});
    psuText.emissiveMap = psuText.map;
    const psuTop = mesh(new THREE.PlaneGeometry(1.4, .306), psuText, 0, .865, .05, psu);
    psuTop.rotation.x = -Math.PI / 2;
    const psuSide = mesh(new THREE.PlaneGeometry(1.4, .306), psuText, -.755, .45, 0, psu);
    psuSide.rotation.y = -Math.PI / 2;
    const psuFront = mesh(new THREE.PlaneGeometry(.75, .164), psuText, -.3, .62, .805, psu);
    psuTop.castShadow = psuSide.castShadow = psuFront.castShadow = false;
  }
  mesh(new THREE.BoxGeometry(.3, .2, .03), mat(0x0b0c0e, .6, .2), .35, .38, .81, psu);       // power socket
  mesh(new THREE.BoxGeometry(.1, .14, .03), mat(0x0b0c0e, .6, .2), -.05, .38, .81, psu);     // switch

  // ---- 360 mm AIO radiator standing right of the frame ----
  const radiator = new THREE.Group();
  radiator.position.set(3.55, 0, -.1);
  rig.add(radiator);
  mesh(new THREE.BoxGeometry(.28, 1.25, 3.95), mat(0x15181b, .6, .5), 0, .66, 0, radiator);
  if (LABELS.radiator_label) {
    const brand = mesh(new THREE.PlaneGeometry(1.6, .22), new THREE.MeshStandardMaterial({map: textTexture(LABELS.radiator_label, {font: "bold 46px sans-serif", color: "#c9d0d6"}), transparent: true}), 0, 1.295, 0, radiator);
    brand.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    brand.castShadow = false;
  }
  const radiatorFans = [];
  const radRotor = rotorGeometry(.5, 0x2a2e33, false);
  for (let k = 0; k < 3; k++) {
    const fan = new THREE.Group();
    fan.position.set(.27, .66, (k - 1) * 1.25);
    fan.rotation.y = Math.PI / 2;
    mesh(new THREE.BoxGeometry(1.2, 1.2, .24), mat(0x121417, .7, .2), 0, 0, -.02, fan);
    const rotor = mesh(radRotor, vertexMat, 0, 0, .12, fan);
    radiator.add(fan);
    radiatorFans.push(rotor);
  }
  // coolant tubes from pump to radiator
  const tubeMat = mat(0x0e1012, .5, .1);
  for (const [dz, end] of [[-.1, .55], [.1, -.75]]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(.45, .55, .2 + dz), new THREE.Vector3(1.6, .9, .1 + dz), new THREE.Vector3(2.9, 1.0, end), new THREE.Vector3(3.4, 1.0, end),
    ]);
    mesh(new THREE.TubeGeometry(curve, 24, .06, 8), tubeMat, 0, 0, 0, rig);
  }

  // ---- graphics cards: built from whatever the server reports ----
  const fanRotor = rotorGeometry(.38, 0x2c3035, LABELS.gpu_brand.toUpperCase() === "XFX");
  const ringGeometry = new THREE.TorusGeometry(.4, .025, 6, 28);
  const ringMaterial = mat(0x2a2e33, .4, .6);
  const seriesTextures = new Map();
  const seriesTexture = name => {
    if (!seriesTextures.has(name)) seriesTextures.set(name, textTexture(name, {font: "bold 46px sans-serif", color: "#eef2f5", letterSpacing: "8px"}));
    return seriesTextures.get(name);
  };
  const brandTexture = LABELS.gpu_brand ? textTexture(LABELS.gpu_brand.toUpperCase(), {width: 256, height: 64, font: "italic 900 50px sans-serif", color: "#eef2f5"}) : null;

  function buildCard(x, index, count, series) {
    const card = new THREE.Group();
    card.position.set(x, RAIL_Y + .08, 0);
    rig.add(card);
    const glowMat = mat(0x1c1f23, .5, .3, {emissive: 0x000000});
    mesh(new THREE.BoxGeometry(.36, 1.12, 2.62), glowMat, .03, .56, .62, card);                  // shroud
    mesh(new THREE.BoxGeometry(.04, 1.08, 2.55), mat(0x2a2e33, .35, .7), -.23, .56, .6, card);   // backplate
    mesh(new THREE.BoxGeometry(.1, .9, 2.4), mat(0x6c625a, .5, .8), -.16, .5, .62, card);        // heatsink fins peeking out
    // thin colour line on the outer top edge identifies the card
    mesh(new THREE.BoxGeometry(.035, .03, 2.6), mat(0x111111, .4, .2, {emissive: new THREE.Color(GPU_COLORS[index % GPU_COLORS.length]), emissiveIntensity: .8}), .2, 1.13, .62, card);
    if (series) {
      const label = mesh(new THREE.PlaneGeometry(1.0, .16), new THREE.MeshStandardMaterial({map: seriesTexture(series), transparent: true}), -.03, 1.15, 1.15, card);
      label.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
      label.castShadow = false;
    }
    if (brandTexture) {
      const brand = mesh(new THREE.PlaneGeometry(.5, .13), new THREE.MeshStandardMaterial({map: brandTexture, transparent: true}), -.03, 1.15, -.35, card);
      brand.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
      brand.castShadow = false;
    }
    // bracket hanging below the rail, bolted on with two screws
    mesh(new THREE.BoxGeometry(.3, 1.2, .03), mat(0x9ea4aa, .3, .85), 0, -.35, 1.98, card);
    for (const dx of [-.09, .09]) mesh(screwGeometry, screwMat, dx, -.06, 2.03, card).rotation.x = Math.PI / 2;
    // fans on the right face
    const rotors = [];
    for (let k = 0; k < 3; k++) {
      const fan = new THREE.Group();
      fan.position.set(.215, .56, .62 + (k - 1) * .86);
      fan.rotation.y = Math.PI / 2;
      card.add(fan);
      mesh(ringGeometry, ringMaterial, 0, 0, 0, fan);
      rotors.push(mesh(fanRotor, vertexMat, 0, 0, .01, fan));
    }
    // PCIe power cables arcing over the back to the PSU side: grey sleeves
    // on the left half, black on the right, as on the real rig
    const cable = mat(index < count / 2 ? 0x8d939a : 0x1a1c1f, .8, 0);
    for (const dx of [-.06, .06]) {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(dx, 1.12, -.2), new THREE.Vector3(dx, 1.55, -.45), new THREE.Vector3(dx * 3 - x * .15, 1.2, -1.4), new THREE.Vector3(-x * .4 - 1.2, -.6, -2.2),
      ]);
      mesh(new THREE.TubeGeometry(curve, 20, .045, 6), cable, 0, 0, 0, card);
    }
    const tag = addLabel(card, 0, 1.3, .62, "gpu");
    tag.element.style.setProperty("--label-color", GPU_COLORS[index % GPU_COLORS.length]);
    return {card, glowMat, rotors, tag, angle: Math.random() * 6, rpm: 0, temperature: null};
  }

  let cards = [];
  function buildCards(gpus) {
    for (const item of cards) {
      rig.remove(item.card);
      item.tag.element.remove();
      labels.splice(labels.indexOf(item.tag), 1);
      item.card.traverse(object => { if (object.isMesh && object.geometry !== fanRotor && object.geometry !== ringGeometry && object.geometry !== screwGeometry) object.geometry.dispose(); });
    }
    cards = cardPositions(gpus.length).map((x, index) => buildCard(x, index, gpus.length, seriesName(gpus[index].name)));
  }

  // ---- live labels ----
  // HTML tags that follow an anchor point on the model
  const labels = [];
  function addLabel(parent, x, y, z, className) {
    const element = document.createElement("div");
    element.className = `rig-label ${className}`;
    labelLayer.appendChild(element);
    const object = new THREE.Object3D();
    object.position.set(x, y, z);
    parent.add(object);
    const label = {element, object};
    labels.push(label);
    return label;
  }
  const cpuLabel = addLabel(pump, 0, .75, 0, "cpu");
  const psuLabel = addLabel(psu, 0, 1.1, 0, "psu");

  // ---- heat colouring ----
  const cool = new THREE.Color(0x000000), warm = new THREE.Color(0xff9a1f), hot = new THREE.Color(0xff2a1a);
  function heatColor(t, target) {
    if (t == null) return target.set(0x000000);
    // dark until 65 °C, a gentle amber glow up to 90 °C, then red
    if (t < 65) return target.copy(cool);
    if (t < 90) return target.copy(cool).lerp(warm, ((t - 65) / 25) ** 2 * .35);
    return target.copy(warm).multiplyScalar(.35).lerp(hot, Math.min(1, (t - 90) / 10));
  }
  const level = (t, warn, crit) => t == null ? "off" : t >= crit ? "hot" : t >= warn ? "warn" : "";

  let live = false;
  function update(data) {
    if (!data) return;
    live = true;
    const gpus = data.gpus || [];
    if (gpus.length !== cards.length) buildCards(gpus);
    cards.forEach((item, index) => {
      const gpu = gpus[index];
      item.rpm = Number(gpu.fan_rpm) || 0;
      item.temperature = gpu.junction_temperature;
      heatColor(item.temperature, item.glowMat.emissive);
      item.glowMat.emissiveIntensity = .5;
      const t = item.temperature != null ? `${Math.round(item.temperature)}°` : "--";
      item.tag.element.className = `rig-label gpu ${level(item.temperature, 95, 105)}`;
      item.tag.element.innerHTML = `<b>GPU ${index + 1}</b> ${t}<small>${item.rpm ? item.rpm + " rpm" : "Lüfter steht"}</small>`;
    });
    const cpuTemp = data.cpu?.temperature;
    // Pump ring: icy blue when cool, shifting to amber and red under heat
    const ringColor = heatColor(cpuTemp, new THREE.Color());
    ringMat.emissive.set(0xbfe4ff).lerp(ringColor, cpuTemp >= 60 ? Math.min(1, (cpuTemp - 60) / 30) : 0);
    pumpLight.color.copy(ringMat.emissive);
    cpuLabel.element.className = `rig-label cpu ${level(cpuTemp, 85, 95)}`;
    const cpuName = (data.cpu?.model || "CPU").replace(/^(AMD|Intel)\s+/i, "");
    cpuLabel.element.innerHTML = `<b>${cpuName}</b> ${cpuTemp != null ? Math.round(cpuTemp) + "°" : "--"}<small>${data.cpu?.usage != null ? Math.round(data.cpu.usage) + " % Last" : ""}</small>`;
    const watts = (Number(data.cpu?.power) || 0) + gpus.reduce((sum, gpu) => sum + (Number(gpu.power) || 0), 0);
    psuLabel.element.innerHTML = `<b>Netzteil</b> ${Math.round(watts)} W<small>CPU + GPU</small>`;
    for (const label of labels) label.w = 0;
    document.getElementById("rigFallback").classList.add("hidden");
    if (reducedMotion) render(0);
  }

  // ---- camera: drag sideways to orbit, vertical swipes still scroll the page ----
  const VIEWS = {front: {yaw: .38, pitch: .32}, fans: {yaw: 1.2, pitch: .22}, top: {yaw: .2, pitch: 1.05}};
  const view = {yaw: VIEWS.front.yaw, pitch: VIEWS.front.pitch, targetYaw: VIEWS.front.yaw, targetPitch: VIEWS.front.pitch};
  let idleUntil = 0, dragging = null;
  const target = new THREE.Vector3(.35, 1.75, .1);

  canvas.addEventListener("pointerdown", event => {
    dragging = {x: event.clientX, y: event.clientY, id: event.pointerId, mouse: event.pointerType === "mouse"};
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", event => {
    if (!dragging || event.pointerId !== dragging.id) return;
    view.targetYaw -= (event.clientX - dragging.x) * .008;
    if (dragging.mouse) view.targetPitch = Math.max(.05, Math.min(1.25, view.targetPitch + (event.clientY - dragging.y) * .006));
    dragging.x = event.clientX; dragging.y = event.clientY;
    idleUntil = performance.now() + 8000;
  });
  const endDrag = () => { dragging = null; };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  document.querySelectorAll("#rigViews button").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("#rigViews button").forEach(other => other.classList.toggle("active", other === button));
    const preset = VIEWS[button.dataset.view];
    // take the short way round
    view.targetYaw = preset.yaw + Math.round((view.yaw - preset.yaw) / (Math.PI * 2)) * Math.PI * 2;
    view.targetPitch = preset.pitch;
    idleUntil = performance.now() + 12000;
  }));

  let width = 0, height = 0;
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h || (w === width && h === height)) return;
    width = w; height = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(() => requestAnimationFrame(resize)).observe(stage);

  // Project each anchor, then push tags upwards until none overlap; a thin
  // leader line keeps the link to the part
  const projected = new THREE.Vector3();
  function placeLabels() {
    const shown = [];
    for (const label of labels) {
      if (label.element.hidden) continue;
      label.object.getWorldPosition(projected).project(camera);
      if (!label.w) { label.w = label.element.offsetWidth; label.h = label.element.offsetHeight; }
      shown.push({label, x: (projected.x + 1) / 2 * width, y: (1 - projected.y) / 2 * height, behind: projected.z > 1});
    }
    shown.sort((a, b) => b.y - a.y);
    const placed = [];
    for (const item of shown) {
      const {label} = item;
      let bottom = item.y - 10, x = item.x;
      const clashing = () => placed.find(rect => Math.abs(rect.x - x) < (rect.w + label.w) / 2 + 4 && bottom > rect.top - 4 && bottom - label.h < rect.bottom + 4);
      for (let guard = 0; guard < 12; guard++) {
        const clash = clashing();
        if (!clash) break;
        // Stack upwards while there is room, otherwise step aside
        if (clash.top - 6 - label.h > 2) bottom = clash.top - 6;
        else x = clash.x + Math.sign(x - clash.x || 1) * ((clash.w + label.w) / 2 + 6);
      }
      bottom = Math.max(bottom, label.h + 2);
      x = Math.min(width - label.w / 2 - 2, Math.max(label.w / 2 + 2, x));
      placed.push({x, w: label.w, top: bottom - label.h, bottom});
      label.element.style.transform = `translate(${(x - label.w / 2).toFixed(1)}px, ${(bottom - label.h).toFixed(1)}px)`;
      label.element.style.setProperty("--lead", `${Math.max(0, item.y - bottom).toFixed(1)}px`);
      label.element.style.opacity = item.behind ? 0 : 1;
    }
  }

  function render(dt) {
    if (!reducedMotion && performance.now() > idleUntil && !dragging) view.targetYaw += dt * .12;
    const ease = reducedMotion ? 1 : 1 - Math.pow(.002, dt);
    view.yaw += (view.targetYaw - view.yaw) * ease;
    view.pitch += (view.targetPitch - view.pitch) * ease;
    // Narrow (phone) screens need to step back further to fit the frame
    const distance = 12.5 * Math.max(1, 1.55 / camera.aspect) * (1 - view.pitch * .12);
    camera.position.set(
      target.x + Math.sin(view.yaw) * Math.cos(view.pitch) * distance,
      target.y + Math.sin(view.pitch) * distance,
      target.z + Math.cos(view.yaw) * Math.cos(view.pitch) * distance,
    );
    camera.lookAt(target);

    for (const item of cards) {
      item.angle += item.rpm * FAN_SPEED * Math.PI * 2 * dt;
      item.rotors.forEach((rotor, k) => { rotor.rotation.z = -(item.angle + k * .7); });
    }
    // The radiator fans are not monitored; they turn at a calm fixed speed
    radiatorFans.forEach(rotor => { rotor.rotation.z += dt * (live ? 1.6 : 0); });

    renderer.render(scene, camera);
    placeLabels();
  }

  let visible = true, last = performance.now();
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; }).observe(stage);
  function frame(now) {
    const dt = Math.min(.05, (now - last) / 1000);
    last = now;
    if (visible && !document.hidden && width) render(reducedMotion ? 0 : dt);
    requestAnimationFrame(frame);
  }

  resize();
  window.rigModel = {update};
  if (window.rigLive) update(window.rigLive);
  requestAnimationFrame(frame);
}
