#!/usr/bin/env python3
import argparse
import gzip
import hmac
import json
import math
import os
import platform
import re
import shutil
import socket
import sqlite3
import subprocess
import threading
import time
from glob import glob
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "history.db"
POWER_OFF_REQUEST = DATA_DIR / "poweroff.request"
FAN_STATE = DATA_DIR / "fan_state.json"
CONFIG_PATH = BASE_DIR / "config.json"

DEFAULT_CONFIG = {
    "host": "0.0.0.0",
    "port": 3000,
    # Shutting the machine down from the browser is off unless switched on
    # here (and the power-off units are installed, see install.sh)
    "power_off": {"enabled": False, "token": ""},
    # Labels printed on the parts of the 3D model; empty means unlabelled
    "rig": {"psu_name": "", "gpu_brand": "", "board_label": "", "radiator_label": ""},
}


def load_config(path=CONFIG_PATH):
    """config.json merged over the defaults, one level deep."""
    config = json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        user = json.loads(Path(path).read_text())
    except FileNotFoundError:
        return config
    for key, value in user.items():
        if isinstance(value, dict) and isinstance(config.get(key), dict):
            config[key].update(value)
        else:
            config[key] = value
    return config


def read_text(path, default=""):
    try:
        return Path(path).read_text().strip()
    except (OSError, ValueError):
        return default


def read_number(path, scale=1.0):
    try:
        return float(read_text(path)) / scale
    except (TypeError, ValueError):
        return None


def clamp(value, low=0.0, high=100.0):
    return max(low, min(high, value))


def run_lines(command, timeout=3):
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        return result.stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        return []


def bytes_value(value):
    try:
        return int(read_text(value))
    except (TypeError, ValueError):
        return 0


class Collector:
    def __init__(self, interval=2.0):
        self.interval = interval
        self.current = {}
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.previous_cpu = None
        self.core_usage = []
        self.previous_network = None
        self.previous_rapl = None
        self.last_store = 0
        self.last_cleanup = 0
        self.fan_stall = {}
        self.last_slow_update = 0
        self.slow_data = {"containers": [], "processes": [], "storage": []}
        self.gpu_names = self._gpu_names()
        self.cpu_model = self._cpu_model()
        self._init_db()

    def _connect(self):
        return sqlite3.connect(DB_PATH, timeout=10)

    def _init_db(self):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS metrics (
                    ts INTEGER PRIMARY KEY,
                    cpu_temp REAL,
                    gpu_edge REAL,
                    gpu_junction REAL,
                    gpu_memory REAL,
                    cpu_usage REAL,
                    gpu_usage REAL,
                    gpu_power REAL,
                    memory_usage REAL,
                    load1 REAL
                )
                """
            )
            columns = {row[1] for row in connection.execute("PRAGMA table_info(metrics)")}
            if "cpu_power" not in columns:
                connection.execute("ALTER TABLE metrics ADD COLUMN cpu_power REAL")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS gpu_metrics (
                    ts INTEGER,
                    gpu INTEGER,
                    edge REAL,
                    junction REAL,
                    memory REAL,
                    usage REAL,
                    power REAL,
                    fan_rpm REAL,
                    PRIMARY KEY (ts, gpu)
                )
                """
            )

    @staticmethod
    def _cpu_model():
        for line in read_text("/proc/cpuinfo").splitlines():
            if line.startswith("model name"):
                # "AMD Ryzen 9 5950X 16-Core Processor" -> "AMD Ryzen 9 5950X"
                name = line.split(":", 1)[1].strip()
                name = re.sub(r"\s+\d+-Core Processor$|\s+Processor$|\(R\)|\(TM\)|\s+CPU\s+@.*$", "", name)
                return re.sub(r"\s+", " ", name).strip()
        return platform.processor() or "CPU"

    def _gpu_names(self):
        names = {}
        pattern = re.compile(r"^(?P<pci>[0-9a-f:.]+).*?:\s+(?P<name>.+?)(?:\s+\[[0-9a-f]{4}:[0-9a-f]{4}\])?(?:\s+\(rev.*)?$")
        for line in run_lines(["lspci", "-Dnn"]):
            if "VGA compatible controller" not in line and "3D controller" not in line:
                continue
            match = pattern.match(line)
            if match:
                name = match.group("name").split(": ", 1)[-1]
                names[match.group("pci")] = name
        return names

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=5)

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.current))

    def history(self, minutes):
        cutoff = int(time.time()) - minutes * 60
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT ts, cpu_temp, gpu_edge, gpu_junction, gpu_memory,
                       cpu_usage, gpu_usage, gpu_power, memory_usage, load1, cpu_power
                FROM metrics WHERE ts >= ? ORDER BY ts
                """,
                (cutoff,),
            ).fetchall()
            gpu_rows = connection.execute(
                """
                SELECT ts, gpu, edge, junction, memory, usage, power, fan_rpm
                FROM gpu_metrics WHERE ts >= ? ORDER BY ts
                """,
                (cutoff,),
            ).fetchall()
        step = max(1, math.ceil(len(rows) / 1200))
        keys = [
            "ts",
            "cpu_temp",
            "gpu_edge",
            "gpu_junction",
            "gpu_memory",
            "cpu_usage",
            "gpu_usage",
            "gpu_power",
            "memory_usage",
            "load1",
            "cpu_power",
        ]
        points = [dict(zip(keys, row)) for row in rows[::step]]
        # Per-GPU values are merged into the same points as gpu<N>_<field>
        by_ts = {}
        for ts, gpu, *values in gpu_rows:
            by_ts.setdefault(ts, {}).update(
                {f"gpu{gpu}_{key}": value for key, value in zip(("edge", "junction", "memory", "usage", "power", "fan"), values)}
            )
        for point in points:
            point.update(by_ts.get(point["ts"], {}))
        return points

    def energy(self, since):
        """Integrate CPU package + GPU board power (Wh) since a timestamp.

        Gaps longer than 30 s (rig off, service stopped) are not bridged.
        """
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT SUM(watts * dt) / 3600.0, SUM(dt)
                FROM (
                    SELECT COALESCE(cpu_power, 0) + COALESCE(gpu_power, 0) AS watts,
                           MIN(ts - LAG(ts) OVER (ORDER BY ts), 30) AS dt
                    FROM metrics WHERE ts >= ?
                )
                WHERE dt IS NOT NULL
                """,
                (since,),
            ).fetchone()
        return {"wh": row[0] or 0.0, "seconds": row[1] or 0}

    def _loop(self):
        while not self.stop_event.is_set():
            started = time.monotonic()
            try:
                sample = self._collect()
                with self.lock:
                    self.current = sample
                now = time.time()
                if now - self.last_store >= 5:
                    self._store(sample)
                    self.last_store = now
            except Exception as error:
                with self.lock:
                    self.current = {
                        "timestamp": int(time.time()),
                        "hostname": socket.gethostname(),
                        "error": str(error),
                    }
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.2, self.interval - elapsed))

    def _store(self, sample):
        gpus = sample.get("gpus", [])

        def hottest(field):
            values = [gpu.get(field) for gpu in gpus if gpu.get(field) is not None]
            return max(values) if values else None

        values = (
            sample["timestamp"],
            sample["cpu"].get("temperature"),
            hottest("edge_temperature"),
            hottest("junction_temperature"),
            hottest("memory_temperature"),
            sample["cpu"].get("usage"),
            hottest("usage"),
            sum(gpu.get("power") or 0 for gpu in gpus) if gpus else None,
            sample["memory"].get("percent"),
            sample["cpu"]["load"][0],
            sample["cpu"].get("power"),
        )
        with self._connect() as connection:
            connection.execute(
                """
                INSERT OR REPLACE INTO metrics
                    (ts, cpu_temp, gpu_edge, gpu_junction, gpu_memory, cpu_usage,
                     gpu_usage, gpu_power, memory_usage, load1, cpu_power)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                values,
            )
            connection.executemany(
                "INSERT OR REPLACE INTO gpu_metrics VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (
                        sample["timestamp"], index,
                        gpu.get("edge_temperature"), gpu.get("junction_temperature"),
                        gpu.get("memory_temperature"), gpu.get("usage"),
                        gpu.get("power"), gpu.get("fan_rpm"),
                    )
                    for index, gpu in enumerate(gpus, start=1)
                ],
            )
            if sample["timestamp"] - self.last_cleanup >= 3600:
                self.last_cleanup = sample["timestamp"]
                for table in ("metrics", "gpu_metrics"):
                    connection.execute(
                        f"DELETE FROM {table} WHERE ts < ?",
                        (sample["timestamp"] - 7 * 86400,),
                    )

    def _cpu_usage(self):
        """Overall usage; per-thread usage is left in self.core_usage."""
        current = {}
        for line in read_text("/proc/stat").splitlines():
            if not line.startswith("cpu"):
                continue
            fields = line.split()
            values = [int(value) for value in fields[1:]]
            idle = values[3] + (values[4] if len(values) > 4 else 0)
            current[fields[0]] = (sum(values), idle)
        usage = {}
        for name, (total, idle) in current.items():
            previous = (self.previous_cpu or {}).get(name)
            if previous and total > previous[0]:
                usage[name] = clamp((1 - (idle - previous[1]) / (total - previous[0])) * 100)
        self.previous_cpu = current
        threads = sorted((name for name in usage if name != "cpu"), key=lambda name: int(name[3:]))
        self.core_usage = [round(usage[name], 1) for name in threads]
        return usage.get("cpu")

    def _cpu_power(self, timestamp):
        energy_path = Path("/sys/class/powercap/intel-rapl:0/energy_uj")
        try:
            energy = int(read_text(energy_path))
            limit = int(read_text(energy_path.with_name("max_energy_range_uj")))
        except (TypeError, ValueError):
            self.previous_rapl = None
            return None
        power = None
        if self.previous_rapl:
            previous_energy, previous_time = self.previous_rapl
            delta = energy - previous_energy
            elapsed = timestamp - previous_time
            if delta < 0 and limit:
                delta += limit
            if elapsed > 0 and delta >= 0:
                power = clamp(delta / 1_000_000 / elapsed, 0, 2000)
        self.previous_rapl = (energy, timestamp)
        return power

    def _memory(self):
        values = {}
        for line in read_text("/proc/meminfo").splitlines():
            key, raw = line.split(":", 1)
            values[key] = int(raw.strip().split()[0]) * 1024
        total = values.get("MemTotal", 0)
        available = values.get("MemAvailable", 0)
        swap_total = values.get("SwapTotal", 0)
        swap_free = values.get("SwapFree", 0)
        used = total - available
        return {
            "total": total,
            "used": used,
            "available": available,
            "percent": used / total * 100 if total else 0,
            "swap_total": swap_total,
            "swap_used": swap_total - swap_free,
        }

    def _network(self, timestamp):
        received = 0
        transmitted = 0
        interfaces = []
        for line in read_text("/proc/net/dev").splitlines()[2:]:
            name, raw = line.split(":", 1)
            name = name.strip()
            if name == "lo":
                continue
            fields = raw.split()
            rx = int(fields[0])
            tx = int(fields[8])
            if rx or tx:
                interfaces.append(name)
                received += rx
                transmitted += tx
        rx_rate = tx_rate = 0
        current = (timestamp, received, transmitted)
        if self.previous_network:
            delta = timestamp - self.previous_network[0]
            if delta > 0:
                rx_rate = max(0, (received - self.previous_network[1]) / delta)
                tx_rate = max(0, (transmitted - self.previous_network[2]) / delta)
        self.previous_network = current
        return {
            "interfaces": interfaces,
            "received": received,
            "transmitted": transmitted,
            "receive_rate": rx_rate,
            "transmit_rate": tx_rate,
        }

    def _temperatures_and_gpus(self):
        cpu_sensors = []
        cpu_package = None
        gpus = []
        for hwmon in sorted(glob("/sys/class/hwmon/hwmon*")):
            name = read_text(f"{hwmon}/name", "unknown")
            real_path = os.path.realpath(hwmon)
            if name == "coretemp":
                for source in sorted(glob(f"{hwmon}/temp*_input")):
                    stem = source[:-6]
                    label = read_text(f"{stem}_label", Path(stem).name)
                    value = read_number(source, 1000)
                    if value is None:
                        continue
                    cpu_sensors.append({"label": label, "temperature": value})
                    if label.lower().startswith("package"):
                        cpu_package = value
            elif name in ("k10temp", "zenpower"):
                amd_temperatures = {}
                for source in sorted(glob(f"{hwmon}/temp*_input")):
                    stem = source[:-6]
                    label = read_text(f"{stem}_label", Path(stem).name)
                    value = read_number(source, 1000)
                    if value is None:
                        continue
                    amd_temperatures[label.lower()] = value
                    cpu_sensors.append({"label": label, "temperature": value})
                # Ryzen 1000/2000 reports Tctl with an intentional fan-control
                # offset. Tdie is the physical die temperature when available.
                cpu_package = amd_temperatures.get(
                    "tdie",
                    amd_temperatures.get("tctl", max(amd_temperatures.values(), default=None)),
                )
            elif name == "amdgpu":
                device_path = os.path.realpath(f"{hwmon}/device")
                pci = os.path.basename(device_path)
                card = None
                for card_path in glob("/sys/class/drm/card[0-9]*"):
                    if os.path.realpath(f"{card_path}/device") == device_path:
                        card = card_path
                        break
                temperatures = {}
                fallbacks = {"temp1": "edge", "temp2": "junction", "temp3": "memory"}
                for source in sorted(glob(f"{hwmon}/temp*_input")):
                    stem = source[:-6]
                    sensor_id = Path(stem).name
                    label = read_text(f"{stem}_label", fallbacks.get(sensor_id, sensor_id)).lower()
                    temperatures[label] = read_number(source, 1000)
                links = []
                for node in [Path(device_path), *Path(device_path).parents]:
                    speed = read_text(node / "current_link_speed")
                    width = read_text(node / "current_link_width")
                    if not speed or not width:
                        continue
                    try:
                        score = float(speed.split()[0]) * int(width)
                    except (ValueError, IndexError):
                        score = float("inf")
                    links.append({"pci": node.name, "speed": speed, "width": width, "score": score})
                host_link = min(links, key=lambda link: link["score"]) if links else {}
                gpu = {
                    "pci": pci,
                    "card": Path(card).name if card else None,
                    "name": self.gpu_names.get(pci, "AMD GPU"),
                    "edge_temperature": temperatures.get("edge"),
                    "junction_temperature": temperatures.get("junction"),
                    "memory_temperature": temperatures.get("mem", temperatures.get("memory")),
                    "power": read_number(f"{hwmon}/power1_average", 1_000_000),
                    "power_cap": read_number(f"{hwmon}/power1_cap", 1_000_000),
                    "fan_rpm": read_number(f"{hwmon}/fan1_input"),
                    "fan_max_rpm": read_number(f"{hwmon}/fan1_max"),
                    "fan_manual": read_text(f"{hwmon}/pwm1_enable") == "1",
                    "fan_percent": (read_number(f"{hwmon}/pwm1") or 0) / 2.55,
                    "usage": read_number(f"{card}/device/gpu_busy_percent") if card else None,
                    "vram_total": bytes_value(f"{card}/device/mem_info_vram_total") if card else 0,
                    "vram_used": bytes_value(f"{card}/device/mem_info_vram_used") if card else 0,
                    "gtt_total": bytes_value(f"{card}/device/mem_info_gtt_total") if card else 0,
                    "gtt_used": bytes_value(f"{card}/device/mem_info_gtt_used") if card else 0,
                    "link_speed": read_text(f"{device_path}/current_link_speed"),
                    "link_width": read_text(f"{device_path}/current_link_width"),
                    "host_link_speed": host_link.get("speed"),
                    "host_link_width": host_link.get("width"),
                    "link_path": [{key: value for key, value in link.items() if key != "score"} for link in links],
                    "power_state": read_text(f"{device_path}/power/runtime_status"),
                }
                gpus.append(gpu)
        if cpu_package is None:
            for zone in glob("/sys/class/thermal/thermal_zone*"):
                if read_text(f"{zone}/type") == "x86_pkg_temp":
                    cpu_package = read_number(f"{zone}/temp", 1000)
                    break
        return cpu_package, cpu_sensors, gpus

    def _slow_metrics(self):
        containers = []
        for line in run_lines(["docker", "ps", "--format", "{{json .}}"]):
            try:
                item = json.loads(line)
                containers.append(
                    {
                        "name": item.get("Names", ""),
                        "image": item.get("Image", ""),
                        "status": item.get("Status", ""),
                    }
                )
            except json.JSONDecodeError:
                continue
        processes = []
        lines = run_lines(["ps", "-eo", "pid=,comm=,%cpu=,%mem=", "--sort=-%cpu"])
        for line in lines[:6]:
            fields = line.split(None, 3)
            if len(fields) == 4:
                processes.append(
                    {
                        "pid": int(fields[0]),
                        "name": fields[1],
                        "cpu": float(fields[2]),
                        "memory": float(fields[3]),
                    }
                )
        storage = []
        try:
            result = subprocess.run(
                [
                    "lsblk", "-J", "-b", "-o",
                    "NAME,PATH,TYPE,SIZE,MODEL,SERIAL,TRAN,FSTYPE,MOUNTPOINTS,ROTA",
                ],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            block_devices = json.loads(result.stdout).get("blockdevices", [])
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
            block_devices = []
        for device in block_devices:
            if device.get("type") != "disk":
                continue
            mountpoints = []
            filesystems = []
            usage_total = 0
            usage_used = 0
            seen_filesystems = set()
            pending = [device]
            while pending:
                item = pending.pop()
                pending.extend(item.get("children") or [])
                filesystem = item.get("fstype")
                if filesystem and filesystem not in filesystems:
                    filesystems.append(filesystem)
                for mountpoint in item.get("mountpoints") or []:
                    if not mountpoint:
                        continue
                    if mountpoint not in mountpoints:
                        mountpoints.append(mountpoint)
                    try:
                        filesystem_id = os.stat(mountpoint).st_dev
                        if filesystem_id in seen_filesystems:
                            continue
                        seen_filesystems.add(filesystem_id)
                        usage = shutil.disk_usage(mountpoint)
                        usage_total += usage.total
                        usage_used += usage.used
                    except OSError:
                        continue
            storage.append(
                {
                    "name": device.get("name"),
                    "path": device.get("path"),
                    "model": (device.get("model") or "Unknown drive").strip(),
                    "serial": device.get("serial"),
                    "transport": device.get("tran") or "unknown",
                    "size": device.get("size") or 0,
                    "rotational": bool(device.get("rota")),
                    "filesystems": filesystems,
                    "mountpoints": mountpoints,
                    "mounted": bool(mountpoints),
                    "system": "/" in mountpoints,
                    "used": usage_used,
                    "available": max(0, usage_total - usage_used),
                    "percent": usage_used / usage_total * 100 if usage_total else None,
                }
            )
        # System drive first, then the rest by device name
        storage.sort(key=lambda drive: (not drive["system"], drive["name"] or ""))
        return {"containers": containers, "processes": processes, "storage": storage}

    def _collect(self):
        timestamp = time.time()
        if timestamp - self.last_slow_update >= 10:
            self.slow_data = self._slow_metrics()
            self.last_slow_update = timestamp
        cpu_temp, cpu_sensors, gpus = self._temperatures_and_gpus()
        cpu_power = self._cpu_power(timestamp)
        memory = self._memory()
        disk = shutil.disk_usage("/")
        frequencies = []
        for line in read_text("/proc/cpuinfo").splitlines():
            if line.startswith("cpu MHz"):
                try:
                    frequencies.append(float(line.split(":", 1)[1]))
                except ValueError:
                    pass
        load = list(os.getloadavg())
        try:
            uptime = float(read_text("/proc/uptime").split()[0])
        except (IndexError, ValueError):
            uptime = 0
        sample = {
            "timestamp": int(timestamp),
            "hostname": socket.gethostname(),
            "kernel": os.uname().release,
            "uptime": uptime,
            "cpu": {
                "model": self.cpu_model,
                "usage": self._cpu_usage(),
                "cores": self.core_usage,
                "temperature": cpu_temp,
                "power": cpu_power,
                "sensors": cpu_sensors,
                "frequency_mhz": sum(frequencies) / len(frequencies) if frequencies else None,
                "load": load,
                "logical_cores": os.cpu_count(),
            },
            "memory": memory,
            "disk": {
                "total": disk.total,
                "used": disk.used,
                "free": disk.free,
                "percent": disk.used / disk.total * 100,
            },
            "network": self._network(timestamp),
            "gpus": gpus,
            "storage": self.slow_data["storage"],
            "containers": self.slow_data["containers"],
            "processes": self.slow_data["processes"],
            "fan_control": self._fan_control(),
        }
        sample["alerts"] = self._alerts(sample)
        return sample

    def _fan_control(self):
        try:
            state = json.loads(FAN_STATE.read_text())
        except (OSError, ValueError):
            return {"active": False}
        return {"active": time.time() - state.get("timestamp", 0) < 15, "start": state.get("start")}

    def _alerts(self, sample):
        alerts = []
        cpu_temp = sample["cpu"].get("temperature")
        if cpu_temp is not None and cpu_temp >= 85:
            alerts.append({"level": "critical" if cpu_temp >= 95 else "warning", "message": f"CPU-Temperatur {cpu_temp:.0f} °C"})
        if sample["memory"]["percent"] >= 90:
            alerts.append({"level": "warning", "message": "Arbeitsspeicher über 90 % belegt"})
        if sample["disk"]["percent"] >= 85:
            alerts.append({"level": "warning", "message": "Systemlaufwerk über 85 % belegt"})
        for index, gpu in enumerate(sample["gpus"], start=1):
            if gpu.get("power_state") == "error":
                alerts.append({"level": "warning", "message": f"GPU {index}: Sensor- oder Treiberfehler"})
            junction = gpu.get("junction_temperature")
            # A fan that should spin (hot, or commanded >= 30 %) but reports 0 RPM
            should_spin = (junction or 0) >= 75 or (gpu.get("fan_manual") and gpu.get("fan_percent", 0) >= 30)
            stalled = should_spin and gpu.get("fan_rpm") == 0
            self.fan_stall[gpu["pci"]] = self.fan_stall.get(gpu["pci"], 0) + 1 if stalled else 0
            if self.fan_stall[gpu["pci"]] >= 3:
                alerts.append({"level": "critical", "message": f"GPU {index}: Lüfter steht bei {junction or 0:.0f} °C"})
            if junction is not None and junction >= 95:
                alerts.append({"level": "critical" if junction >= 105 else "warning", "message": f"GPU {index} Hotspot {junction:.0f} °C"})
        return alerts


class Handler(BaseHTTPRequestHandler):
    collector = None
    config = DEFAULT_CONFIG

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/current":
            self._json(self.collector.snapshot())
            return
        if parsed.path == "/api/history":
            query = parse_qs(parsed.query)
            try:
                minutes = int(query.get("minutes", ["60"])[0])
            except ValueError:
                minutes = 60
            self._json({"minutes": minutes, "points": self.collector.history(max(1, min(minutes, 10080)))})
            return
        if parsed.path == "/api/energy":
            now = time.time()
            # The browser sends its local midnight; the rig itself runs on UTC
            try:
                midnight = int(parse_qs(parsed.query).get("today", [""])[0])
            except ValueError:
                midnight = int(now // 86400 * 86400)
            midnight = max(int(now - 86400), min(midnight, int(now)))
            self._json({
                "today": self.collector.energy(int(midnight)),
                "day": self.collector.energy(int(now - 86400)),
                "week": self.collector.energy(int(now - 7 * 86400)),
            })
            return
        if parsed.path == "/api/config":
            # What the page needs to know; the token itself never leaves the server
            power_off = self.config["power_off"]
            self._json({
                "rig": self.config["rig"],
                "power_off": {"enabled": bool(power_off.get("enabled")), "token_required": bool(power_off.get("token"))},
            })
            return
        if parsed.path == "/api/health":
            self._json({"status": "ok", "timestamp": int(time.time())})
            return
        files = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/app.css": ("app.css", "text/css; charset=utf-8"),
            "/app.js": ("app.js", "application/javascript; charset=utf-8"),
            "/dwarves.js": ("dwarves.js", "application/javascript; charset=utf-8"),
            "/rig3d.js": ("rig3d.js", "application/javascript; charset=utf-8"),
            "/vendor/three.module.min.js": ("vendor/three.module.min.js", "application/javascript; charset=utf-8"),
            "/favicon.svg": ("favicon.svg", "image/svg+xml"),
            "/favicon.png": ("favicon.png", "image/png"),
            "/favicon.ico": ("favicon.ico", "image/x-icon"),
            "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
        }
        target = files.get(parsed.path)
        if parsed.path == "/logo.png" and (DATA_DIR / "logo.png").is_file():
            # optional own logo next to the RW mark, kept out of the repository
            body = (DATA_DIR / "logo.png").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return
        if not target:
            self.send_error(404)
            return
        try:
            body = (STATIC_DIR / target[0]).read_bytes()
        except OSError:
            self.send_error(500)
            return
        compressed = len(body) > 20000 and "gzip" in self.headers.get("Accept-Encoding", "")
        if compressed:
            body = gzip.compress(body, compresslevel=6)
        self.send_response(200)
        self.send_header("Content-Type", target[1])
        self.send_header("Content-Length", str(len(body)))
        if compressed:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        # The vendored library never changes under the same name
        self.send_header("Cache-Control", "max-age=2592000, immutable" if target[0].startswith("vendor/") else "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/poweroff" or not self.config["power_off"].get("enabled"):
            self._json({"error": "Not found"}, status=404)
            return
        if not self.headers.get("Content-Type", "").startswith("application/json"):
            self._json({"error": "JSON required"}, status=415)
            return
        origin = self.headers.get("Origin")
        if not origin or urlparse(origin).netloc != self.headers.get("Host"):
            self._json({"error": "Origin not allowed"}, status=403)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 1024:
                raise ValueError
            payload = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._json({"error": "Invalid request"}, status=400)
            return
        if not isinstance(payload, dict) or payload.get("confirm") != "AUSSCHALTEN":
            self._json({"error": "Confirmation required"}, status=400)
            return
        token = str(self.config["power_off"].get("token") or "")
        if token and not hmac.compare_digest(str(payload.get("token", "")).encode(), token.encode()):
            time.sleep(1)
            self._json({"error": "Falsches Passwort"}, status=403)
            return

        timer = threading.Timer(1.0, POWER_OFF_REQUEST.touch)
        timer.daemon = True
        timer.start()
        self._json({"status": "poweroff_scheduled"}, status=202)

    def _json(self, payload, status=200):
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if args and str(args[1]) != "200":
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser(description="RigWatch hardware dashboard")
    parser.add_argument("--config", default=str(CONFIG_PATH), help="path to config.json")
    parser.add_argument("--host", help="overrides the config file")
    parser.add_argument("--port", type=int, help="overrides the config file")
    args = parser.parse_args()
    config = load_config(args.config)
    host = args.host or config["host"]
    port = args.port or int(config["port"])
    collector = Collector()
    Handler.collector = collector
    Handler.config = config
    server = ThreadingHTTPServer((host, port), Handler)
    collector.start()
    print(f"RigWatch listening on http://{host}:{port}", flush=True)
    if config["power_off"].get("enabled"):
        print("Power-off from the dashboard is enabled", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        collector.stop()


if __name__ == "__main__":
    main()
