# Rendern auf dem Rig (headless, per SSH)

Der Rig hat keine Desktop-App und keinen Monitor. Zwei Wege:

## Weg A: Renderer direkt auf dem Rig laufen lassen (einfachster Weg)

Per SSH auf den Rig, dann einmalig:

```bash
# Node 20+ (falls nicht vorhanden)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs ffmpeg
# Projektordner holen (ZIP, scp oder git clone)
cd ~/youtube-projekt/renderer
npm init -y >/dev/null && npm i playwright && npx playwright install --with-deps chromium
```

Rendern:

```bash
node render.js story-01-cant-lie.json out.mp4 --gpu
```

`--gpu` nutzt die Grafikkarte über EGL (Mesa/AMD). Falls das Bild schwarz
bleibt oder Chromium abbricht, `--gpu` weglassen: dann rendert die CPU,
mit den vielen Threads des Rigs trotzdem schnell. Fertige MP4 per `scp`
abholen oder in einen Drive-Sync-Ordner legen.

## Weg B: Claude Code auf dem Rig, damit Claude dort selbst arbeitet

Per SSH auf den Rig:

```bash
curl -fsSL https://claude.ai/install.sh | bash
cd ~/youtube-projekt
claude            # einmalig anmelden: Link im Terminal auf dem Handy öffnen
claude remote-control
```

Die Session erscheint danach in der Claude-Code-App auf Handy oder Web
und läuft auf dem Rig, mit vollem Zugriff auf GPU, Dateien und ffmpeg.
Diese Cloud-Session hier kann den Rig nicht erreichen: kein SSH-Client,
keine Schlüssel, und das Heimnetz ist von außen nicht sichtbar.
