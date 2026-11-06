#!/usr/bin/env python3
"""RigWatch fan curve for all amdgpu cards.

Below START_TEMP the firmware stays in charge (zero-RPM idle). Above it the
fans follow CURVE, driven by the hotter of junction and memory+8 °C. Fans
speed up immediately and slow down gradually. On exit, every card is handed
back to firmware control.
"""
import json
import signal
import time
from glob import glob
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
STATE_FILE = BASE_DIR / "data" / "fan_state.json"
INTERVAL = 2.0
MAX_STEP_DOWN = 3    # percent per interval


def load_curve(path=BASE_DIR / "config.json"):
    """Fan curve from the "fan_curve" section of config.json, if present."""
    curve = {
        "start": 50,     # take over at/above this drive temperature
        "release": 42,   # hand back to firmware at/below this
        # (drive temperature °C, fan percent). Tuned on RX 6600 cards that
        # reached 88-90 °C junction at ~65 % fan with a gentler curve.
        "points": [[50, 35], [65, 50], [75, 70], [82, 85], [88, 100]],
    }
    try:
        curve.update(json.loads(Path(path).read_text()).get("fan_curve", {}))
    except FileNotFoundError:
        pass
    points = sorted((float(t), max(0.0, min(100.0, float(p)))) for t, p in curve["points"])
    if len(points) < 2 or float(curve["release"]) >= float(curve["start"]):
        raise SystemExit("fan_curve: need at least two points and release below start")
    return float(curve["start"]), float(curve["release"]), points


START_TEMP, RELEASE_TEMP, CURVE = load_curve()


def read_int(path):
    try:
        return int(Path(path).read_text().strip())
    except (OSError, ValueError):
        return None


def write(path, value):
    try:
        Path(path).write_text(f"{value}\n")
        return True
    except OSError:
        return False


def curve_percent(temperature):
    if temperature <= CURVE[0][0]:
        return CURVE[0][1]
    for (t1, p1), (t2, p2) in zip(CURVE, CURVE[1:]):
        if temperature <= t2:
            return p1 + (p2 - p1) * (temperature - t1) / (t2 - t1)
    return 100


def cards():
    for hwmon in sorted(glob("/sys/class/hwmon/hwmon*")):
        if Path(hwmon, "name").read_text().strip() == "amdgpu" and Path(hwmon, "pwm1").exists():
            yield hwmon


class FanControl:
    def __init__(self):
        self.manual = {}   # hwmon -> current percent while under our control
        self.running = True

    def release(self, hwmon):
        write(f"{hwmon}/pwm1_enable", 2)
        self.manual.pop(hwmon, None)

    def release_all(self):
        for hwmon in cards():
            self.release(hwmon)

    def step(self):
        state = []
        for hwmon in cards():
            junction = read_int(f"{hwmon}/temp2_input")
            memory = read_int(f"{hwmon}/temp3_input")
            if junction is None:
                # Sensor gone: firmware protection is the safest fallback
                self.release(hwmon)
                state.append({"pci": Path(hwmon, "device").resolve().name, "mode": "auto", "percent": None})
                continue
            drive = max(junction / 1000, (memory or 0) / 1000 + 8)
            if hwmon in self.manual:
                if drive <= RELEASE_TEMP:
                    self.release(hwmon)
            elif drive >= START_TEMP:
                if write(f"{hwmon}/pwm1_enable", 1):
                    self.manual[hwmon] = 0
            if hwmon in self.manual:
                target = curve_percent(drive)
                percent = max(target, self.manual[hwmon] - MAX_STEP_DOWN)
                self.manual[hwmon] = percent
                if read_int(f"{hwmon}/pwm1_enable") != 1:
                    write(f"{hwmon}/pwm1_enable", 1)
                write(f"{hwmon}/pwm1", round(percent * 255 / 100))
            state.append({
                "pci": Path(hwmon, "device").resolve().name,
                "mode": "curve" if hwmon in self.manual else "auto",
                "percent": round(self.manual[hwmon]) if hwmon in self.manual else None,
                "drive_temperature": round(drive, 1),
            })
        try:
            STATE_FILE.write_text(json.dumps({"timestamp": int(time.time()), "start": START_TEMP, "gpus": state}))
        except OSError:
            pass

    def run(self):
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "running", False))
        signal.signal(signal.SIGINT, lambda *_: setattr(self, "running", False))
        try:
            while self.running:
                self.step()
                time.sleep(INTERVAL)
        finally:
            self.release_all()


if __name__ == "__main__":
    FanControl().run()
