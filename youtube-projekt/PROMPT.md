# Prompt: Claude schreibt das Skript-JSON

Diesen Text in einen neuen Claude-Chat einfügen, zusammen mit dem Inhalt
von `renderer/story-01-cant-lie.json` als Beispiel.

```
Du schreibst Skripte für 9:16 YouTube Shorts im Stil der
"In this world..."-Roblox-Stories. Ausgabe ist ausschließlich ein JSON
im Format des angehängten Beispiels.

Regeln:
- Story: eine Welt mit einer seltsamen Regel, eine Hauptfigur, die unter
  der Regel leidet, und ein Twist in den letzten 5 Sekunden, der die Regel
  in etwas Gutes verwandelt.
- 16 bis 20 Szenen, je 2 bis 3 Sekunden, insgesamt 45 bis 55 Sekunden.
- Pro Szene eine Caption mit maximal 3 Wörtern pro Zeile, maximal 2 Zeilen,
  in GROSSBUCHSTABEN. Die erste Caption beginnt mit "IN THIS WORLD".
- Erlaubte Werte: env = park, street, school, room, sunset, night;
  cam = wide, medium, close, low, high, side;
  pose = idle, walk, run, wave, shock, sad, point, cross, cheer, sit, think;
  expr = neutral, happy, sad, shock, angry, smirk.
- Schnittrhythmus abwechseln: nach jeder wide- oder medium-Einstellung eine
  close-Einstellung mit "focus" auf die sprechende Figur.
- Bei Schock oder Wendepunkt "shake": true setzen.
- Die Twist-Caption bekommt "capColor": "#ffe066".
- Letzte Szene: alle Figuren, pose cheer oder wave, Caption "FOLLOW FOR\nPART 2".
- 2 bis 4 Figuren mit klar unterschiedlichen Farben für shirt, pants, hair.

Story-Regel: [REGEL AUS IDEEN.md]
Twist: [TWIST AUS IDEEN.md]
```

## Original-Prompt aus dem TikTok (für OpenArt, zur Referenz)

```
Use OpenArt to make a vertical (9:16) YouTube Short in the style of an
"In this world..." Roblox story.
Format: a short, dramatic story set in a world with one strange rule, told
with Roblox-style blocky characters (square heads, simple faces, big
expressive eyes and mouths, smooth plastic look) in cozy, colorful 3D scenes.
Big, bold captions on screen, one or two words at a time. Fast pacing, a cut
every 2 to 3 seconds, around 45 to 60 seconds total, and a twist ending.
```
