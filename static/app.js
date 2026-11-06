const $ = (id) => document.getElementById(id);
let historyMinutes = 60;
let lastHistoryLoad = 0;
let historyPoints = [];
let lastSampleTs = 0;
let currentBusy = false;
let tipIndex = null;
let chartView = "temp";
let gpuTotal = 0;
let lastEnergyLoad = 0;
let energyData = null;
let alertLevel = "";

// Warning / critical thresholds in °C, matching the server-side alerts
const LIMITS = {cpu: [85, 95], edge: [85, 95], junction: [95, 105], memory: [90, 100]};
const CHART_MAX = 120;
const gpuColors = ["#26d6d0", "#b58cff", "#ffb627", "#62df88", "#ff4d3d", "#4d8dff"];
const VIEWS = {
  temp: {unit: "°", max: 120, steps: 6, hint: "GPU-Werte = jeweils heißeste Karte", series: () => [
    {key: "cpu_temp", label: "CPU", color: "#ff4d3d"},
    {key: "gpu_edge", label: "GPU Edge", color: "#26d6d0"},
    {key: "gpu_junction", label: "Hotspot", color: "#ffb627"},
    {key: "gpu_memory", label: "VRAM", color: "#b58cff"},
  ]},
  gpus: {unit: "°", max: 120, steps: 6, hint: "Hotspot jeder Karte · Daten ab Einführung dieser Ansicht", series: () =>
    Array.from({length: gpuTotal}, (_, index) => ({key: `gpu${index + 1}_junction`, label: `GPU ${index + 1}`, color: gpuColors[index % gpuColors.length]}))},
  load: {unit: "%", max: 100, steps: 5, hint: "GPU = am stärksten ausgelastete Karte", series: () => [
    {key: "cpu_usage", label: "CPU", color: "#ff4d3d"},
    {key: "gpu_usage", label: "GPU", color: "#26d6d0"},
    {key: "memory_usage", label: "RAM", color: "#ffb627"},
  ]},
  power: {unit: " W", max: null, steps: 5, hint: "GPU = alle Karten zusammen", series: () => [
    {key: "cpu_power", label: "CPU", color: "#ff4d3d"},
    {key: "gpu_power", label: "GPU gesamt", color: "#26d6d0"},
  ]},
};
const view = () => VIEWS[chartView];
const unitText = unit => unit === "°" ? " °C" : unit;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}

function finite(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatBytes(value, rate = false) {
  value = finite(value, 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}${rate ? "/s" : ""}`;
}

function duration(seconds) {
  seconds = Math.floor(finite(seconds, 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

function tempLevel(value, kind = "cpu") {
  if (value == null) return "off";
  const [warning, critical] = LIMITS[kind];
  if (value >= critical) return "hot";
  if (value >= warning) return "warn";
  return "";
}

function setState(id, value, kind) {
  const level = tempLevel(value, kind);
  const element = $(id);
  element.textContent = {off: "OFFLINE", hot: "KRITISCH", warn: "WARNUNG", "": "NORMAL"}[level];
  element.className = `state ${level}`;
}

function setBar(id, value) {
  $(id).style.width = `${Math.max(0, Math.min(100, finite(value, 0)))}%`;
}

// "Advanced Micro Devices, Inc. [AMD/ATI] Navi 23 [Radeon RX 6600/6600 XT/6600M]" -> "RX 6600"
function shortGpuName(name) {
  const text = String(name || "GPU");
  const brackets = [...text.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
  const model = brackets.reverse().find(part => /radeon|geforce|rtx|gtx|arc|rx\s/i.test(part));
  if (model) return model.split("/")[0].replace(/^(AMD\s+)?Radeon\s+/i, "").trim();
  return text.replace(/^Advanced Micro Devices, Inc\.\s*/, "").slice(0, 32);
}

function tempText(value) {
  return value != null && value > 0 ? `${value.toFixed(0)}°` : "--";
}

const DWARF_ACTIVE = 20;     // % thread load before a dwarf gets out of bed
const DWARF_TUNICS = ["#b5432f", "#3f7d4e", "#3c6aa8", "#8a5aa8", "#b7832f", "#2f8a8a"];
const DWARF_BEARDS = ["#d9944f", "#e8e2d6", "#8a5a33", "#c9a14a"];
const DWARF_SVG = (tunic, beard) => `<svg viewBox="0 0 40 40">
  <rect class="block" x="23" y="31" width="13" height="7" rx="1"/><ellipse class="block-top" cx="29.5" cy="31" rx="6.5" ry="1.4"/>
  <rect class="log" x="27" y="25" width="4.5" height="6" rx=".8"/>
  <g class="chips"><rect x="28" y="24" width="1.6" height="1.6"/><rect x="30.5" y="24.5" width="1.3" height="1.3"/></g>
  <rect class="boot" x="8" y="33" width="4" height="5" rx="1"/><rect class="boot" x="14" y="33" width="4" height="5" rx="1"/>
  <rect x="7" y="21" width="12" height="13" rx="3" fill="${tunic}"/>
  <rect class="belt" x="7" y="28" width="12" height="2"/><rect class="buckle" x="12" y="27.6" width="2.4" height="2.8"/>
  <circle class="face" cx="13" cy="16" r="5"/>
  <path class="helmet" d="M7.6 15.4a5.4 5.4 0 0 1 10.8 0z"/><rect class="helmet" x="7" y="14.6" width="12" height="1.4" rx=".7"/>
  <circle class="eye" cx="15.6" cy="16.6" r=".8"/><path class="eye-shut" d="M14.6 16.8h2"/>
  <circle class="nose" cx="18" cy="18" r="1.3"/>
  <path d="M8.5 17.5Q12 31 18.5 19.5Q14 21.5 8.5 17.5z" fill="${beard}"/>
  <g class="arm"><path class="handle" d="M13 22h13"/><circle class="face" cx="18.5" cy="22" r="1.7"/><path class="axe" d="M24.5 18.5l4.5-2v11l-4.5-2z"/></g>
  <path class="drop" d="M8 9q-1.2 1.8 0 2.6q1.2-.8 0-2.6z"/><path class="drop d2" d="M18.5 8.5q-1.2 1.8 0 2.6q1.2-.8 0-2.6z"/>
  <text class="zz" x="17" y="10">z</text><text class="zz z2" x="21" y="6">z</text>
</svg>`;

function renderDwarves(cores, threads) {
  const crew = $("dwarfCrew");
  const loads = (cores || []).map(value => finite(value, 0)).filter(value => value >= DWARF_ACTIVE).sort((a, b) => b - a);
  const sleeping = !loads.length;
  const wanted = sleeping ? [0] : loads;
  // The 3D crew (dwarves.js) takes over when WebGL is available
  window.rigDwarfState = {...window.rigDwarfState, loads};
  if (window.rigDwarves) window.rigDwarves.update(window.rigDwarfState);
  else while (crew.children.length < wanted.length) {
    const index = crew.children.length;
    const dwarf = document.createElement("span");
    dwarf.className = "dwarf";
    dwarf.style.setProperty("--offset", ((index * 0.37) % 1).toFixed(2));
    dwarf.innerHTML = DWARF_SVG(DWARF_TUNICS[index % DWARF_TUNICS.length], DWARF_BEARDS[(index * 3 + 1) % DWARF_BEARDS.length]);
    crew.appendChild(dwarf);
  }
  while (!window.rigDwarves && crew.children.length > wanted.length) crew.lastElementChild.remove();
  if (!window.rigDwarves) wanted.forEach((load, index) => {
    const dwarf = crew.children[index];
    // Busier thread, faster axe: 1.6 s per swing when barely awake, 0.45 s flat out
    const swing = (1.6 - Math.min(load, 100) / 100 * 1.15).toFixed(1) + "s";
    if (dwarf.style.getPropertyValue("--swing") !== swing) dwarf.style.setProperty("--swing", swing);
    const state = sleeping ? "dwarf sleep" : `dwarf${load >= 70 ? " sweat" : ""}${load >= 90 ? " strain" : ""}`;
    if (dwarf.className !== state) dwarf.className = state;
    dwarf.title = sleeping ? "Schläft" : `${load.toFixed(0)} % Last`;
  });
  const total = threads || (cores || []).length;
  const kwh = window.rigDwarfState.kwh;
  $("dwarfWood").textContent = window.rigDwarves && kwh != null ? ` · Holzstapel ${kwh.toLocaleString("de-DE", {maximumFractionDigits: 1})} kWh heute` : "";
  $("dwarfCaption").textContent = sleeping
    ? "Alle Zwerge schlafen"
    : loads.length === total
      ? `Alle ${total} Zwerge schuften!`
      : `${loads.length} von ${total} Zwergen ${loads.length === 1 ? "hackt" : "hacken"} Holz`;
}

function renderCcdLegend(sensors) {
  // Ryzen: one reading per core chiplet; Tctl follows the hotter one
  const ccds = (sensors || [])
    .filter(sensor => /^tccd\d+$/i.test(sensor.label) && finite(sensor.temperature) != null)
    .map(sensor => ({label: sensor.label.replace(/^tccd/i, "CCD"), value: finite(sensor.temperature)}));
  const legend = $("cpuCcdLegend");
  legend.classList.toggle("hidden", !ccds.length);
  if (!ccds.length) return;
  const hottest = Math.max(...ccds.map(ccd => ccd.value));
  const colors = {"": "var(--green)", warn: "var(--amber)", hot: "var(--red)"};
  legend.innerHTML = ccds.map(ccd => {
    const color = colors[tempLevel(ccd.value, "cpu")] || "var(--muted)";
    const hot = ccds.length > 1 && ccd.value === hottest ? " hot" : "";
    return `<span class="gpu-temp-chip${hot}" style="--chip-color:${color}">${escapeHtml(ccd.label)} ${ccd.value.toFixed(0)}°</span>`;
  }).join("");
}

function renderGpuGauge({gpus, field, kind, gaugeId, ringsId, valueId, legendId, labelId, stateId}) {
  const allReadings = gpus.map((gpu, index) => ({
    index,
    value: finite(gpu[field]),
    color: gpuColors[index % gpuColors.length],
  }));
  const readings = allReadings.filter(reading => reading.value != null && reading.value > 0);
  const chip = reading => reading.value == null || reading.value <= 0
    ? `<span class="gpu-temp-chip offline">G${reading.index + 1} · FEHLER</span>`
    : `<span class="gpu-temp-chip ${reading.index === hottest?.index ? "hot" : ""}" style="--chip-color:${reading.color}">G${reading.index + 1} ${reading.value.toFixed(0)}°</span>`;
  let hottest = null;
  if (!readings.length) {
    $(ringsId).innerHTML = "";
    $(valueId).textContent = "--";
    $(legendId).innerHTML = allReadings.map(chip).join("");
    $(labelId).textContent = kind === "junction" ? "JUNCTION" : "EDGE";
    setState(stateId, null, kind);
    return;
  }
  hottest = readings.reduce((current, reading) => reading.value > current.value ? reading : current);
  const maxTemperature = kind === "junction" ? 120 : 110;
  $(ringsId).innerHTML = readings.map((reading, ringIndex) => {
    const radius = Math.max(20, 46 - ringIndex * 5);
    const arc = Math.max(0, Math.min(75, reading.value / maxTemperature * 75));
    return `<circle class="gauge-track" cx="50" cy="50" r="${radius}" pathLength="100" stroke-dasharray="75 25"></circle>` +
      `<circle class="gauge-value" cx="50" cy="50" r="${radius}" pathLength="100" stroke="${reading.color}" stroke-dasharray="${arc} ${100 - arc}"></circle>`;
  }).join("");
  $(gaugeId).style.setProperty("--active-color", hottest.color);
  $(valueId).textContent = hottest.value.toFixed(0);
  $(labelId).textContent = `MAX: GPU ${hottest.index + 1}`;
  setState(stateId, hottest.value, kind);
  $(legendId).innerHTML = allReadings.map(chip).join("");
}

function fanTag(gpu) {
  if (gpu.fan_manual) return `<span class="fan-tag curve" title="RigWatch-Lüfterkurve aktiv">KURVE ${Math.round(gpu.fan_percent)}%</span>`;
  return `<span class="fan-tag" title="${gpu.fan_rpm ? "Firmware-Automatik" : "Zero-RPM: Lüfter stehen im Leerlauf, laufen ab ~60 °C an"}">${gpu.fan_rpm ? "AUTO" : "ZERO-RPM"}</span>`;
}

const FAN_BLADES = Array.from({length: 7}, (_, k) =>
  `<path transform="rotate(${(k * 360 / 7).toFixed(1)})" d="M3 -9C14 -16 30 -22 39 -12C31 -7 20 -2 9 3Z"/>`).join("");
const fanState = [];   // per GPU: {angle, rpm}

function fanSvg(gpuIndex, fanIndex) {
  const state = fanState[gpuIndex] || {angle: 0};
  return `<svg class="gpu-fan" viewBox="-50 -50 100 100" data-gpu="${gpuIndex}" data-fan="${fanIndex}">` +
    `<circle class="fan-ring" r="46"/><g class="fan-rotor" style="transform:rotate(${(state.angle + fanIndex * 23).toFixed(1)}deg)">${FAN_BLADES}<circle class="fan-hub" r="11"/><path class="fan-logo" d="M-5 -5L5 5M5 -5L-5 5"/></g></svg>`;
}

function spinFans(now) {
  const dt = Math.min(.1, (now - (spinFans.last || now)) / 1000);
  spinFans.last = now;
  fanState.forEach((state, gpu) => {
    // Shown at 1/10 of the real speed so the blades stay readable: 2400 rpm = 4 turns/s
    state.angle = (state.angle + (state.rpm || 0) / 600 * 360 * dt) % 360;
  });
  if (!document.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.querySelectorAll(".gpu-fan").forEach(fan => {
      const state = fanState[fan.dataset.gpu];
      if (state) fan.firstElementChild.nextElementSibling.style.transform = `rotate(${(state.angle + fan.dataset.fan * 23).toFixed(1)}deg)`;
    });
  }
  requestAnimationFrame(spinFans);
}
requestAnimationFrame(spinFans);

function renderGpuCards(gpus) {
  gpus.forEach((gpu, index) => {
    fanState[index] = {angle: fanState[index]?.angle || 0, rpm: finite(gpu.fan_rpm, 0)};
  });
  if (!gpus.length) {
    $("gpuList").innerHTML = '<div class="empty">Keine GPU erkannt</div>';
    return;
  }
  $("gpuList").innerHTML = gpus.map((gpu, index) => {
    const usage = finite(gpu.usage);
    const failed = usage == null || gpu.power_state === "error";
    const temp = (label, value, kind) =>
      `<div><small>${label}</small><strong class="${value != null ? tempLevel(value, kind) : ""}">${tempText(value)}</strong></div>`;
    const vramPercent = gpu.vram_total ? gpu.vram_used / gpu.vram_total * 100 : 0;
    const power = finite(gpu.power);
    const cap = finite(gpu.power_cap);
    const powerPercent = power != null && cap ? power / cap * 100 : 0;
    const slowLink = gpu.host_link_speed && gpu.link_speed && gpu.host_link_speed !== gpu.link_speed;
    return `<article class="gpu-card ${failed ? "error" : ""}" style="--gpu-color:${gpuColors[index % gpuColors.length]}">` +
      `<header><h3>GPU ${index + 1} · ${escapeHtml(shortGpuName(gpu.name))}</h3><span>${escapeHtml(gpu.pci)}</span></header>` +
      `<div class="gpu-shroud ${gpu.fan_rpm > 0 ? "spinning" : ""} ${tempLevel(finite(gpu.junction_temperature), "junction")}">${fanSvg(index, 0)}${fanSvg(index, 1)}${fanSvg(index, 2)}` +
      `<div class="shroud-readout"><strong>${gpu.fan_rpm != null ? gpu.fan_rpm.toFixed(0) : "--"}</strong> <small>RPM${gpu.fan_rpm === 0 ? " · STEHT" : ""}</small></div></div>` +
      `<div class="gpu-temps">${temp("EDGE", gpu.edge_temperature, "edge")}${temp("HOTSPOT", gpu.junction_temperature, "junction")}${temp("VRAM", gpu.memory_temperature, "memory")}</div>` +
      `<div class="load-row ${failed ? "sensor-error" : ""}"><span>LAST</span><div class="bar"><i style="width:${failed ? 0 : Math.min(100, usage)}%"></i></div><strong>${failed ? "FEHLER" : usage.toFixed(0) + "%"}</strong></div>` +
      `<div class="load-row"><span>POWER</span><div class="bar"><i style="width:${Math.min(100, powerPercent)}%;background:var(--amber)"></i></div><strong>${power != null ? power.toFixed(0) + " W" : "--"}</strong></div>` +
      `<div class="load-row"><span>VRAM</span><div class="bar"><i style="width:${Math.min(100, vramPercent)}%;background:var(--violet)"></i></div><strong>${gpu.vram_total ? vramPercent.toFixed(0) + "%" : "--"}</strong></div>` +
      `<div class="gpu-facts">` +
      `<div><small>VRAM</small><b>${gpu.vram_total ? formatBytes(gpu.vram_used) + " / " + formatBytes(gpu.vram_total) : "--"}</b></div>` +
      `<div><small>LÜFTER</small><b>${gpu.fan_rpm != null ? gpu.fan_rpm.toFixed(0) + " RPM" : "--"}${fanTag(gpu)}</b></div>` +
      `<div><small>PCIe HOST LINK</small><b class="${slowLink ? "warn" : ""}" title="GPU: ${escapeHtml(gpu.link_speed)} × ${escapeHtml(gpu.link_width)}">${gpu.host_link_speed ? escapeHtml(gpu.host_link_speed.replace(" PCIe", "")) + " × " + escapeHtml(gpu.host_link_width) : "--"}</b></div>` +
      `<div><small>STATUS</small><b>${escapeHtml((gpu.power_state || "--").toUpperCase())}${cap ? " · " + cap.toFixed(0) + " W CAP" : ""}</b></div>` +
      `</div></article>`;
  }).join("");
}

function setConnection(state) {
  const labels = {live: "LIVE", stale: "VERALTET", offline: "OFFLINE", shutdown: "SHUTDOWN"};
  $("connectionState").textContent = labels[state];
  $("connectionState").parentElement.className = `status-line ${state === "live" ? "" : state === "stale" ? "stale" : "offline"}`;
  document.querySelector(".live-dot").className = `live-dot ${state === "live" ? "online" : state === "stale" ? "" : "offline"}`;
}

function renderCurrent(data) {
  if (!data || data.error || !data.cpu) throw new Error(data?.error || "Keine Sensordaten");
  const cpu = data.cpu;
  const gpus = data.gpus || [];
  const cpuTemp = finite(cpu.temperature);
  const cpuUsage = finite(cpu.usage, 0);
  lastSampleTs = data.timestamp;
  if (gpus.length !== gpuTotal) {
    gpuTotal = gpus.length;
    if (chartView === "gpus") { renderLegend(); drawChart(); }
  }

  $("hostname").textContent = data.hostname;
  document.title = `RigWatch | ${data.hostname}`;
  $("kernel").textContent = `Kernel ${data.kernel}`;
  $("cpuTemp").textContent = cpuTemp?.toFixed(0) ?? "--";
  setState("cpuState", cpuTemp, "cpu");
  if (cpu.model) {
    // "AMD Ryzen 9 5950X" -> "RYZEN 9 5950X" fits the tile
    $("cpuModel").textContent = cpu.model.replace(/^(AMD|Intel)\s+/i, "").toUpperCase();
    $("cpuModel").title = cpu.model;
  }
  renderCcdLegend(cpu.sensors);
  $("cpuGauge").style.setProperty("--value", Math.max(0, Math.min(100, finite(cpuTemp, 0) / 110 * 100)));
  $("cpuGauge").className = `gauge ${tempLevel(cpuTemp, "cpu")}`;
  renderGpuGauge({gpus, field: "edge_temperature", kind: "edge", gaugeId: "gpuGauge", ringsId: "gpuEdgeRings", valueId: "gpuTemp", legendId: "gpuEdgeLegend", labelId: "gpuEdgeHotLabel", stateId: "gpuState"});
  renderGpuGauge({gpus, field: "junction_temperature", kind: "junction", gaugeId: "hotspotGauge", ringsId: "gpuHotspotRings", valueId: "hotspotTemp", legendId: "gpuHotspotLegend", labelId: "gpuHotspotHotLabel", stateId: "hotspotState"});

  $("cpuLoad").textContent = `${cpuUsage.toFixed(0)}%`;
  $("ramLoad").textContent = `${data.memory.percent.toFixed(0)}%`;
  setBar("cpuLoadBar", cpuUsage);
  renderDwarves(cpu.cores, cpu.logical_cores);
  setBar("ramLoadBar", data.memory.percent);
  $("gpuLoadRows").innerHTML = gpus.length ? gpus.map((item, index) => {
    const usage = finite(item.usage);
    const failed = usage == null || item.power_state === "error";
    return `<div class="load-row ${failed ? "sensor-error" : ""}" title="${escapeHtml(item.name)} · ${escapeHtml(item.pci)}"><span>GPU${index + 1}</span><div class="bar"><i style="width:${failed ? 0 : Math.max(0, Math.min(100, usage))}%;background:${gpuColors[index % gpuColors.length]}"></i></div><strong>${failed ? "FEHLER" : usage.toFixed(0) + "%"}</strong></div>`;
  }).join("") : '<div class="load-row"><span>GPU</span><div class="bar"><i></i></div><strong>--%</strong></div>';
  const gpuPower = gpus.reduce((total, item) => total + finite(item.power, 0), 0);
  const gpuPowerCap = gpus.reduce((total, item) => total + finite(item.power_cap, 0), 0);
  $("cpuPower").textContent = cpu.power != null ? `${cpu.power.toFixed(0)} W` : "-- W";
  $("gpuPower").textContent = gpus.length ? `${gpuPower.toFixed(0)} W` : "-- W";
  $("gpuPowerCap").textContent = gpuPowerCap ? `von ${gpuPowerCap.toFixed(0)} W` : "";

  $("memoryUsed").textContent = `${data.memory.percent.toFixed(0)}%`;
  $("memoryDetail").textContent = `${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`;
  $("diskUsed").textContent = `${data.disk.percent.toFixed(0)}%`;
  $("diskDetail").textContent = `${formatBytes(data.disk.used)} / ${formatBytes(data.disk.total)}`;
  $("loadAverage").textContent = cpu.load.map(x => x.toFixed(1)).join(" / ");
  $("coreCount").textContent = `${cpu.logical_cores} Threads`;
  $("cpuClock").textContent = cpu.frequency_mhz ? `${(cpu.frequency_mhz / 1000).toFixed(2)} GHz` : "--";
  $("uptime").textContent = `Uptime ${duration(data.uptime)}`;
  $("networkDown").textContent = formatBytes(data.network.receive_rate, true);
  $("networkUp").textContent = formatBytes(data.network.transmit_rate, true);
  $("networkInterfaces").textContent = data.network.interfaces.join(", ") || "Keine Schnittstelle";

  renderGpuCards(gpus);
  window.rigLive = data;
  window.rigModel?.update(data);
  const fanControl = data.fan_control || {};
  $("gpuCount").textContent = `${gpus.length} ERKANNT · LÜFTERKURVE ${fanControl.active ? "AKTIV" : "AUS"}`;
  $("energyNow").textContent = `${(finite(cpu.power, 0) + gpuPower).toFixed(0)} W`;
  $("energyNowDetail").textContent = `CPU ${finite(cpu.power, 0).toFixed(0)} W · GPU ${gpuPower.toFixed(0)} W`;

  const sensors = [
    ...(cpu.sensors || []).map(sensor => ({...sensor, group: "CPU", kind: "cpu"})),
    ...gpus.flatMap((item, index) => [
      ["Edge", item.edge_temperature, "edge"],
      ["Hotspot", item.junction_temperature, "junction"],
      ["VRAM", item.memory_temperature, "memory"],
    ].filter(([, value]) => value != null).map(([label, temperature, kind]) => ({label, temperature, kind, group: `GPU ${index + 1}`}))),
  ];
  $("sensorList").innerHTML = sensors.length ? sensors.map(sensor =>
    `<div class="sensor-item ${tempLevel(sensor.temperature, sensor.kind)}" style="--temp:${Math.min(100, sensor.temperature / CHART_MAX * 100)}%"><span>${escapeHtml(sensor.group)} · ${escapeHtml(sensor.label)}</span><i></i><strong>${sensor.temperature.toFixed(0)}°</strong></div>`
  ).join("") : '<div class="empty">Keine Temperatursensoren erkannt</div>';

  const storage = data.storage || [];
  $("storageCount").textContent = `${storage.length} ERKANNT`;
  $("storageList").innerHTML = storage.length ? storage.map(drive => {
    const kind = drive.rotational ? "HDD" : "SSD";
    const status = drive.system ? "SYSTEM" : drive.mounted ? "EINGEHÄNGT" : "NICHT EINGEHÄNGT";
    const cls = drive.system ? "system-disk" : drive.mounted ? "" : "offline-disk";
    const level = drive.percent >= 95 ? "hot" : drive.percent >= 85 ? "warn" : "";
    const usage = drive.percent != null
      ? `<div class="storage-usage"><strong>${drive.percent.toFixed(0)}% belegt</strong><small>${formatBytes(drive.used)} / ${formatBytes(drive.used + drive.available)}</small><div class="bar"><i class="${level}" style="width:${Math.min(100, drive.percent)}%"></i></div></div>`
      : `<div class="storage-usage"><strong>${formatBytes(drive.size)}</strong><small>Nicht eingehängt</small><div class="bar"><i style="width:0"></i></div></div>`;
    const filesystems = (drive.filesystems || []).join(", ") || "ohne Dateisystem";
    const mounts = (drive.mountpoints || []).join(", ") || "nicht eingehängt";
    return `<article class="storage-item ${cls}"><header><h3>${escapeHtml(drive.model)}</h3><span>${escapeHtml(status)}</span></header>` +
      `<div class="storage-meta">${escapeHtml(drive.path)} · ${kind} · ${escapeHtml(drive.transport)} · ${formatBytes(drive.size)}</div>` +
      usage + `<div class="storage-mount">${escapeHtml(filesystems)} · ${escapeHtml(mounts)}</div></article>`;
  }).join("") : '<div class="empty">Keine physischen Laufwerke erkannt</div>';

  const processes = data.processes || [];
  $("processList").innerHTML = '<div class="table-row header"><span>PID</span><span>PROZESS</span><span>CPU</span><span>RAM</span></div>' + processes.map(process =>
    `<div class="table-row"><span>${process.pid}</span><span title="${escapeHtml(process.name)}">${escapeHtml(process.name)}</span><span>${process.cpu.toFixed(1)}%</span><span>${process.memory.toFixed(1)}%</span></div>`
  ).join("");

  const containers = data.containers || [];
  $("containerCount").textContent = `${containers.length} AKTIV`;
  $("containerList").innerHTML = containers.length ? containers.map(container =>
    `<div class="container-item"><strong>${escapeHtml(container.name)}</strong><span>${escapeHtml(container.image)}</span><span>${escapeHtml(container.status)}</span></div>`
  ).join("") : '<div class="empty">Keine aktiven Container</div>';

  const alerts = data.alerts || [];
  const strip = $("alertStrip");
  strip.classList.toggle("hidden", alerts.length === 0);
  strip.classList.toggle("warning", alerts.length > 0 && alerts.every(alert => alert.level !== "critical"));
  strip.textContent = alerts.map(alert => `⚠ ${alert.message}`).join("  ·  ");
  setAlertIndicator(alerts.some(alert => alert.level === "critical") ? "critical" : alerts.length ? "warning" : "", data);
  $("lastUpdate").textContent = `Update ${new Date(data.timestamp * 1000).toLocaleTimeString("de-DE")}`;
  setConnection(Date.now() / 1000 - data.timestamp > 15 ? "stale" : "live");
}

// Tab title + favicon turn amber/red while alerts are active, visible from other tabs too
const baseIcon = document.querySelector('link[rel="icon"][type="image/svg+xml"]').href;
function alertIcon(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${color}"/><text x="32" y="46" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="42" fill="#080b0f">!</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
function setAlertIndicator(level, data) {
  const hottest = Math.max(finite(data.cpu.temperature, 0), ...(data.gpus || []).map(gpu => finite(gpu.junction_temperature, 0)));
  document.title = level ? `${level === "critical" ? "🔴" : "🟠"} ${hottest.toFixed(0)}° · RigWatch` : `RigWatch | ${data.hostname}`;
  if (level === alertLevel) return;
  alertLevel = level;
  document.querySelector('link[rel="icon"][type="image/svg+xml"]').href = level ? alertIcon(level === "critical" ? "#ff4d3d" : "#ffb627") : baseIcon;
}

function renderLegend() {
  $("chartLegend").innerHTML = view().series().map(({label, color}) => `<span style="color:${color}">${escapeHtml(label)}</span>`).join("");
  $("chartHint").textContent = view().hint;
}

function formatEnergy(entry, price) {
  const kwh = entry.wh / 1000;
  return [`${kwh < 10 ? kwh.toFixed(2) : kwh.toFixed(1)} kWh`, `≈ ${(kwh * price).toFixed(2).replace(".", ",")} € · ${(entry.seconds / 3600).toFixed(1)} h erfasst`];
}

function energyPrice() {
  return Math.max(0, finite($("energyPrice").value, 0.30));
}

function renderEnergy() {
  if (!energyData) return;
  const todayWh = finite(energyData.today?.wh);
  if (todayWh != null) {
    window.rigDwarfState = {...window.rigDwarfState, kwh: todayWh / 1000};
    window.rigDwarves?.update(window.rigDwarfState);
  }
  for (const [key, id] of [["today", "energyToday"], ["day", "energyDay"], ["week", "energyWeek"]]) {
    const [value, cost] = formatEnergy(energyData[key], energyPrice());
    $(id).textContent = value;
    $(`${id}Cost`).textContent = cost;
  }
}

async function loadEnergy() {
  if (document.hidden) return;
  try {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const response = await fetch(`/api/energy?today=${Math.floor(midnight / 1000)}`, {cache: "no-store"});
    energyData = await response.json();
    lastEnergyLoad = Date.now();
    renderEnergy();
  } catch (_) {}
}

function chartGeometry(canvas) {
  const box = canvas.getBoundingClientRect();
  const pad = {left: 44, right: 10, top: 12, bottom: 24};
  return {box, pad, plotW: box.width - pad.left - pad.right, plotH: box.height - pad.top - pad.bottom};
}

function timeLabel(ts, withDate) {
  const options = withDate ? {weekday: "short", hour: "2-digit", minute: "2-digit"} : {hour: "2-digit", minute: "2-digit"};
  return new Date(ts * 1000).toLocaleString("de-DE", options);
}

function drawChart() {
  const canvas = $("temperatureChart");
  const points = historyPoints;
  const ratio = window.devicePixelRatio || 1;
  const {box, pad, plotW, plotH} = chartGeometry(canvas);
  canvas.width = Math.max(1, box.width * ratio);
  canvas.height = Math.max(1, box.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const width = box.width, height = box.height;
  ctx.clearRect(0, 0, width, height);
  ctx.font = "11px monospace";
  ctx.lineWidth = 1;
  const {unit, steps} = view();
  const series = view().series();
  const chartMax = view().max ?? Math.max(100, Math.ceil(Math.max(0, ...points.flatMap(point => series.map(({key}) => finite(point[key], 0)))) / 100) * 100);
  for (let i = 0; i <= steps; i++) {
    const value = Math.round(chartMax - i * chartMax / steps);
    const y = pad.top + plotH * i / steps;
    ctx.strokeStyle = "#263039";
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
    ctx.fillStyle = "#8d99a3";
    ctx.fillText(`${value}${unit.trim()}`, 2, y + 4);
  }
  if (!points.length) {
    ctx.fillText("Noch keine Verlaufsdaten", pad.left + 10, pad.top + 30);
    return;
  }
  const first = points[0].ts, last = points[points.length - 1].ts;
  const span = Math.max(1, last - first);
  const xOf = ts => pad.left + (ts - first) / span * plotW;
  const yOf = value => pad.top + (1 - Math.max(0, Math.min(chartMax, value)) / chartMax) * plotH;
  // A gap longer than 4 sample periods (e.g. rig was off) breaks the line
  const gap = Math.max(30, span / points.length * 4);
  for (const {key, color} of series) {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.lineJoin = "round";
    let previous = null;
    for (const point of points) {
      const value = finite(point[key]);
      if (value == null) { previous = null; continue; }
      const x = xOf(point.ts), y = yOf(value);
      if (previous == null || point.ts - previous > gap) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      previous = point.ts;
    }
    ctx.stroke();
  }
  ctx.fillStyle = "#8d99a3";
  const withDate = span > 20 * 3600;
  ctx.fillText(timeLabel(first, withDate), pad.left, height - 6);
  ctx.textAlign = "right"; ctx.fillText(timeLabel(last, withDate), width - pad.right, height - 6); ctx.textAlign = "left";

  if (tipIndex != null && points[tipIndex]) {
    const point = points[tipIndex];
    const x = xOf(point.ts);
    ctx.strokeStyle = "rgba(233,238,242,.45)"; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke(); ctx.setLineDash([]);
    for (const {key, color} of series) {
      const value = finite(point[key]);
      if (value == null) continue;
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, yOf(value), 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function showTip(clientX) {
  const canvas = $("temperatureChart");
  if (!historyPoints.length) return;
  const {box, pad, plotW} = chartGeometry(canvas);
  const first = historyPoints[0].ts, last = historyPoints[historyPoints.length - 1].ts;
  const ts = first + Math.max(0, Math.min(1, (clientX - box.left - pad.left) / plotW)) * (last - first);
  let best = 0;
  for (let i = 1; i < historyPoints.length; i++) {
    if (Math.abs(historyPoints[i].ts - ts) < Math.abs(historyPoints[best].ts - ts)) best = i;
  }
  tipIndex = best;
  const point = historyPoints[best];
  const tip = $("chartTip");
  tip.innerHTML = `<b>${new Date(point.ts * 1000).toLocaleString("de-DE", {weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit"})}</b>` +
    view().series().map(({key, label, color}) => `<span style="color:${color}">${label}</span> ${finite(point[key]) != null ? point[key].toFixed(0) + unitText(view().unit) : "--"}`).join("<br>");
  tip.classList.remove("hidden");
  const x = pad.left + (point.ts - first) / Math.max(1, last - first) * plotW;
  const tipWidth = tip.offsetWidth;
  tip.style.left = `${x + 12 + tipWidth > box.width ? Math.max(0, x - 12 - tipWidth) : x + 12}px`;
  drawChart();
}

function hideTip() {
  tipIndex = null;
  $("chartTip").classList.add("hidden");
  drawChart();
}

async function loadCurrent() {
  if (currentBusy || document.hidden) return;
  currentBusy = true;
  try {
    const response = await fetch("/api/current", {cache: "no-store"});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderCurrent(await response.json());
  } catch (error) {
    if ($("connectionState").textContent !== "SHUTDOWN") setConnection("offline");
  } finally {
    currentBusy = false;
  }
}

async function loadHistory() {
  if (document.hidden) return;
  try {
    const response = await fetch(`/api/history?minutes=${historyMinutes}`, {cache: "no-store"});
    const data = await response.json();
    historyPoints = data.points || [];
    lastHistoryLoad = Date.now();
    if (tipIndex != null && tipIndex >= historyPoints.length) hideTip();
    drawChart();
  } catch (_) {}
}

document.querySelectorAll("#rangeSwitch button").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll("#rangeSwitch button").forEach(item => item.classList.toggle("active", item === button));
  historyMinutes = Number(button.dataset.minutes);
  tipIndex = null;
  $("chartTip").classList.add("hidden");
  loadHistory();
}));

document.querySelectorAll("#viewSwitch button").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll("#viewSwitch button").forEach(item => item.classList.toggle("active", item === button));
  chartView = button.dataset.view;
  try { localStorage.setItem("rigwatch.view", chartView); } catch (_) {}
  hideTip();
  renderLegend();
  drawChart();
}));

try {
  const savedView = localStorage.getItem("rigwatch.view");
  if (VIEWS[savedView]) {
    chartView = savedView;
    document.querySelectorAll("#viewSwitch button").forEach(item => item.classList.toggle("active", item.dataset.view === savedView));
  }
  const savedPrice = localStorage.getItem("rigwatch.price");
  if (savedPrice) $("energyPrice").value = savedPrice;
} catch (_) {}
$("energyPrice").addEventListener("input", () => {
  try { localStorage.setItem("rigwatch.price", $("energyPrice").value); } catch (_) {}
  renderEnergy();
});

const chartWrap = $("chartWrap");
chartWrap.addEventListener("pointerdown", event => showTip(event.clientX));
chartWrap.addEventListener("pointermove", event => { if (event.pointerType === "mouse" || tipIndex != null) showTip(event.clientX); });
chartWrap.addEventListener("pointerleave", event => { if (event.pointerType === "mouse") hideTip(); });
document.addEventListener("pointerdown", event => { if (tipIndex != null && !chartWrap.contains(event.target)) hideTip(); });

// Shutdown controls only appear when enabled in config.json
let powerTokenRequired = false;
fetch("/api/config", {cache: "no-store"}).then(response => response.json()).then(config => {
  $("powerPanel").classList.toggle("hidden", !config.power_off?.enabled);
  powerTokenRequired = !!config.power_off?.token_required;
  $("powerTokenField").classList.toggle("hidden", !powerTokenRequired);
}).catch(() => {});

$("powerButton").addEventListener("click", () => {
  $("powerError").classList.add("hidden");
  $("powerToken").value = "";
  $("powerDialog").showModal();
  (powerTokenRequired ? $("powerToken") : $("powerCancel")).focus();
});
$("powerCancel").addEventListener("click", () => $("powerDialog").close());

$("powerForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("powerConfirm");
  button.disabled = true;
  button.textContent = "FÄHRT HERUNTER…";
  $("powerError").classList.add("hidden");
  try {
    const response = await fetch("/api/poweroff", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({confirm: "AUSSCHALTEN", token: $("powerToken").value}),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    $("powerDialog").close();
    $("powerButton").textContent = "RIG FÄHRT HERUNTER";
    $("powerButton").disabled = true;
    setConnection("shutdown");
  } catch (error) {
    $("powerError").textContent = `Herunterfahren fehlgeschlagen: ${error.message}`;
    $("powerError").classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = "JA, HERUNTERFAHREN";
  }
});

function tickClock() {
  $("clock").textContent = new Date().toLocaleTimeString("de-DE", {hour: "2-digit", minute: "2-digit"});
  if (lastSampleTs && Date.now() / 1000 - lastSampleTs > 15 && $("connectionState").textContent === "LIVE") setConnection("stale");
}

let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawChart, 120); });
// Pause polling in background tabs (saves battery on phones), refresh at once when visible again
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { loadCurrent(); loadHistory(); loadEnergy(); }
});

setInterval(tickClock, 1000);
setInterval(loadCurrent, 2000);
setInterval(() => { if (Date.now() - lastHistoryLoad > (historyMinutes <= 60 ? 15000 : 60000)) loadHistory(); }, 5000);
setInterval(() => { if (Date.now() - lastEnergyLoad > 60000) loadEnergy(); }, 10000);
tickClock();
renderLegend();
loadCurrent();
loadHistory();
loadEnergy();
