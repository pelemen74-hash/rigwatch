# YouTube-Projekt: Roblox-Shorts, komplett selbst gerendert

Ziel: vertikale YouTube Shorts (9:16, 45–60 s) im Stil der
"In this world …"-Roblox-Stories. Kein OpenArt, kein GitHub nötig:
der Renderer in `renderer/` erzeugt das Video lokal aus einem Skript.

## Was drin ist

| Pfad                              | Inhalt                                                    |
|-----------------------------------|-----------------------------------------------------------|
| `renderer/render.js`              | Node-Skript: Skript-JSON → MP4 (headless Chromium + ffmpeg) |
| `renderer/scene.html`             | Three.js-Szene: blockige Figuren, Gesichter, Posen, Welten |
| `renderer/story-01-cant-lie.json` | Beispielskript (Idee 1) mit 17 Szenen                      |
| `renderer/story-01-cant-lie.mp4`  | Fertig gerendertes Beispiel-Short                          |
| `PROMPT.md`                       | Prompt, mit dem Claude neue Skript-JSONs schreibt          |
| `IDEEN.md`                        | 30 Story-Regeln mit Twist                                  |
| `CHECKLISTE.md`                   | Produktions- und Upload-Checkliste                         |

## Ablauf pro Video

1. Idee aus `IDEEN.md` wählen.
2. Claude mit dem Prompt aus `PROMPT.md` ein Skript-JSON schreiben lassen
   (oder von Hand: `story-01-cant-lie.json` kopieren und anpassen).
3. Rendern:
   ```
   cd renderer
   node render.js story-02.json story-02.mp4
   ```
   Schneller Vorschau-Render: `--fps 10 --scale 0.5` anhängen (ca. 30 s).
   Voller Render 1080×1920 bei 30 fps dauert einige Minuten.
4. Voice-over und Musik in CapCut oder DaVinci Resolve drüberlegen
   (beides gratis). Voice-over: eigene Stimme oder ein Gratis-TTS wie
   ElevenLabs Free, TikTok-Stimme in CapCut, oder Edge-TTS.
5. Hochladen, siehe `CHECKLISTE.md`.

## Voraussetzungen zum Rendern

- Node 18+, Chromium über Playwright (`npm i playwright` einmalig),
  ffmpeg im Pfad.
- `three.module.min.js` liegt im Ordner `renderer/`.

## Skript-Format (JSON)

```json
{
  "title": "In this world, you can't lie",
  "characters": { "max": { "skin": "#f3c892", "shirt": "#3b82f6", "pants": "#1e3a8a", "hair": "#2b1b0e" } },
  "scenes": [
    { "env": "street", "cam": "close", "duration": 2.5, "caption": "YOU CAN'T\nLIE",
      "focus": "max", "shake": false, "capColor": "#fff",
      "actors": [ { "name": "max", "x": 0, "z": 0, "toX": 0, "toZ": 2, "pose": "walk", "expr": "neutral", "rot": 0 } ] }
  ]
}
```

- `env`: `park`, `street`, `school`, `room`, `sunset`, `night`
- `cam`: `wide`, `medium`, `close`, `low`, `high`, `side`
- `pose`: `idle`, `walk`, `run`, `wave`, `shock`, `sad`, `point`, `cross`, `cheer`, `sit`, `think`
- `expr`: `neutral`, `happy`, `sad`, `shock`, `angry`, `smirk`
- `caption`: fett, max. 3 Wörter pro Zeile, `\n` für Zeilenumbruch
- `toX`/`toZ`: Figur läuft während der Szene dorthin. `rot` in Radiant, 0 = Blick zur Kamera.
- `focus`: Kamera richtet sich auf diese Figur. `shake`: Kamerawackeln für Schockmomente.

## Dateien weitergeben ohne GitHub

Der Ordner `youtube-projekt/` ist eigenständig. Als ZIP kopieren oder in
Google Drive legen; der Renderer braucht nichts aus dem restlichen Repo.

## Realistische Erwartung

Shorts bringen laut dem im TikTok gezeigten Snippet nur rund 20–100 $ pro
Million Views. Das Modell lebt von Masse und Konstanz. Dafür kostet dieser
Weg pro Video nichts außer Rechenzeit.
