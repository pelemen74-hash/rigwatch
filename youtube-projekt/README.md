# YouTube-Projekt: Roblox-Shorts mit Claude + OpenArt

Nachbau des Workflows aus dem TikTok von philsidehustles
("insane what u can do with claude + roblox + openart").

Ziel: vertikale YouTube Shorts (9:16, 45–60 s) im Stil der
"In this world …"-Roblox-Stories, komplett per Prompt in Claude erzeugt.

## Ablauf in 5 Schritten

1. **OpenArt als Connector in Claude einrichten** (einmalig, manuell im Browser)
   - claude.ai öffnen, in der Seitenleiste **Plugins** anklicken
   - oben auf den Reiter **Connectors** wechseln
   - rechts **Add** → **Add custom connector**
   - Name: `OpenArt`
   - MCP server URL: `https://mcp.openart.ai/mcp`
   - Speichern und den Login bei OpenArt bestätigen (OpenArt-Konto nötig)
   - Alternativer Weg laut OpenArt-Seite: Settings (Zahnrad) → Customize → Connectors → + Add
2. **Optional: OpenArt Skills installieren** (auf openart.ai/mcp unter "Add OpenArt Skills")
   Liefern fertige Workflows für Produktvideos, Storys usw.
3. **Neuen Chat starten**, ein Referenzbild einfügen (Screenshot aus einem
   bestehenden Roblox-Short, damit der Look getroffen wird) und den
   Master-Prompt aus `PROMPT.md` einsetzen.
4. **Story aus `IDEEN.md` wählen** oder Claude eine neue Regel + Twist ausdenken lassen.
5. **Export, Upload, Wiederholen** – siehe `CHECKLISTE.md`.

## Was Claude dabei macht

- schreibt das Skript (Regel, Szenen, Captions, Twist)
- ruft über den OpenArt-Connector die Bild-/Videogenerierung auf
- liefert die Clips und Captions zurück, die dann geschnitten werden

## Realistische Erwartung

Das Video im TikTok zeigt ein Google-Snippet mit 1.000–5.000 $ pro Million
Views. Für Shorts liegt der RPM laut demselben Snippet deutlich niedriger
(ca. 20–100 $ pro Million). Rechne also mit kleinem Geld pro Video, das
Modell lebt von Masse und Konstanz, nicht von einzelnen Hits.

OpenArt-Generierungen kosten Credits; das Free-Kontingent reicht zum Testen,
nicht für eine tägliche Produktion.

## Dateien

| Datei           | Inhalt                                           |
|-----------------|--------------------------------------------------|
| `PROMPT.md`     | Master-Prompt (Original aus dem Video + Varianten)|
| `IDEEN.md`      | 30 Story-Regeln mit Twist, direkt verwendbar      |
| `CHECKLISTE.md` | Produktions- und Upload-Checkliste pro Video      |
