# SAL BAN Monolith Engine - Model Context Protocol (MCP) Server

This is the official Model Context Protocol (MCP) server for the [SAL BAN Monolith Engine](https://salban.de), a powerful, cutting-edge in-browser synthesizer and groovebox. 

This MCP server acts as a local WebSocket bridge, allowing agentic AI coding assistants (such as Claude Desktop, Cursor, or Antigravity) to directly program sequences, tweak synthesizer parameters, load audio samples, and interact with the Monolith Engine in real-time.

<p align="center">
  <img src="assets/salban-monolith-engine-dark.png" alt="SAL BAN Monolith Engine - Dark Mode" width="48%" />
  <img src="assets/salban-monolith-engine-light.png" alt="SAL BAN Monolith Engine - Light Mode" width="48%" />
</p>

---

## 🎛️ The Monolith Engine Modules & MCP Integration

While this repository focuses on the secure **MCP WebSocket Server**, here is a brief overview of the Monolith Engine modules that you can control. You can experience the complete interactive synthesizer live on [salban.de](https://salban.de).

### What makes the MCP Integration so unique?
Traditional music software relies on complex MIDI mappings, local file transfers, or closed scripting languages. The **SAL BAN MCP integration** breaks these barriers by exposing the entire synth state and sequencer controls as **natural language tools** to AI models. This allows an AI agent to:
- Code complex arpeggios, Goa trance rolling basslines, or syncopated breaks on the fly using standard programming loops.
- Programmatically synthesize new raw waveforms in Node.js and load them directly into the browser's audio buffer (e.g., custom drums or sweeps).
- Tweak synthesis knobs (cutoff, resonance, LFO speed) dynamically based on natural language commands (e.g., *"make it squelchier"* or *"slow down the tempo"*).

---

### Core Synthesizer Modules

<table>
  <tr>
    <td width="50%">
      <h4>🎹 Synth Voices Block</h4>
      <p>Dual-voice synthesizer consisting of a dedicated <strong>Bassline</strong> and <strong>Lead</strong> synth engine, utilizing sawtooth, square, triangle, sine, and custom wavetable waveforms with resonant filters.</p>
      <img src="assets/01-Synth-voices-block.png" alt="Synth Voices Block" />
    </td>
    <td width="50%">
      <h4>🥁 Drum Voices Block</h4>
      <p>Dedicated analog-style drum synthesizers for <strong>Kick</strong>, <strong>Snare</strong>, and <strong>Hat</strong> with fine-tunable pitch, decay, and accent parameters.</p>
      <img src="assets/02-Drum-voices-block.png" alt="Drum Voices Block" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h4>🎙️ Phrase & One-Shot Samplers</h4>
      <p>An 8-pad sampler featuring phrase looping and one-shot playback capabilities. Supports real-time sample loading via Base64 injection from the AI client.</p>
      <img src="assets/03-Phrase-Sampler.png" alt="Phrase Sampler" />
    </td>
    <td width="50%">
      <h4>🎛️ LFO Modulation Matrix</h4>
      <p>A multi-slot LFO matrix permitting routing of sine, triangle, saw, square, and sample-and-hold modulators to filter cutoffs, levels, fuzz, or panning.</p>
      <img src="assets/05-lfo-Matrix.png" alt="LFO Matrix" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h4>🎚️ Mixer & Studio FX Control</h4>
      <p>A multi-channel mixer with levels, panning, and aux sends routing into studio-grade return effects (Fuzz distortion, Delay, and Reverb).</p>
      <img src="assets/07-mixer.png" alt="Mixer and FX Controls" />
    </td>
    <td width="50%">
      <h4>🎼 Step Sequencer & Patch Center</h4>
      <p>A 16-step sequencer pattern grid for all drums, synths, and samplers, backed by preset patch loading and real-time transport sync.</p>
      <img src="assets/011-sequencer.png" alt="Step Sequencer" />
    </td>
  </tr>
</table>

---

## 📐 Architecture & Data Flow

The integration runs entirely on the user's local machine, establishing a secure loopback connection between the browser, the sandboxed Docker container, and the AI client.

```mermaid
graph TD
    subgraph Browser ["Web Browser (User's System)"]
        Site["https://salban.de (Monolith Engine)"]
        JS["Web Audio API & Sequencer UI"]
    end

    subgraph local_mcp ["Local Docker Sandbox (USER node)"]
        WS["WebSocket Server (port 8080)"]
        Verify["Strict verifyClient: Origin Check / Max Conn Limit / Optional Token"]
    end

    subgraph LLM_Client ["AI Client (e.g. Claude Desktop, Cursor)"]
        Agent["LLM Coding Assistant"]
        Stdio["Stdio Transport Connection"]
    end

    %% Data Flow Connections
    Site <-->|WS Local Loopback: localhost:8080| Verify
    Verify <-->|Secure Channel| WS
    WS <-->|JSON-RPC via Stdio| Stdio
    Stdio <-->|Tools Interface| Agent
    
    %% Styling
    classDef browser fill:#051d36,stroke:#00e5ff,stroke-width:2px,color:#fff;
    classDef docker fill:#1f2937,stroke:#00e5ff,stroke-width:2px,color:#fff;
    classDef client fill:#111827,stroke:#00e5ff,stroke-width:2px,color:#fff;
    class Browser browser;
    class local_mcp docker;
    class LLM_Client client;
```

---

## 🔒 Security & Hardening by Design

Because the MCP server runs locally and connects to a public web interface, it is built with strict security measures to protect end-users:

1. **Docker Sandbox:** The server runs inside an unprivileged environment (`USER node`) instead of root. Compiled files inside `/app` are set to read-only (`755` owned by `root:root`) to prevent post-exploitation modification of execution binaries.
2. **Strict Origin Validation:** The WebSocket server strictly validates HTTP `Origin` headers, allowing connections **only** from `https://salban.de` and authorized local development hosts (e.g. `localhost:3000`). All other connection attempts (e.g., malicious background tabs) are rejected immediately with a `403 Forbidden` response.
3. **Connection Rate Limiting:** Limits connections to a maximum of 2 concurrent active WebSocket sockets to prevent denial-of-service (DoS) exploits.
4. **Payload Size Restriction:** Limits incoming frame sizes strictly to 15MB.
5. **Flexible Token Protection (Pro-Mode):** 
   - By default, it operates in a **Hybrid No-Token Mode** for a frictionless out-of-the-box experience.
   - For maximum security (e.g. preventing unauthorized local host scripts from accessing the bridge), you can activate **Token Pro-Mode** by setting the `SALBAN_MCP_TOKEN` environment variable. When set, clients must pass this token during the WebSocket handshake.

---

## ⚖️ GDPR (DSGVO) & EU AI Act Compliance

This project is built from the ground up to respect user privacy and comply with European regulatory frameworks.

### 🇪🇺 GDPR / DSGVO Compliance (Privacy by Design - Art. 25)

* **No Processing of Personal Data (PII):** The MCP server processes only technical telemetry and synthesis variables (tempo, notes, pitches, mute states, envelope parameters). It does not collect, log, or transmit personal data such as names, emails, IPs, or location telemetry.
* **100% Local Loopback (Art. 32 Security):** All communication occurs locally. No audio parameters or command payloads are sent to external servers or third parties.
* **Strict Necessity (Exemption from Cookie Banner):** The local token and configuration details stored in the browser's `localStorage` are technically necessary to establish and secure the local loopback WebSocket connection requested by the user, making it fully exempt from prior cookie consent requirements under ePrivacy guidelines.

### 🤖 EU AI Act Compliance

* **Low-Risk Classification:** This application acts as a creative assistant for music generation. It does not fall under the "High-Risk" categories (such as critical infrastructure, education, law enforcement, or biometrics) outlined in Annex III of the EU AI Act.
* **Transparency Requirement (Art. 52):** When using an AI co-producer via this MCP bridge, the user initiates all actions. There is complete transparency that an artificial intelligence model is generating the notes/sequences.
* **Human-in-the-Loop (HITL):** The user remains in complete control. All sequences generated by the AI can be edited, mutated, or muted in real-time via the web interface.

---

## 🚀 Installation & Getting Started

### 1. Build and Run via Docker (Recommended)

Building the container automatically compiles the TypeScript source code in a secure sandboxed multi-stage build.

#### Step A: Build the Docker Image
```bash
docker build -t salban-mcp-server:latest .
```

#### Step B: Run the Container

**Option A: Hybrid No-Token Mode (Frictionless / Default)**
Allows instant connection from `https://salban.de` via automatic origin verification:
```bash
docker run -d --name salban-mcp -p 8080:8080 salban-mcp-server:latest
```

**Option B: Token Pro-Mode (High Security)**
Enforces authentication with a custom static token:
```bash
docker run -d --name salban-mcp -p 8080:8080 -e SALBAN_MCP_TOKEN=your_secure_password salban-mcp-server:latest
```
*(Enter this token once on the salban.de interface when prompted; it will be securely cached in your browser's local storage).*

---

## 🛠️ Configuring AI Clients (Claude Desktop / Cursor)

To allow your AI assistant to use the MCP tools, add the server to your local Claude Desktop configuration file:

**On macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**On Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the following entry (adjusting the paths or command if running via Docker):

### Running via Stdio (Native Docker)
```json
{
  "mcpServers": {
    "salban-monolith": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "salban-mcp-server:latest"
      ]
    }
  }
}
```

---

## 📡 Registered MCP Tools

The server exposes 19 rich semantic tools to the AI assistant:

* **`salban_get_preset`**: Returns the active preset JSON state from the browser client.
* **`salban_apply_preset`**: Sends a complete preset JSON configuration to the browser.
* **`salban_tweak_parameter`**: Tweaks a single nested parameter (e.g., `synthParams.lead.cutoff`).
* **`salban_load_sample`**: Injects a Base64-encoded audio sample into a sampler pad (0–7).
* **`salban_load_phrase`**: Loads a Base64-encoded audio loop directly into the central Phrase Sampler.
* **`salban_inject_mcp_sample`**: Programmatically synthesizes standard electronic drum hits (kick, noise click) and injects them.
* **`salban_get_sequence`**: Returns the 16-step sequence for a specific voice.
* **`salban_set_pad_sequence`**: Sets triggers, pitch, reverse, and volume for a sampler pad's 16 steps.
* **`salban_set_sampler_sequence`**: Sets triggers, pitch, reverse, volume, and tie (sustain) for the Phrase Sampler's 16 steps.
* **`salban_set_drum_sequence`**: Sets kick/snare/hat 16-step velocity triggers.
* **`salban_set_synth_sequence`**: Sets note values, ties, and accents for bass/lead sequences.
* **`salban_set_voice_params`**: Sets loop length, speed, and direction.
* **`salban_clear_sequence`**: Silences all 16 steps of a voice.
* **`salban_get_parameter_schema`**: Returns valid tweakable parameters and LFO targets.
* **`salban_get_song_sequencer`**: Returns the active Song Preset Sequencer state (pads, names, repeats, play direction, and auto-chain status).
* **`salban_configure_song_pad`**: Configures a specific pad (0–7), allowing name assignment, repeat count modification, capturing the current live state, or direct preset snapshot uploading.
* **`salban_clear_song_pad`**: Resets and clears a pad slot, removing the assigned preset snapshot.
* **`salban_configure_song_sequencer`**: Updates global song sequencer parameters (toggling Auto-Chain mode and setting play direction like forward, reverse, ping-pong, or random).
* **`salban_trigger_song_pad`**: Triggers or queues playback of a specific pad in the Song Preset Sequencer immediately or at the next loop boundary.

---

## 💻 Developer Setup

If you want to run the server locally outside of Docker for development:

1. Install dependencies:
   ```bash
   npm install
   ```
2. Compile and run:
   ```bash
   npm run build
   node build/index.js
   ```

## 📄 License & Legal Notice

This project is confidential and protected under a **Proprietary Evaluation License**. Commercial use, production deployment, modification, or distribution is strictly prohibited without a separate, explicit written agreement from **Matthias Köhler (Oszillation Media & AI Ecosystems)**. Please refer to the [LICENSE](LICENSE) file for full terms, conditions, and third-party notices.

⚠️ **Important:** These blueprints provide a security architecture pattern and reference implementation. They are not a substitute for a formal security assessment by a qualified professional. Always conduct a Data Protection Impact Assessment (DPIA) under GDPR Article 35 before deploying AI tooling against personal data in regulated environments. Engage your Data Protection Officer and Information Security team before production use.
