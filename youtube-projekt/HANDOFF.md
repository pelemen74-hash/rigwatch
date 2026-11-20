# Übergabe an die Session auf dem Rig

Stand: 2026-11-20. Vorherige Arbeit lief in einer Claude-Cloud-Session
ohne GPU, ohne GitHub-Push und ohne OpenArt.

## Ziel

YouTube Shorts (9:16, 45–60 s) im Stil der "In this world …"-Roblox-Stories,
komplett lokal gerendert. Kein OpenArt, keine Credits. Vorbild war ein
TikTok von philsidehustles (Claude + OpenArt + Roblox-Look).

## Was existiert (alles im Ordner `youtube-projekt/`)

| Datei                              | Zweck                                                                 |
|------------------------------------|-----------------------------------------------------------------------|
| `renderer/render.js`               | Node-Skript. Skript-JSON → MP4 über headless Chromium (Playwright) + ffmpeg. Optionen `--fps`, `--scale`, `--gpu`. |
| `renderer/scene.html`              | Three.js-Szene. Blockige Figuren (Kopf, Torso, Arme, Beine), 6 Gesichtsausdrücke als Canvas-Texturen, 11 Posen, 6 Umgebungen, 6 Kamera-Presets, Captions mit Pop-Animation, Kamerawackeln, Blitz beim Schnitt. |
| `renderer/three.module.min.js`     | Three.js, kopiert aus `static/vendor/` von RigWatch.                   |
| `renderer/story-01-cant-lie.json`  | Beispielskript, 17 Szenen, 43,5 s. Idee 1 aus IDEEN.md.                |
| `renderer/story-01-cant-lie.mp4`   | Fertiger Render 1080×1920, 30 fps.                                     |
| `README.md`                        | Workflow, Skript-Format, erlaubte Werte.                               |
| `PROMPT.md`                        | Prompt, mit dem Claude neue Skript-JSONs schreibt.                     |
| `IDEEN.md`                         | 30 Story-Regeln mit Twist.                                             |
| `CHECKLISTE.md`                    | Produktions- und Upload-Checkliste.                                    |
| `RIG.md`                           | Setup auf dem headless Rig per SSH.                                    |

## Wie der Renderer funktioniert

1. `render.js` startet einen kleinen HTTP-Server für den Ordner, öffnet
   `scene.html` in headless Chromium, injiziert das Story-JSON als `window.STORY`.
2. Pro Frame ruft es `window.renderFrame(t)` auf. Die Seite rendert die
   Three.js-Szene in ein WebGL-Canvas, zeichnet es in ein 2D-Canvas und
   legt die Caption drüber. Rückgabe ist ein JPEG als Data-URL.
3. Die JPEGs gehen per Pipe an ffmpeg (`libx264`, `crf 20`, `yuv420p`).

Kein Ton. Voice-over und Musik kommen danach in CapCut oder DaVinci Resolve.

## Erfahrungen aus der Cloud-Session

- Software-Rendering (SwiftShader): voller Render 1305 Frames dauert ca. 6 min.
  Vorschau mit `--fps 10 --scale 0.5` dauert ca. 30 s.
- Gelöste Probleme: Gesichter waren schwarz (Textur brauchte Hautfarbe als
  Grund), Nahaufnahme schnitt den Kopf ab (Kamera-Presets angepasst),
  Captions lagen über den Gesichtern (jetzt bei 74 % Bildhöhe),
  Nachtszene zu dunkel (Licht erhöht).
- `--gpu` (EGL über Mesa) ist ungetestet, weil in der Cloud keine GPU war.
  Auf dem Rig zuerst damit probieren, bei schwarzem Bild weglassen.

## Nächste sinnvolle Schritte auf dem Rig

1. Setup nach `RIG.md` Weg A, Testrender des Beispiels mit und ohne `--gpu`,
   Zeiten vergleichen.
2. Mit dem Prompt aus `PROMPT.md` drei weitere Skripte aus `IDEEN.md`
   erzeugen und rendern.
3. Ton: ein Gratis-TTS prüfen (Piper läuft lokal und offline, deutsche und
   englische Stimmen), Voice-over automatisch aus den Captions erzeugen und
   mit ffmpeg mischen. Das wäre die größte Verbesserung des Renderers.
4. Optional: mehr Posen (umarmen, laufen weg), Requisiten (Auto, Handy,
   Schulbank), Wetter (Regen) für mehr Story-Varianten.

## Git-Stand

Branch `claude/youtube-project-5eeb4r` im Repo `pelemen74-hash/rigwatch`,
zwei lokale Commits in der Cloud-Session. Push nach GitHub schlug mit 403
fehl, weil die Claude-GitHub-App keinen Zugriff auf das Repo hat. Die Dateien
kommen daher als ZIP oder über Google Drive auf den Rig, nicht über git.
