# SAL BAN MCP Server - How-To Guide

Dieses Dokument beschreibt die Architektur, Konfiguration, Nutzung und zukünftige Erweiterung des **SAL BAN Model Context Protocol (MCP) Servers**. Es dient als Referenz für Entwickler und zukünftige KI-Assistenten.

---

## 🏗️ 1. Architektur im Überblick

Der `salban-mcp-server` verbindet eine KI-Umgebung (wie diese IDE oder Claude Desktop) direkt mit der Synthesizer-Webseite `salban.de` im Browser des Nutzers.

```
┌─────────────────┐             ┌────────────────────┐             ┌──────────────┐
│  KI-Assistent   │  (Stdio)    │ Local MCP-Server   │ (WebSocket)  │ Webbrowser   │
│  (IDE / Claude) ├────────────►│ (Docker-Container) ├─────────────►│ (salban.de)  │
│                 │◄────────────┤                    │◄─────────────┤              │
└─────────────────┘             └────────────────────┘             └──────────────┘
```

1. **Stdio-Verbindung:** Die KI kommuniziert mit dem MCP-Server über Standard-Input und Standard-Output (`stdio`).
2. **WebSocket-Brücke:** Der MCP-Server startet einen lokalen WebSocket-Server auf Port `8080`.
3. **Browser-Client:** Die Webseite `salban.de` verbindet sich als Client mit `ws://localhost:8080`. Wenn die Verbindung steht, können Presets ausgetauscht und Regler in Echtzeit gedreht werden.

---

## 📦 2. Docker & Build-System

Um den Server isoliert und ohne lokale Node.js-Installation auf dem Host auszuführen, wird ein Docker-Container verwendet.

### Dockerfile (Multi-Stage Build)
Das [Dockerfile](file:///Volumes/Spacestation/virtual-buddy-exchange/Tools-Development/projects/salban.de/mcp-server/salban-mcp-server/Dockerfile) teilt den Prozess in zwei Stufen, um das finale Image minimal zu halten:
* **Build-Stage (`builder`):** Kopiert den TypeScript-Code, installiert alle Entwicklungs-Abhängigkeiten (`devDependencies`) und kompiliert den Code zu JavaScript (`build/index.js`).
* **Runner-Stage (`runner`):** Basiert auf `node:20-alpine`, installiert **ausschließlich** Produktions-Abhängigkeiten (`dependencies`) und kopiert nur die fertig gebauten JavaScript-Dateien aus der Build-Stage.

### Bauen des Images
Zum Generieren eines neuen Docker-Images führen Sie im Projektverzeichnis folgenden Befehl aus:
```bash
docker build -t salban-mcp-server .
```

---

## ⚙️ 3. Konfiguration der IDE (mcp_config.json)

Die IDE liest die Konfiguration aus `/Users/mk/.gemini/config/mcp_config.json`. Der Eintrag für den SAL BAN Server lautet:

```json
"salban-monolith": {
  "command": "/opt/homebrew/bin/docker",
  "args": [
    "run",
    "-i",
    "--rm",
    "-p",
    "8080:8080",
    "salban-mcp-server:latest"
  ]
}
```

### Bedeutung der Argumente:
* `-i`: Startet den Container im interaktiven Modus, der für die `stdio`-Kommunikation zwischen KI und Server zwingend nötig ist.
* `--rm`: Bereinigt und löscht den temporären Container nach dem Beenden automatisch.
* `-p 8080:8080`: Mappt den WebSocket-Port `8080` aus dem Container auf den Port `8080` Ihres Mac.

---

## 🔗 4. Browser-Verbindung ("Jam with SALBAN MCP")

Aus Sicherheitsgründen schränkt der Browser (insb. Brave/Chrome) Zugriffe von einer öffentlichen Webseite (`https://salban.de`) auf lokale Ports (`localhost:8080`) ein (**Private Network Access**).

* **UI-Lösung:** Die Verbindung wird erst aufgebaut, wenn der Nutzer auf den Button **"Jam with SALBAN MCP"** klickt.
* **Berechtigung:** Beim ersten Klick fragt der Browser: *"Auf andere Apps und Dienste auf diesem Gerät zugreifen"*. Hier muss auf **"Zulassen"** geklickt werden.

---

## 🛠️ 5. Registrierte MCP Tools

Der Server stellt der KI nun insgesamt **19 Werkzeuge** zur Verfügung (definiert in [src/index.ts](file:///Volumes/Spacestation/virtual-buddy-exchange/Tools-Development/projects/salban.de/mcp-server/salban-mcp-server/src/index.ts)), unterteilt in vier Kategorien:

### 🎛️ Preset- & Parameter-Steuerung
1. **`salban_get_preset`**
   * **Beschreibung:** Gibt das aktuell im Browser geladene Synthesizer-Preset als JSON-Objekt zurück.
   * **Argumente:**
     - `includeSamples`: (optional, Boolean) Ob Base64-Audiosamples mitgeliefert werden sollen.
2. **`salban_apply_preset`**
   * **Beschreibung:** Überschreibt das gesamte Preset im Browser mit neuen Notenwerten, Tempi, Modulationszielen oder Effekten.
   * **Argumente:** 
     - `preset`: Das vollständige JSON-Preset-Objekt.
3. **`salban_tweak_parameter`**
   * **Beschreibung:** Verändert einen einzelnen Wert (Zahl, String oder Boolean) live im laufenden Betrieb.
   * **Argumente:**
     - `path`: Dotted-Notations-Pfad zum Parameter (z. B. `synthParams.lead.cutoff`, `mixer.kick.mute`).
     - `value`: Der neue Wert.
4. **`salban_get_parameter_schema`**
   * **Beschreibung:** Liefert eine Liste aller über `salban_tweak_parameter` regelbaren Dotted-Keypaths sowie alle zulässigen LFO-Modulationsziele.
   * **Argumente:** Keine.

### 🔊 Sampler- & Sample-Injektion
5. **`salban_load_sample`**
   * **Beschreibung:** Lädt ein beliebiges Base64-codiertes Audio-Sample (WAV, MP3, etc.) direkt auf eines der 8 Pads.
   * **Argumente:**
     - `padIndex`: Target Sampler Pad (0 bis 7).
     - `data`: Der Base64-String der Audio-Datei.
6. **`salban_load_phrase`**
   * **Beschreibung:** Lädt ein Base64-codiertes Audio-Sample direkt in den zentralen Phrase Sampler.
   * **Argumente:**
     - `data`: Der Base64-String der Audio-Datei.
     - `name`: (optional) Name des Phrase-Loops.
7. **`salban_inject_mcp_sample`**
   * **Beschreibung:** Synthetisiert programmatisch in Node.js ein Audio-Sample (Kick, Noise-Sweep, Click), erzeugt eine 16-Bit-Mono-WAV in-memory und sendet diese via Base64 an das angegebene Pad.
   * **Argumente:**
     - `padIndex`: Target Sampler Pad (0 bis 7).
     - `sampleType`: `"kick"`, `"noise"`, oder `"sine_click"`.

### 🥁 Granulare Sequenzer-Steuerung (Latenzfreie Ausführung)
*Hinweis: Diese Tools mutieren den lokalen Preset-Cache des Servers und flushen diesen sofort an den Browser. Dadurch entfällt der 2-3 minütige Ladezyklus des gesamten Presets, Änderungen sind in <100ms hörbar.*

8. **`salban_get_sequence`**
   * **Beschreibung:** Gibt das 16-Schritte-Array für eine einzelne Spur zurück.
   * **Argumente:**
     - `voice`: `"kick"`, `"snare"`, `"hat"`, `"bass"`, `"lead"`, oder `"pad0"` bis `"pad7"`.
9. **`salban_set_pad_sequence`**
   * **Beschreibung:** Setzt das 16-Schritte-Muster für ein einzelnes Sampler-Pad.
   * **Argumente:**
     - `padIndex`: Index des Pads (0 bis 7).
     - `steps`: Array mit 16 Objekten der Form: `{ active: boolean, pitch: number, reverse: boolean, vol: number }`.
10. **`salban_set_sampler_sequence`**
    * **Beschreibung:** Setzt das 16-Schritte-Muster für den zentralen Phrase Sampler (Triggers, Pitch, Reverse, Vol, Tie).
    * **Argumente:**
      - `steps`: Array von 16 Objekten der Form: `{ active: boolean, pitch: number, reverse: boolean, vol: number, tie: boolean }`.
11. **`salban_set_drum_sequence`**
    * **Beschreibung:** Programmiert ein 16-Schritte-Muster für klassische Drum-Instrumente.
    * **Argumente:**
      - `voice`: `"kick"`, `"snare"`, oder `"hat"`.
      - `steps`: Array von 16 Zahlen (`0` = aus, `1` = Hit, `2` = Accent, `3` = Snare Ghost-Hit).
12. **`salban_set_synth_sequence`**
    * **Beschreibung:** Programmiert Noten und Binde-Bögen für die Bassline- oder Lead-Synthesizer.
    * **Argumente:**
      - `voice`: `"bass"` oder `"lead"`.
      - `steps`: Array von 16 Objekten der Form: `{ active: boolean, note: string, tie: boolean, accent: boolean }`.
13. **`salban_set_voice_params`**
    * **Beschreibung:** Ändert Wiedergabeparameter wie Loop-Länge, Abspielrichtung oder Geschwindigkeit.
    * **Argumente:**
      - `voice`: Die betroffene Spur (z. B. `"bass"`, `"pad0"`).
      - `loopLength`: (optional) Zahl von 1 bis 16.
      - `speed`: (optional) `"1/4x"`, `"1/2x"`, `"1x"`, `"2x"`, `"4x"`.
      - `dir`: (optional) `"forward"`, `"reverse"`, `"pingpong"`.
      - `transpose`: (optional, nur Synth) Transponierung in Halbtönen.
14. **`salban_clear_sequence`**
    * **Beschreibung:** Leert und deaktiviert alle 16 Schritte einer Spur in einem einzelnen Aufruf.
    * **Argumente:**
      - `voice`: Betroffene Spur (z. B. `"lead"`, `"pad4"`).

### 🎵 Song- & Pad-Arrangement (Song Preset Sequencer)
15. **`salban_get_song_sequencer`**
    * **Beschreibung:** Gibt den aktuellen Zustand des Song Preset Sequenzers (Pads, Namen, Repeats, Play-Richtung, Auto-Chain-Status) zurück.
    * **Argumente:** Keine.
16. **`salban_configure_song_pad`**
    * **Beschreibung:** Konfiguriert ein spezifisches Pad (0-7) im Song Preset Sequencer. Ermöglicht Namen zu vergeben, Repeats anzupassen, den aktuellen Live-Zustand des Synthesizers zu erfassen (Recapture) oder ein Preset direkt zu laden.
    * **Argumente:**
      - `padId`: Index des Pads (0 bis 7).
      - `name`: (optional) Neuer Name für das Pad.
      - `repeatCount`: (optional) Anzahl der Wiederholungen (1 bis 99).
      - `captureLiveState`: (optional, Boolean) Erfasst den aktuellen Live-Zustand des Groovebox-Synthesizers.
      - `preset`: (optional, Object) Ein vollständiges Preset-JSON-Objekt.
17. **`salban_clear_song_pad`**
    * **Beschreibung:** Löscht ein zugewiesenes Preset-Snapshot von einem spezifischen Pad und setzt den Slot zurück.
    * **Argumente:**
      - `padId`: Index des Pads (0 bis 7).
18. **`salban_configure_song_sequencer`**
    * **Beschreibung:** Aktualisiert globale Song-Sequenzer-Einstellungen (Auto-Chain an/aus, Abspielrichtung).
    * **Argumente:**
      - `autoChainEnabled`: (optional, Boolean) Schaltet Auto-Chain ein/aus.
      - `chainDirection`: (optional) `"fwd"`, `"rev"`, `"pp"`, oder `"rnd"`.
19. **`salban_trigger_song_pad`**
    * **Beschreibung:** Startet die Wiedergabe eines bestimmten Pads (0 bis 7) sofort oder reiht es an der nächsten Taktgrenze ein.
    * **Argumente:**
      - `padId`: Index des Pads (0 bis 7).

---

## 🚀 6. Server erweitern oder verändern

Wenn Sie neue Features oder Tools hinzufügen möchten:

1. **Code editieren:** Fügen Sie in [src/index.ts](file:///Volumes/Spacestation/virtual-buddy-exchange/Tools-Development/projects/salban.de/mcp-server/salban-mcp-server/src/index.ts) ein neues Tool über `server.tool()` hinzu.
2. **Lockfile aktualisieren (falls neue npm-Pakete installiert werden):**
   Führen Sie ein lokales npm install über Docker aus, um die `package-lock.json` auf dem Host aktuell zu halten:
   ```bash
   docker run --rm -v "$(pwd)":/app -w /app node:20-alpine npm install
   ```
3. **Docker-Image neu bauen:**
   ```bash
   docker build -t salban-mcp-server .
   ```
4. **IDE aktualisieren:** Die IDE lädt das neue Image beim nächsten Start automatisch, da in der Config `salban-mcp-server:latest` hinterlegt ist.

---

## 📦 7. Release-ZIP für den Download-Bereich erstellen

Wenn ein neues Release für Nutzer bereitgestellt wird, wird ein ZIP-Archiv ohne den `assets/`-Ordner (reine Bild-Assets für die README, unnötig für User) und ohne `node_modules/` sowie `.git/` erstellt:

```bash
# Aus dem Verzeichnis mcp-server/ ausführen (eine Ebene über dem Repo-Ordner):
cd /path/to/mcp-server

# Altes ZIP entfernen, neues erstellen (OHNE assets/)
rm -f salban-mcp-server.zip && zip -r salban-mcp-server.zip salban-mcp-server/ \
  --exclude "salban-mcp-server/.git/*" \
  --exclude "salban-mcp-server/node_modules/*" \
  --exclude "salban-mcp-server/assets/*" \
  --exclude "salban-mcp-server/.DS_Store" \
  --exclude "salban-mcp-server/.gitignore"

# In den Downloads-Ordner der Website kopieren:
cp salban-mcp-server.zip /path/to/httpdocs/downloads/salban-mcp-server.zip
```

> ⚠️ **Wichtig:** Der `assets/`-Ordner enthält ausschließlich Vorschaubilder für die GitHub-README. Er ist für den Betrieb des Servers nicht erforderlich und soll **nicht** ins Nutzer-ZIP aufgenommen werden.

Das ZIP enthält:
- `src/index.ts` — vollständiger TypeScript-Quellcode
- `build/index.js` — vorkompilierter JavaScript-Build (direkt ausführbar)
- `Dockerfile` + `docker-compose.yml` — Container-Setup
- `package.json` + `package-lock.json` — npm-Abhängigkeiten
- `README.md` + `salban-mcp-how-to.md` + `LICENSE`
- `claude_desktop_config.json` — Beispielkonfiguration für Claude Desktop
