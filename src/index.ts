import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { IncomingMessage } from "http";
import crypto from "crypto";

// Initialize the MCP Server
const server = new McpServer({
  name: "salban-monolith-engine",
  version: "1.0.0",
});

// Port for the local WebSocket bridge
const WS_PORT = 8080;

// Configurable allowed origins list
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["https://salban.de", "http://localhost:3000", "http://localhost:5173", "http://localhost:8080"];

// Read token from environment variable
const securityToken = process.env.SALBAN_MCP_TOKEN;

if (securityToken) {
  console.error("\n========================================================");
  console.error("🔒 SAL BAN MCP SERVER AUTHENTICATION TOKEN REGISTERED");
  console.error("========================================================\n");
} else {
  console.error("\n========================================================");
  console.error("🔓 SAL BAN MCP SERVER RUNNING IN HYBRID NO-TOKEN MODE");
  console.error("========================================================\n");
}

// Local in-memory cache to store the latest preset state from the browser client
let currentPresetState: any = null;

// Initialize WebSocket Server with 15MB payload limit and strict client verification
const wss = new WebSocketServer({
  port: WS_PORT,
  maxPayload: 15 * 1024 * 1024, // 15MB payload size limit
  verifyClient: (
    info: { origin: string; req: IncomingMessage; secure: boolean },
    callback: (res: boolean, code?: number, message?: string) => void
  ) => {
    // 1. Strict Origin check
    const origin = info.origin;
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      console.error(`[WS Security] Handshake rejected: Unauthorized origin "${origin}"`);
      callback(false, 403, "Forbidden: Unauthorized origin");
      return;
    }

    // 2. Max concurrent connection limit
    if (wss.clients.size >= 2) {
      console.error(`[WS Security] Handshake rejected: Connection limit (2) reached.`);
      callback(false, 429, "Too Many Requests: Connection limit reached");
      return;
    }

    // 3. Pre-authenticate client if token is enabled and passed via URL query parameter
    if (securityToken) {
      try {
        const reqUrl = new URL(info.req.url || "", `http://${info.req.headers.host || "localhost"}`);
        const tokenParam = reqUrl.searchParams.get("token");
        if (tokenParam) {
          if (tokenParam !== securityToken) {
            console.error("[WS Security] Handshake rejected: Invalid token parameter.");
            callback(false, 401, "Unauthorized: Invalid token");
            return;
          }
          (info.req as any).preAuthenticated = true;
        }
      } catch (e: any) {
        console.error("[WS Security] Error checking token parameter:", e.message);
      }
    }

    callback(true);
  }
});

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  let isClientAuthenticated = !securityToken || (req as any).preAuthenticated === true;
  let authTimeout: NodeJS.Timeout | null = null;

  if (securityToken && !isClientAuthenticated) {
    console.error("[WS Security] Client connected without token. Awaiting first-frame authentication...");
    authTimeout = setTimeout(() => {
      if (!isClientAuthenticated) {
        console.error("[WS Security] Authentication timeout reached. Terminating connection.");
        ws.terminate();
      }
    }, 2000);
  } else if (securityToken) {
    console.error("[WS Security] Client pre-authenticated via query parameter.");
  } else {
    console.error("[WS Security] Client connected directly (Token check is disabled).");
  }

  ws.on("message", (message: string) => {
    try {
      // Ensure the received message size does not exceed the limit
      if (message.length > 15 * 1024 * 1024) {
        console.error("[WS Security] Received message exceeds 15MB limit. Terminating connection.");
        ws.terminate();
        return;
      }

      const data = JSON.parse(message);

      // If client is not yet authenticated, the first message MUST be an authentication frame
      if (securityToken && !isClientAuthenticated) {
        if (data && data.type === "auth" && data.token === securityToken) {
          isClientAuthenticated = true;
          if (authTimeout) {
            clearTimeout(authTimeout);
            authTimeout = null;
          }
          console.error("[WS Security] Client authenticated successfully via first frame.");
          ws.send(JSON.stringify({ type: "auth_success" }));
          return;
        } else {
          console.error("[WS Security] Unauthorized first frame or invalid token. Terminating connection.");
          ws.terminate();
          return;
        }
      }

      // Standard message processing (preset updates / states)
      if (data && (data.type === "state_sync" || data.type === "preset_changed")) {
        currentPresetState = data.preset;
        console.error("[WS] Cached preset updated from browser client");
      }
    } catch (e: any) {
      console.error("[WS] Error parsing client message:", e.message);
      if (!isClientAuthenticated) {
        ws.terminate();
      }
    }
  });

  ws.on("close", () => {
    if (authTimeout) {
      clearTimeout(authTimeout);
    }
    console.error("[WS] Browser client disconnected");
  });
});

// Register MCP Tools

// Tool 1: Get active preset state from the browser
server.tool(
  "salban_get_preset",
  "Returns the currently active cached preset from the browser client. If no browser is connected or synced, it returns a descriptive error message.",
  {},
  async () => {
    if (wss.clients.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: No browser client is currently connected. Make sure you open salban.de in a local web browser, and verify that the local WebSocket bridge is running."
          }
        ],
        isError: true
      };
    }

    if (!currentPresetState) {
      return {
        content: [
          {
            type: "text",
            text: "Notice: The browser client is connected, but no preset state has been synchronized yet. Please interact with the groovebox (e.g. twist a knob) to trigger a state synchronization."
          }
        ]
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(currentPresetState, null, 2)
        }
      ]
    };
  }
);

// Tool 2: Apply a full preset to the browser
server.tool(
  "salban_apply_preset",
  "Applies a complete preset JSON configuration to the connected browser client(s). Accepts a flexible schema to accommodate variations.",
  {
    preset: z.record(z.any()).describe("The complete preset state JSON object to apply")
  },
  async ({ preset }: { preset: Record<string, any> }) => {
    if (wss.clients.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Cannot apply preset. No browser client is connected. Open salban.de in a local web browser first."
          }
        ],
        isError: true
      };
    }

    // Broadcast the preset to all connected clients
    const payload = JSON.stringify({
      type: "apply_preset",
      preset
    });

    let sentCount = 0;
    wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sentCount++;
      }
    });

    return {
      content: [
        {
          type: "text",
          text: `Successfully broadcasted preset to ${sentCount} connected browser client(s).`
        }
      ]
    };
  }
);

// Tool 3: Tweak a single nested parameter dynamically
server.tool(
  "salban_tweak_parameter",
  "Tweak a single nested parameter dynamically in the groovebox (e.g., 'synthParams.lead.cutoff', 'mixer.bassline.mute', or 'lfos[0].amount').",
  {
    path: z.string().describe("Dotted path matching the preset state structure (e.g. synthParams.lead.cutoff)"),
    value: z.union([z.number(), z.string(), z.boolean()]).describe("The target value to apply (e.g. 180, 'sine', or true)")
  },
  async ({ path, value }: { path: string; value: string | number | boolean }) => {
    if (wss.clients.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Cannot tweak parameter. No browser client is connected. Open salban.de in a local web browser first."
          }
        ],
        isError: true
      };
    }

    const payload = JSON.stringify({
      type: "tweak_parameter",
      path,
      value
    });

    let sentCount = 0;
    wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sentCount++;
      }
    });

    return {
      content: [
        {
          type: "text",
          text: `Successfully sent parameter tweak request for '${path}' to '${value}' to ${sentCount} connected client(s).`
        }
      ]
    };
  }
);

// Tool 4: Inject Base64 audio sample directly into a pad
server.tool(
  "salban_load_sample",
  "Loads a Base64 encoded audio sample (WAV, MP3, etc.) directly into one of the 8 sampler pads (0 to 7) of the Monolith Engine.",
  {
    padIndex: z.number().min(0).max(7).describe("The target pad index from 0 to 7"),
    data: z.string().describe("The audio file binary data encoded as a Base64 string")
  },
  async ({ padIndex, data }: { padIndex: number; data: string }) => {
    if (wss.clients.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Cannot load sample. No browser client is connected. Open salban.de in a local web browser first."
          }
        ],
        isError: true
      };
    }

    const payload = JSON.stringify({
      type: "load_sample",
      padIndex,
      data
    });

    let sentCount = 0;
    wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sentCount++;
      }
    });

    return {
      content: [
        {
          type: "text",
          text: `Successfully broadcasted sample injection request for Pad ${padIndex} to ${sentCount} connected client(s).`
        }
      ]
    };
  }
);

// Tool 5: Synthesize and inject a programmatically generated sample
server.tool(
  "salban_inject_mcp_sample",
  "Generates an analytical synthesizer hit (like an 808 kick, white noise sweep, or metallic click) programmatically in Node.js, packages it as a valid WAV, converts to Base64, and injects it into a specified sampler pad (0-7).",
  {
    padIndex: z.number().min(0).max(7).describe("Target Sampler Pad (0 to 7)"),
    sampleType: z.enum(["kick", "noise", "sine_click"]).describe("The type of sound to synthesize programmatically")
  },
  async ({ padIndex, sampleType }: { padIndex: number; sampleType: "kick" | "noise" | "sine_click" }) => {
    try {
      const sampleRate = 44100;
      let duration = 0.4; // seconds
      
      if (sampleType === "noise") duration = 0.6;
      
      const numSamples = Math.floor(sampleRate * duration);
      const audioBuffer = new Float32Array(numSamples);

      // --- SYNTHESIS ENGINES ---
      if (sampleType === "kick") {
        // Synthesize a punchy 808 style pitch-swept sine wave kick
        for (let i = 0; i < numSamples; i++) {
          const t = i / sampleRate;
          // Exponential decay of frequency (pitch sweep starting high, landing low)
          const freq = 150 * Math.exp(-t * 45) + 50; 
          // Amplitude envelope (decay)
          const amp = Math.exp(-t * 6);
          audioBuffer[i] = Math.sin(2 * Math.PI * freq * t) * amp;
        }
      } else if (sampleType === "noise") {
        // Synthesize a white noise hi-hat/sweep with a exponential decay envelope
        for (let i = 0; i < numSamples; i++) {
          const t = i / sampleRate;
          const noise = Math.random() * 2 - 1;
          const amp = Math.exp(-t * 8);
          audioBuffer[i] = noise * amp;
        }
      } else if (sampleType === "sine_click") {
        // Short metallic click
        for (let i = 0; i < numSamples; i++) {
          const t = i / sampleRate;
          const freq = 1200 * Math.exp(-t * 100) + 200;
          const amp = Math.exp(-t * 40);
          audioBuffer[i] = Math.sin(2 * Math.PI * freq * t) * amp;
        }
      }

      // --- GENERATE IN-MEMORY WAV FILE (PCM 16-bit Mono) ---
      const wavHeaderBuffer = Buffer.alloc(44);
      const pcmDataBuffer = Buffer.alloc(numSamples * 2);

      // Write PCM data
      for (let i = 0; i < numSamples; i++) {
        // Scale to 16-bit Int
        const val = Math.max(-1, Math.min(1, audioBuffer[i]));
        const intVal = val < 0 ? val * 0x8000 : val * 0x7FFF;
        pcmDataBuffer.writeInt16LE(intVal, i * 2);
      }

      // Write WAV Header
      wavHeaderBuffer.write("RIFF", 0);
      wavHeaderBuffer.writeUInt32LE(36 + pcmDataBuffer.length, 4); // File size - 8
      wavHeaderBuffer.write("WAVE", 8);
      wavHeaderBuffer.write("fmt ", 12);
      wavHeaderBuffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
      wavHeaderBuffer.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
      wavHeaderBuffer.writeUInt16LE(1, 22);  // NumChannels (1 = Mono)
      wavHeaderBuffer.writeUInt32LE(sampleRate, 24); // SampleRate
      wavHeaderBuffer.writeUInt32LE(sampleRate * 2, 28); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
      wavHeaderBuffer.writeUInt16LE(2, 32);  // BlockAlign
      wavHeaderBuffer.writeUInt16LE(16, 34); // BitsPerSample
      wavHeaderBuffer.write("data", 36);
      wavHeaderBuffer.writeUInt32LE(pcmDataBuffer.length, 40); // Subchunk2Size

      const finalWavBuffer = Buffer.concat([wavHeaderBuffer, pcmDataBuffer]);
      const base64Wav = finalWavBuffer.toString("base64");

      // --- BROADCAST TO WEBSOCKET CLIENTS ---
      if (wss.clients.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Synthesized '${sampleType}' sample, but no browser client is connected. Make sure salban.de is open in your browser and connected to local bridge.`
            }
          ],
          isError: true
        };
      }

      const payload = JSON.stringify({
        type: "load_sample",
        padIndex: padIndex,
        data: base64Wav
      });

      let sentCount = 0;
      wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
          sentCount++;
        }
      });

      return {
        content: [
          {
            type: "text",
            text: `Successfully synthesized dynamic '${sampleType}' sample in-memory, converted to Base64 (size: ${base64Wav.length} chars), and broadcasted to Web Browser Client for Pad ${padIndex} (sent to ${sentCount} client(s))!`
          }
        ]
      };
    } catch (e: any) {
      console.error("Error synthesizing audio file:", e);
      return {
        content: [
          {
            type: "text",
            text: `Error during audio synthesis: ${e.message}`
          }
        ],
        isError: true
      };
    }
  }
);


// ─── SHARED HELPERS ────────────────────────────────────────────────────────

/** Broadcast a JSON payload to all open WebSocket clients. Returns the count. */
function broadcastToClients(payload: object): number {
  const json = JSON.stringify(payload);
  let count = 0;
  wss.clients.forEach((client: WebSocket) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
      count++;
    }
  });
  return count;
}

/** Guard: returns an error result if no preset is cached or no client is connected. */
function requirePreset(): { ok: false; result: any } | { ok: true } {
  if (wss.clients.size === 0) {
    return { ok: false, result: { content: [{ type: "text", text: "Error: No browser client connected. Open salban.de first." }], isError: true } };
  }
  if (!currentPresetState) {
    return { ok: false, result: { content: [{ type: "text", text: "Error: No preset cached yet. Interact with the groovebox (e.g. twist a knob) to trigger a sync, then retry." }], isError: true } };
  }
  return { ok: true };
}

/** Deep-clone the cached preset so mutations don't affect the original. */
function clonePreset(): any {
  return JSON.parse(JSON.stringify(currentPresetState));
}

// ─── VOICE ID helpers ───────────────────────────────────────────────────────
const DRUM_VOICES = ["kick", "snare", "hat"] as const;
const SYNTH_VOICES = ["bass", "lead"] as const;
const ALL_VOICES = ["bass", "lead", "kick", "snare", "hat", ...Array.from({ length: 8 }, (_, i) => `pad${i}`)] as const;
type DrumVoice = typeof DRUM_VOICES[number];
type SynthVoice = typeof SYNTH_VOICES[number];

// ─── GRANULAR SEQUENCER TOOLS ───────────────────────────────────────────────

// Tool 6: Read a single voice sequence without loading the full preset
server.tool(
  "salban_get_sequence",
  "Returns only the 16-step sequence for one voice (kick, snare, hat, bass, lead, pad0–pad7). Much faster than salban_get_preset because it returns only the relevant array.",
  {
    voice: z.string().describe("Voice name: kick | snare | hat | bass | lead | pad0 … pad7")
  },
  async ({ voice }: { voice: string }) => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    const seq = currentPresetState.sequences;
    let data: any;

    if (voice === "bass")  data = seq.bass;
    else if (voice === "lead")  data = seq.lead;
    else if (voice === "kick")  data = seq.kick;
    else if (voice === "snare") data = seq.snare;
    else if (voice === "hat")   data = seq.hat;
    else if (/^pad[0-7]$/.test(voice)) {
      const idx = parseInt(voice[3], 10);
      data = seq.pads?.[idx];
    }

    if (!data) {
      return { content: [{ type: "text", text: `Unknown voice: "${voice}". Use kick|snare|hat|bass|lead|pad0–pad7.` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 7: Set 16 steps for a single sampler pad
server.tool(
  "salban_set_pad_sequence",
  "Sets the 16-step sequence for one sampler pad (pad0–pad7). Mutates only that pad's pattern in the cached preset and sends it to the browser instantly.",
  {
    padIndex: z.number().min(0).max(7).describe("Pad index 0–7"),
    steps: z.array(z.object({
      active:  z.boolean().describe("Whether the step triggers"),
      pitch:   z.number().describe("Pitch offset in semitones (e.g. 0, 5, -12)"),
      reverse: z.boolean().describe("Play sample reversed"),
      vol:     z.number().min(0).max(100).describe("Step volume 0–100")
    })).length(16).describe("Exactly 16 step objects")
  },
  async ({ padIndex, steps }: { padIndex: number; steps: { active: boolean; pitch: number; reverse: boolean; vol: number }[] }) => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    const preset = clonePreset();
    if (!preset.sequences?.pads) {
      return { content: [{ type: "text", text: "Error: preset.sequences.pads not found in cached state." }], isError: true };
    }

    preset.sequences.pads[padIndex] = steps;
    currentPresetState = preset;

    const sent = broadcastToClients({ type: "apply_preset", preset });
    return { content: [{ type: "text", text: `Pad ${padIndex} sequence updated and sent to ${sent} client(s).` }] };
  }
);

// Tool 8: Set 16 steps for a drum voice (kick / snare / hat)
server.tool(
  "salban_set_drum_sequence",
  "Sets the 16-step integer pattern for kick, snare, or hat. 0 = off, 1 = normal hit, 2 = accent. (Snare also supports 3 = ghost hit.)",
  {
    voice: z.enum(["kick", "snare", "hat"]).describe("Drum voice to update"),
    steps: z.array(z.number().int().min(0).max(3)).length(16).describe("16 integers: 0=off, 1=normal, 2=accent, 3=ghost")
  },
  async ({ voice, steps }: { voice: DrumVoice; steps: number[] }) => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    const preset = clonePreset();
    preset.sequences[voice] = steps;
    currentPresetState = preset;

    const sent = broadcastToClients({ type: "apply_preset", preset });
    return { content: [{ type: "text", text: `${voice} sequence updated and sent to ${sent} client(s).` }] };
  }
);

// Tool 9: Set 16 steps for a synth voice (bass / lead)
server.tool(
  "salban_set_synth_sequence",
  "Sets the 16-step note sequence for bass or lead. Each step has active, note (e.g. 'D2'), tie, and accent.",
  {
    voice: z.enum(["bass", "lead"]).describe("Synth voice to update"),
    steps: z.array(z.object({
      active: z.boolean(),
      note:   z.string().describe("Note name, e.g. 'D2', 'A3', 'C#2'"),
      tie:    z.boolean(),
      accent: z.boolean()
    })).length(16).describe("Exactly 16 step objects")
  },
  async ({ voice, steps }: { voice: SynthVoice; steps: { active: boolean; note: string; tie: boolean; accent: boolean }[] }) => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    const preset = clonePreset();
    preset.sequences[voice] = steps;
    currentPresetState = preset;

    const sent = broadcastToClients({ type: "apply_preset", preset });
    return { content: [{ type: "text", text: `${voice} sequence updated and sent to ${sent} client(s).` }] };
  }
);

// Tool 10: Set playback parameters for any voice
server.tool(
  "salban_set_voice_params",
  "Sets playback parameters (loop length, speed, direction, transpose) for any voice. All fields are optional — only provided fields are changed.",
  {
    voice: z.string().describe("Voice ID: bass | lead | kick | snare | hat | pad0–pad7"),
    loopLength: z.number().int().min(1).max(16).optional().describe("Active step count 1–16"),
    speed: z.enum(["1/4x", "1/2x", "1x", "2x", "4x"]).optional().describe("Playback speed multiplier"),
    dir: z.enum(["forward", "reverse", "pingpong", "random"]).optional().describe("Playback direction"),
    transpose: z.number().int().optional().describe("Transposition in semitones (bass / lead only)")
  },
  async ({ voice, loopLength, speed, dir, transpose }: {
    voice: string;
    loopLength?: number;
    speed?: string;
    dir?: string;
    transpose?: number;
  }) => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    const preset = clonePreset();
    if (!preset.voices?.[voice]) {
      return { content: [{ type: "text", text: `Voice "${voice}" not found in cached preset. Valid voices: ${Object.keys(preset.voices ?? {}).join(", ")}` }], isError: true };
    }

    const v = preset.voices[voice];
    if (loopLength !== undefined) { v.loopLength = loopLength; v.pendingLoopLength = loopLength; }
    if (speed      !== undefined) { v.speed = speed; v.pendingSpeed = speed; }
    if (dir        !== undefined) { v.dir = dir; }
    if (transpose  !== undefined) { v.transpose = transpose; }

    currentPresetState = preset;
    const sent = broadcastToClients({ type: "apply_preset", preset });
    return { content: [{ type: "text", text: `Voice "${voice}" params updated and sent to ${sent} client(s).` }] };
  }
);

// Tool 11: Clear (silence) all steps of a voice
server.tool(
  "salban_clear_sequence",
  "Silences all 16 steps of a voice in one call. Drum voices are set to 0 (off); synth voices have active=false; pad sequences have active=false.",
  {
    voice: z.string().describe("Voice to clear: kick | snare | hat | bass | lead | pad0–pad7")
  },
  async ({ voice }: { voice: string }) => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    const preset = clonePreset();
    const seq = preset.sequences;

    if (voice === "kick" || voice === "snare" || voice === "hat") {
      seq[voice] = Array(16).fill(0);
    } else if (voice === "bass") {
      seq.bass = seq.bass.map((s: any) => ({ ...s, active: false }));
    } else if (voice === "lead") {
      seq.lead = seq.lead.map((s: any) => ({ ...s, active: false }));
    } else if (/^pad[0-7]$/.test(voice)) {
      const idx = parseInt(voice[3], 10);
      seq.pads[idx] = seq.pads[idx].map((s: any) => ({ ...s, active: false }));
    } else {
      return { content: [{ type: "text", text: `Unknown voice: "${voice}". Use kick|snare|hat|bass|lead|pad0–pad7.` }], isError: true };
    }

    currentPresetState = preset;
    const sent = broadcastToClients({ type: "apply_preset", preset });
    return { content: [{ type: "text", text: `"${voice}" cleared (all steps off) and sent to ${sent} client(s).` }] };
  }
);

const SCHEMA_INFO = {
  lfoTargets: [
    "cutoff", "resonance", "envMod", "decay", "accent", "bassLevel", "bassPan", "bassDelay", "bassReverb", "bassFuzz", "bassSubLevel",
    "leadCutoff", "leadResonance", "leadEnvMod", "leadDecay", "leadAccent", "leadLevel", "leadPan", "leadDelay", "leadReverb", "leadFuzz", "leadSubLevel", "leadWaveMorph",
    "kickTune", "kickDecay", "kickAccent", "snareTone", "snareDecay", "snareAccent", "hatTone", "hatDecay",
    "kickLevel", "kickPan", "snareLevel", "snarePan", "hatLevel", "hatPan",
    "kickDelay", "kickReverb", "kickFuzz", "snareDelay", "snareReverb", "snareFuzz", "hatDelay", "hatReverb", "hatFuzz",
    "smpCutoff", "smpResonance", "smpDecay", "smpStutter", "smpChorus", "smpAmbientSize", "smpAmbientMix", "smpGateWidth",
    "samplerLevel", "samplerPan", "samplerDelay", "samplerReverb", "samplerFuzz",
    "padsLevel", "padsPan", "padsDelay", "padsReverb", "padsFuzz",
    "delayTime", "delayReturn", "reverbSize", "reverbReturn", "fuzzDrive", "fuzzTone", "fuzzReturn",
    "eqLow", "eqMid", "eqHigh", "stereoWidth"
  ],
  tweakablePaths: [
    "tempo",
    "synthParams.filter.cutoff", "synthParams.filter.resonance", "synthParams.filter.env", "synthParams.filter.mode",
    "synthParams.modulation.envMod", "synthParams.modulation.decay", "synthParams.modulation.accent", "synthParams.modulation.waveform",
    "synthParams.lead.cutoff", "synthParams.lead.resonance", "synthParams.lead.envMod", "synthParams.lead.decay", "synthParams.lead.accent", "synthParams.lead.env", "synthParams.lead.subLevel", "synthParams.lead.waveMorph", "synthParams.lead.waveform", "synthParams.lead.currentWavetable",
    "synthParams.drums.kickTune", "synthParams.drums.kickDecay", "synthParams.drums.kickAccent", "synthParams.drums.snareTone", "synthParams.drums.snareDecay", "synthParams.drums.snareAccent", "synthParams.drums.hatTone", "synthParams.drums.hatDecay", "synthParams.drums.shuffleAmount",
    "mixer.bassline.level", "mixer.bassline.pan", "mixer.bassline.dlySend", "mixer.bassline.revSend", "mixer.bassline.fuzSend", "mixer.bassline.mute",
    "mixer.lead.level", "mixer.lead.pan", "mixer.lead.dlySend", "mixer.lead.revSend", "mixer.lead.fuzSend", "mixer.lead.mute",
    "mixer.kick.level", "mixer.kick.pan", "mixer.kick.dlySend", "mixer.kick.revSend", "mixer.kick.fuzSend", "mixer.kick.mute",
    "mixer.snare.level", "mixer.snare.pan", "mixer.snare.dlySend", "mixer.snare.revSend", "mixer.snare.fuzSend", "mixer.snare.mute",
    "mixer.hat.level", "mixer.hat.pan", "mixer.hat.dlySend", "mixer.hat.revSend", "mixer.hat.fuzSend", "mixer.hat.mute",
    "mixer.sampler.level", "mixer.sampler.pan", "mixer.sampler.dlySend", "mixer.sampler.revSend", "mixer.sampler.fuzSend", "mixer.sampler.mute",
    "mixer.pads.level", "mixer.pads.pan", "mixer.pads.dlySend", "mixer.pads.revSend", "mixer.pads.fuzSend", "mixer.pads.mute",
    "fx.delay.time", "fx.delay.return", "fx.delay.on", "fx.delay.synced",
    "fx.reverb.size", "fx.reverb.return", "fx.reverb.on",
    "fx.fuzz.drive", "fx.fuzz.tone", "fx.fuzz.return", "fx.fuzz.on",
    "fx.routing",
    "master.width", "master.filterSweep", "master.threshold", "master.makeupGain", "master.duckAmount", "master.eq.low", "master.eq.mid", "master.eq.high", "master.compressorActive"
  ]
};

// Tool 12: Get parameter schemas and valid LFO targets
server.tool(
  "salban_get_parameter_schema",
  "Returns a list of all valid parameters that can be tweaked using salban_tweak_parameter (dotted keypaths), plus all allowed targets for LFO modulations.",
  {},
  async () => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(SCHEMA_INFO, null, 2)
        }
      ]
    };
  }
);

// Start the MCP Server using stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SAL BAN Monolith Engine MCP Server started successfully and connected to stdio transport");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
