import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer, WebSocket } from "ws";
import { z } from "zod";
import { IncomingMessage } from "http";
import crypto from "crypto";
import fs from "fs";
import path from "path";

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
let currentSongSequencerState: any = null;

// Initialize WebSocket Server with 50MB payload limit and strict client verification
const wss = new WebSocketServer({
  port: WS_PORT,
  maxPayload: 50 * 1024 * 1024, // 50MB payload size limit
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
      if (message.length > 50 * 1024 * 1024) {
        console.error("[WS Security] Received message exceeds 50MB limit. Terminating connection.");
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

      // Handle async responses from the browser client
      if (data && data.type === "response") {
        const requestId = data.requestId;
        const pending = pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(requestId);
          if (data.success) {
            pending.resolve(data.content);
          } else {
            pending.reject(new Error(data.error || "Unknown browser response error"));
          }
        }
        return;
      }

      // Standard message processing (preset updates / states)
      if (data && (data.type === "state_sync" || data.type === "preset_changed")) {
        if (data.preset) {
          // If the incoming preset doesn't have samples, but we already have samples in cache, merge them!
          if (!data.preset.samples && currentPresetState && currentPresetState.samples) {
            data.preset.samples = currentPresetState.samples;
          }
          currentPresetState = data.preset;
        }
        if (data.songSequencer) {
          currentSongSequencerState = data.songSequencer;
        }
        console.error("[WS] Cached preset and song sequencer updated from browser client");
      }

      // Broadcast control messages from other clients (e.g. scripts/AI) to all other clients (e.g. browser)
      if (data && (
        data.type === "load_phrase" ||
        data.type === "load_sample" ||
        data.type === "apply_preset" ||
        data.type === "tweak_parameter" ||
        data.type === "configure_song_pad" ||
        data.type === "clear_song_pad" ||
        data.type === "configure_song_sequencer" ||
        data.type === "trigger_song_pad" ||
        data.type === "set_transport_state" ||
        data.type === "clip_launcher_write_clip" ||
        data.type === "clip_launcher_delete_notes" ||
        data.type === "clip_launcher_quantize" ||
        data.type === "drum_set_autotune" ||
        data.type === "morph32_set_params" ||
        data.type === "morph32_set_poly_sequence"
      )) {
        console.error(`[WS] Received broadcast request for type "${data.type}"`);
        const textMessage = message.toString();
        wss.clients.forEach((client: WebSocket) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(textMessage);
          }
        });
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
  {
    includeSamples: z.boolean().optional().describe("If true, includes full base64 sample data in the preset object. If false (default), strips/omits base64 sample data to reduce payload size.")
  },
  async ({ includeSamples = false }: { includeSamples?: boolean }) => {
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

    let returnedPreset = JSON.parse(JSON.stringify(currentPresetState));
    if (!includeSamples && returnedPreset.samples) {
      if (returnedPreset.samples.pads) {
        for (const padKey in returnedPreset.samples.pads) {
          const pad = returnedPreset.samples.pads[padKey];
          if (pad && pad.data) {
            const sizeKB = Math.round((pad.data.length * 0.75) / 1024);
            returnedPreset.samples.pads[padKey] = {
              hasSample: true,
              name: pad.name,
              sizeKB,
              trimStart: pad.trimStart,
              trimEnd: pad.trimEnd
            };
          }
        }
      }
      if (returnedPreset.samples.phraseSampler && returnedPreset.samples.phraseSampler.data) {
        const sizeKB = Math.round((returnedPreset.samples.phraseSampler.data.length * 0.75) / 1024);
        returnedPreset.samples.phraseSampler = {
          hasSample: true,
          name: returnedPreset.samples.phraseSampler.name,
          sizeKB
        };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(returnedPreset, null, 2)
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

    const payloadSize = Buffer.byteLength(payload, 'utf8');
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB limit
    if (payloadSize > MAX_SIZE) {
      return {
        content: [
          {
            type: "text",
            text: `Error: The preset size (${(payloadSize / 1024 / 1024).toFixed(2)} MB) exceeds the maximum allowed payload size of 50 MB. Make sure samples are trimmed or simplified.`
          }
        ],
        isError: true
      };
    }

    let sentCount = 0;
    wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
        sentCount++;
      }
    });

    // Update server-side cache immediately so salban_get_preset reflects the change
    // without waiting for the browser to send a state_sync message.
    currentPresetState = JSON.parse(JSON.stringify(preset));

    return {
      content: [
        {
          type: "text",
          text: `Successfully broadcasted preset to ${sentCount} connected browser client(s). Server-side cache updated.`
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

    // Mirror the dotted-path mutation into the server-side cache so that
    // salban_get_preset / salban_get_sequence immediately reflect the change.
    let cacheUpdated = false;
    if (currentPresetState) {
      try {
        setNestedPath(currentPresetState, path, value);
        cacheUpdated = true;
      } catch (e: any) {
        // Non-fatal: cache mutation failed (e.g. path not found), browser still received the update.
        console.error(`[tweak_parameter] Could not update cache for path "${path}":`, e.message);
      }
    }

    const cacheNote = cacheUpdated
      ? "Server-side cache updated."
      : `Warning: server-side cache could not be updated for this path (path not found in cached preset) — salban_get_preset may return stale data for this field until the browser syncs again.`;

    return {
      content: [
        {
          type: "text",
          text: `Successfully sent parameter tweak '${path}' = '${value}' to ${sentCount} connected client(s). ${cacheNote}`
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

// Tool 5: Inject Base64 audio sample directly into the central Phrase Sampler
server.tool(
  "salban_load_phrase",
  "Loads a Base64 encoded audio sample (WAV, MP3, etc.) directly into the central Phrase Sampler of the Monolith Engine.",
  {
    data: z.string().describe("The audio file binary data encoded as a Base64 string"),
    name: z.string().optional().describe("Optional display name for the loaded phrase (e.g. 'Drum Loop')")
  },
  async ({ data, name }: { data: string; name?: string }) => {
    if (wss.clients.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Cannot load phrase. No browser client is connected. Open salban.de in a local web browser first."
          }
        ],
        isError: true
      };
    }

    const payload = JSON.stringify({
      type: "load_phrase",
      data,
      name: name || "AI Phrase"
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
          text: `Successfully broadcasted phrase sample injection request to ${sentCount} connected client(s).`
        }
      ]
    };
  }
);

// Tool 6: Synthesize and inject a programmatically generated sample
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

// A registry to handle async request-response over WebSocket
const pendingRequests = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void; timeout: NodeJS.Timeout }>();

function sendRequestToBrowser(type: string, payload: any = {}, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    if (wss.clients.size === 0) {
      return reject(new Error("No browser client connected."));
    }
    const requestId = Math.random().toString(36).substring(2, 15);
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Request to browser timed out."));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timeout });

    broadcastToClients({
      type,
      requestId,
      ...payload
    });
  });
}

function readLocalFile(filename: string): string | null {
  const cleanName = path.basename(filename);
  const pathsToTry = [
    path.resolve(process.cwd(), cleanName),
    path.resolve(process.cwd(), "..", cleanName),
    path.resolve(process.cwd(), "../..", cleanName),
    path.resolve(process.cwd(), "httpdocs", cleanName),
    path.resolve(process.cwd(), "../httpdocs", cleanName),
    path.resolve(process.cwd(), "../../httpdocs", cleanName),
    path.join("/Volumes/Spacestation/virtual-buddy-exchange/Tools-Development/projects/salban.de", cleanName),
    path.join("/Volumes/Spacestation/virtual-buddy-exchange/Tools-Development/projects/salban.de/httpdocs", cleanName),
  ];

  for (const p of pathsToTry) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return fs.readFileSync(p, "utf-8");
      }
    } catch (_) {}
  }
  return null;
}

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

/**
 * Apply a dotted-path (and bracket-notation) mutation to an object in-place.
 * Supports paths like "synthParams.lead.cutoff" and "lfos[0].amount".
 */
function setNestedPath(obj: any, path: string, value: any): void {
  // Normalise bracket notation: lfos[0].amount → lfos.0.amount
  const normalised = path.replace(/\[(\d+)\]/g, '.$1');
  const parts = normalised.split('.');
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cursor[key] === undefined || cursor[key] === null) {
      throw new Error(`Path segment "${key}" not found`);
    }
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
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
const ALL_VOICES = ["bass", "lead", "kick", "snare", "hat", "sampler", ...Array.from({ length: 8 }, (_, i) => `pad${i}`)] as const;
type DrumVoice = typeof DRUM_VOICES[number];
type SynthVoice = typeof SYNTH_VOICES[number];

// ─── GRANULAR SEQUENCER TOOLS ───────────────────────────────────────────────

// Tool 7: Read a single voice sequence without loading the full preset
server.tool(
  "salban_get_sequence",
  "Returns only the 16-step sequence for one voice (kick, snare, hat, bass, lead, sampler, pad0–pad7). Much faster than salban_get_preset because it returns only the relevant array.",
  {
    voice: z.string().describe("Voice name: kick | snare | hat | bass | lead | sampler | pad0 … pad7")
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
    else if (voice === "sampler") data = seq.sampler;
    else if (/^pad[0-7]$/.test(voice)) {
      const idx = parseInt(voice[3], 10);
      data = seq.pads?.[idx];
    }

    if (!data) {
      return { content: [{ type: "text", text: `Unknown voice: "${voice}". Use kick|snare|hat|bass|lead|sampler|pad0–pad7.` }], isError: true };
    }

    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

// Tool 8: Set 16 steps for a single sampler pad
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

// Tool 9: Set 16 steps for the Phrase Sampler (sampler)
server.tool(
  "salban_set_sampler_sequence",
  "Sets the 16-step sequence for the Phrase Sampler. Each step has active, pitch, reverse, tie, and vol.",
  {
    steps: z.array(z.object({
      active:  z.boolean().describe("Whether the step triggers"),
      pitch:   z.number().describe("Pitch offset in semitones (e.g. 0, 5, -12)"),
      reverse: z.boolean().describe("Play sample reversed"),
      tie:     z.boolean().describe("Tie (sustain) into the next step"),
      vol:     z.number().min(0).max(100).describe("Step volume 0–100")
    })).length(16).describe("Exactly 16 step objects")
  },
  async ({ steps }: { steps: { active: boolean; pitch: number; reverse: boolean; tie: boolean; vol: number }[] }) => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    const preset = clonePreset();
    if (!preset.sequences?.sampler) {
      return { content: [{ type: "text", text: "Error: preset.sequences.sampler not found in cached state." }], isError: true };
    }

    preset.sequences.sampler = steps;
    currentPresetState = preset;

    const sent = broadcastToClients({ type: "apply_preset", preset });
    return { content: [{ type: "text", text: `Phrase Sampler sequence updated and sent to ${sent} client(s).` }] };
  }
);

// Tool 10: Set 16 steps for a drum voice (kick / snare / hat)
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

// Tool 11: Set 16 steps for a synth voice (bass / lead)
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

// Tool 12: Set playback parameters for any voice
// Note: "sampler" is a valid voice ID — the Phrase Sampler has its own loop length, speed,
// and direction controls in voiceState on the frontend (preset.voices.sampler).
// Fine-grained sampler FX (cutoff, stutter, etc.) are controlled via salban_tweak_parameter
// using samplerParams.* and synthParams.sampler.* paths.
server.tool(
  "salban_set_voice_params",
  "Sets playback parameters (loop length, speed, direction, transpose) for any voice. All fields are optional — only provided fields are changed.",
  {
    voice: z.string().describe("Voice ID: bass | lead | kick | snare | hat | sampler | pad0–pad7"),
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

// Tool 13: Clear (silence) all steps of a voice
server.tool(
  "salban_clear_sequence",
  "Silences all 16 steps of a voice in one call. Drum voices are set to 0 (off); synth voices have active=false; pad and sampler sequences have active=false.",
  {
    voice: z.string().describe("Voice to clear: kick | snare | hat | bass | lead | sampler | pad0–pad7")
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
    } else if (voice === "sampler") {
      seq.sampler = seq.sampler.map((s: any) => ({ ...s, active: false, tie: false }));
    } else if (/^pad[0-7]$/.test(voice)) {
      const idx = parseInt(voice[3], 10);
      seq.pads[idx] = seq.pads[idx].map((s: any) => ({ ...s, active: false }));
    } else {
      return { content: [{ type: "text", text: `Unknown voice: "${voice}". Use kick|snare|hat|bass|lead|sampler|pad0–pad7.` }], isError: true };
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
    "synthParams.drums.autoTuneKick", "synthParams.drums.autoTuneSnare", "synthParams.drums.autoTuneHat",
    "mixer.bassline.level", "mixer.bassline.pan", "mixer.bassline.dlySend", "mixer.bassline.revSend", "mixer.bassline.fuzSend", "mixer.bassline.mute",
    "mixer.lead.level", "mixer.lead.pan", "mixer.lead.dlySend", "mixer.lead.revSend", "mixer.lead.fuzSend", "mixer.lead.mute",
    "mixer.kick.level", "mixer.kick.pan", "mixer.kick.dlySend", "mixer.kick.revSend", "mixer.kick.fuzSend", "mixer.kick.mute",
    "mixer.snare.level", "mixer.snare.pan", "mixer.snare.dlySend", "mixer.snare.revSend", "mixer.snare.fuzSend", "mixer.snare.mute",
    "mixer.hat.level", "mixer.hat.pan", "mixer.hat.dlySend", "mixer.hat.revSend", "mixer.hat.fuzSend", "mixer.hat.mute",
    "mixer.sampler.level", "mixer.sampler.pan", "mixer.sampler.dlySend", "mixer.sampler.revSend", "mixer.sampler.fuzSend", "mixer.sampler.mute",
    "mixer.pads.level", "mixer.pads.pan", "mixer.pads.dlySend", "mixer.pads.revSend", "mixer.pads.fuzSend", "mixer.pads.mute",
    "mixer.poly.level", "mixer.poly.pan", "mixer.poly.dlySend", "mixer.poly.revSend", "mixer.poly.fuzSend", "mixer.poly.mute",
    "synthParams.sampler.cutoff", "synthParams.sampler.resonance", "synthParams.sampler.decay", "synthParams.sampler.stutter", "synthParams.sampler.chorus", "synthParams.sampler.ambientDecay", "synthParams.sampler.ambientMix", "synthParams.sampler.gateWidth",
    "samplerParams.chop", "samplerParams.raster", "samplerParams.gateActive", "samplerParams.gateRate",
    "synthParams.poly.detune", "synthParams.poly.cutoff", "synthParams.poly.resonance", "synthParams.poly.envMod",
    "synthParams.poly.ampA", "synthParams.poly.ampD", "synthParams.poly.ampS", "synthParams.poly.ampR",
    "synthParams.poly.filtA", "synthParams.poly.filtD", "synthParams.poly.filtS", "synthParams.poly.filtR",
    "synthParams.poly.oscType1", "synthParams.poly.oscType2", "synthParams.poly.oscMix", "synthParams.poly.osc1Footage", "synthParams.poly.osc2Footage",
    "synthParams.poly.ringMod", "synthParams.poly.portamento", "synthParams.poly.filterMode",
    "synthParams.poly.stereoMode", "synthParams.poly.stereoFilterMode", "synthParams.poly.stereoCutoff", "synthParams.poly.stereoSpacing", "synthParams.poly.stereoReso",
    "synthParams.poly.spacingKeyTrack", "synthParams.poly.spacingCycleMod", "synthParams.poly.spacingSpreadMod",
    "synthParams.poly.maxVoices", "synthParams.poly.distributionMode", "synthParams.poly.unisonVoices",
    "fx.delay.time", "fx.delay.return", "fx.delay.on", "fx.delay.synced",
    "fx.reverb.size", "fx.reverb.return", "fx.reverb.on",
    "fx.fuzz.drive", "fx.fuzz.tone", "fx.fuzz.return", "fx.fuzz.on",
    "fx.routing",
    "master.width", "master.filterSweep", "master.threshold", "master.makeupGain", "master.duckAmount", "master.eq.low", "master.eq.mid", "master.eq.high", "master.compressorActive"
  ]
};

// Tool 14: Get parameter schemas and valid LFO targets
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

// Tool 15: Get active Song Preset Sequencer state
server.tool(
  "salban_get_song_sequencer",
  "Returns the currently active cached state of the Song Preset Sequencer from the browser client (active pads, assigned preset names, repeat counts, active pad index, play direction, and auto-chain status).",
  {},
  async () => {
    if (wss.clients.size === 0) {
      return {
        content: [{ type: "text", text: "Error: No browser client is currently connected. Make sure you open salban.de in a local web browser, and verify that the local WebSocket bridge is running." }],
        isError: true
      };
    }
    if (!currentSongSequencerState) {
      return {
        content: [{ type: "text", text: "Notice: The browser client is connected, but no song sequencer state has been synchronized yet. Please interact with the song sequencer (e.g. adjust a repeat count or rename a pad) to trigger a synchronization." }]
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(currentSongSequencerState, null, 2) }]
    };
  }
);

// Tool 16: Configure a pad in the Song Preset Sequencer
server.tool(
  "salban_configure_song_pad",
  "Configures a specific pad in the Song Preset Sequencer. You can assign a new name, adjust its repeat count, capture the current live state of the groovebox, or directly load a specific preset state onto the pad.",
  {
    padId: z.number().min(0).max(7).describe("The ID of the pad to configure (0-7)."),
    name: z.string().optional().describe("Optional new custom name/label for the pad."),
    repeatCount: z.number().min(1).max(99).optional().describe("Optional repeat count (1 to 99) for this pad."),
    captureLiveState: z.boolean().optional().describe("If true, captures the currently running live settings of the groovebox into this pad."),
    preset: z.any().optional().describe("Optional full preset state JSON object to load onto this pad.")
  },
  async ({ padId, name, repeatCount, captureLiveState, preset }) => {
    if (wss.clients.size === 0) {
      return {
        content: [{ type: "text", text: "Error: No browser client is currently connected." }],
        isError: true
      };
    }
    const message = {
      type: "configure_song_pad",
      padId,
      name,
      repeatCount,
      captureLiveState,
      preset
    };
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
    return {
      content: [{ type: "text", text: `Success: Configuration command for Pad ${padId + 1} sent to browser.` }]
    };
  }
);

// Tool 17: Clear a pad in the Song Preset Sequencer
server.tool(
  "salban_clear_song_pad",
  "Clears a preset slot in the Song Preset Sequencer, resetting its name, repeat count, and removing the assigned preset.",
  {
    padId: z.number().min(0).max(7).describe("The ID of the pad to clear (0-7).")
  },
  async ({ padId }) => {
    if (wss.clients.size === 0) {
      return {
        content: [{ type: "text", text: "Error: No browser client is currently connected." }],
        isError: true
      };
    }
    const message = {
      type: "clear_song_pad",
      padId
    };
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
    return {
      content: [{ type: "text", text: `Success: Clear command for Pad ${padId + 1} sent to browser.` }]
    };
  }
);

// Tool 18: Configure global parameters of the Song Preset Sequencer
server.tool(
  "salban_configure_song_sequencer",
  "Updates global settings of the Song Preset Sequencer, such as enabling/disabling Auto-Chain mode or setting the play direction.",
  {
    autoChainEnabled: z.boolean().optional().describe("Toggle Auto-Chain mode."),
    chainDirection: z.enum(["fwd", "rev", "pp", "rnd"]).optional().describe("Set play direction order: 'fwd' (forward), 'rev' (reverse), 'pp' (ping-pong), or 'rnd' (random).")
  },
  async ({ autoChainEnabled, chainDirection }) => {
    if (wss.clients.size === 0) {
      return {
        content: [{ type: "text", text: "Error: No browser client is currently connected." }],
        isError: true
      };
    }
    const message = {
      type: "configure_song_sequencer",
      autoChainEnabled,
      chainDirection
    };
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
    return {
      content: [{ type: "text", text: `Success: Song sequencer global parameters updated.` }]
    };
  }
);

// Tool 19: Trigger a song pad to play or queue
server.tool(
  "salban_trigger_song_pad",
  "Triggers playback of a specific pad in the Song Preset Sequencer immediately, or queues it for the next bar boundary if the sequencer is already running.",
  {
    padId: z.number().min(0).max(7).describe("The ID of the pad to trigger (0-7).")
  },
  async ({ padId }) => {
    if (wss.clients.size === 0) {
      return {
        content: [{ type: "text", text: "Error: No browser client is currently connected." }],
        isError: true
      };
    }
    const message = {
      type: "trigger_song_pad",
      padId
    };
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
    return {
      content: [{ type: "text", text: `Success: Trigger command for Pad ${padId + 1} sent to browser.` }]
    };
  }
);

// Tool 20: Start or stop transport playback
server.tool(
  "salban_set_transport_state",
  "Starts or stops the Monolith Engine sequencer playback transport.",
  {
    playing: z.boolean().describe("Set to true to start playback, or false to stop playback.")
  },
  async ({ playing }) => {
    if (wss.clients.size === 0) {
      return {
        content: [{ type: "text", text: "Error: No browser client is currently connected." }],
        isError: true
      };
    }
    const message = {
      type: "set_transport_state",
      playing
    };
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(message));
      }
    });
    return {
      content: [{ type: "text", text: `Success: Transport state requested: ${playing ? "PLAYING" : "STOPPED"}.` }]
    };
  }
);


// ─── CLIP LAUNCHER TOOLS ────────────────────────────────────────────────────

// Tool 21: Read all clips from the Clip Launcher
server.tool(
  "salban_get_clip_launcher",
  `Returns all clips from the SALBAN Clip Launcher (MIDI Piano Roll sequencer). The Clip Launcher has 3 tracks (poly=Morph32, bass=Bassline, lead=Lead Synth) × 5 scenes each. ClipIndex encoding: poly clips = 0-4, bass clips = 5-9, lead clips = 10-14. Each clip contains piano-roll style notes with pitch (MIDI number), startBeat, duration, and velocity.`,
  {},
  async () => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    const clipsData = currentPresetState?.clipLauncher;
    if (!clipsData) {
      return { content: [{ type: "text", text: "No Clip Launcher data found in the cached preset. Make sure you have interacted with the Clip Launcher in the browser." }] };
    }

    // Handle both flat-array format and object-by-track format
    let summary: any[] = [];
    const TRACKS = ["poly", "bass", "lead"];

    if (Array.isArray(clipsData)) {
      // Legacy flat array: return as-is with indices
      summary = clipsData.map((clip: any, idx: number) => ({
        clipIndex: idx,
        track: TRACKS[Math.floor(idx / 5)] ?? "poly",
        trackName: ["Morph32 (Poly)", "Bassline", "Lead Synth"][Math.floor(idx / 5)] ?? "Poly",
        scene: idx % 5,
        name: clip.name ?? `Clip ${idx + 1}`,
        lengthBars: clip.length ?? clip.lengthBars ?? 1,
        noteCount: Array.isArray(clip.notes) ? clip.notes.length : 0,
        isEmpty: clip.isEmpty ?? (Array.isArray(clip.notes) ? clip.notes.length === 0 : true),
        notes: clip.notes ?? []
      }));
    } else {
      // Object keyed by track name: { poly: [...5], bass: [...5], lead: [...5] }
      TRACKS.forEach((trackName, trackIdx) => {
        const scenes = clipsData[trackName];
        if (!Array.isArray(scenes)) return;
        scenes.forEach((clip: any, sceneIdx: number) => {
          const clipIndex = trackIdx * 5 + sceneIdx;
          summary.push({
            clipIndex,
            track: trackName,
            trackName: ["Morph32 (Poly)", "Bassline", "Lead Synth"][trackIdx],
            scene: sceneIdx,
            name: clip?.name ?? `Clip ${sceneIdx + 1}`,
            lengthBars: clip?.length ?? clip?.lengthBars ?? 1,
            noteCount: Array.isArray(clip?.notes) ? clip.notes.length : 0,
            isEmpty: clip?.isEmpty ?? true,
            notes: (clip?.notes ?? []).map((n: any) => ({
              pitch:         n.note ?? n.pitch,
              startBeat:     n.startBeat,
              durationBeats: n.duration ?? n.durationBeats,
              velocity:      n.velocity ?? 100
            }))
          });
        });
      });
    }

    return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
  }
);

// Tool 22: Write / replace notes in a specific Clip Launcher clip
server.tool(
  "salban_write_clip",
  `Writes (or replaces) the piano-roll notes in a specific Clip Launcher clip. You can set the clip length in bars and beats, and provide an array of note events. Each note has: pitch (MIDI note 0-127 or name like 'C4'), startBeat (float, 0 = bar start), durationBeats (float, e.g. 0.5 = 8th note), velocity (1-127). If notes is an empty array, all notes are cleared. Existing notes in the clip are fully replaced.`,
  {
    clipIndex: z.number().int().min(0).describe("Index of the target clip in the Clip Launcher (0-based)."),
    lengthBars: z.number().int().min(1).max(64).optional().describe("Clip length in bars (e.g. 1, 2, 4, 8). Defaults to current value."),
    lengthBeats: z.number().int().min(1).max(32).optional().describe("Beats per bar (e.g. 4 for 4/4, 3 for 3/4). Defaults to current value."),
    name: z.string().optional().describe("Optional new display name for the clip."),
    notes: z.array(z.object({
      pitch:         z.union([z.number().int().min(0).max(127), z.string()]).describe("MIDI note number 0-127, or note name like 'C4', 'F#3', 'Bb2'."),
      startBeat:     z.number().min(0).describe("Start position in beats from the beginning of the clip (e.g. 0.0, 0.5, 1.0)."),
      durationBeats: z.number().min(0.0625).describe("Note duration in beats (e.g. 0.25=16th, 0.5=8th, 1.0=quarter, 2.0=half)."),
      velocity:      z.number().int().min(1).max(127).optional().describe("MIDI velocity 1-127. Defaults to 100.")
    })).describe("Array of note events. Pass [] to clear all notes.")
  },
  async ({ clipIndex, lengthBars, lengthBeats, name, notes }) => {
    if (wss.clients.size === 0) {
      return { content: [{ type: "text", text: "Error: No browser client connected. Open salban.de first." }], isError: true };
    }

    // Resolve string note names to MIDI numbers
    const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const resolveNote = (p: number | string): number => {
      if (typeof p === "number") return p;
      const m = p.match(/^([A-Ga-g]#?b?)(-?\d+)$/);
      if (!m) throw new Error(`Invalid note name: "${p}"`);
      let name = m[1].replace("b", "#"); // enharmonic simplification
      // handle flat: Bb → A#, Eb → D#, Ab → G#, Db → C#, Gb → F#
      const flatMap: Record<string,string> = { "Ab":"G#", "Bb":"A#", "Cb":"B", "Db":"C#", "Eb":"D#", "Fb":"E", "Gb":"F#" };
      if (flatMap[m[1]]) name = flatMap[m[1]];
      const octave = parseInt(m[2], 10);
      const noteIdx = NOTE_NAMES.indexOf(name.toUpperCase());
      if (noteIdx === -1) throw new Error(`Unknown note: "${p}"`);
      return (octave + 1) * 12 + noteIdx;
    };

    let resolvedNotes: any[];
    try {
      resolvedNotes = notes.map(n => ({
        pitch:         resolveNote(n.pitch),
        startBeat:     n.startBeat,
        durationBeats: n.durationBeats,
        velocity:      n.velocity ?? 100
      }));
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error resolving note names: ${e.message}` }], isError: true };
    }

    const payload = {
      type: "clip_launcher_write_clip",
      clipIndex,
      lengthBars,
      lengthBeats,
      name,
      notes: resolvedNotes
    };
    const sent = broadcastToClients(payload);

    // Mirror into cache if clipLauncher array exists
    if (currentPresetState?.clipLauncher?.[clipIndex]) {
      const clip = currentPresetState.clipLauncher[clipIndex];
      if (lengthBars  !== undefined) clip.lengthBars  = lengthBars;
      if (lengthBeats !== undefined) clip.lengthBeats = lengthBeats;
      if (name        !== undefined) clip.name        = name;
      clip.notes = resolvedNotes;
    }

    return { content: [{ type: "text", text: `Clip ${clipIndex} updated with ${resolvedNotes.length} note(s) and sent to ${sent} client(s).` }] };
  }
);

// Tool 23: Delete specific notes from a clip by pitch or beat range
server.tool(
  "salban_delete_clip_notes",
  `Deletes notes from a Clip Launcher clip by pitch, beat range, or both. If no filters are given, ALL notes in the clip are deleted. Useful for erasing a specific octave, a specific beat position, or a chord.`,
  {
    clipIndex:     z.number().int().min(0).describe("Target clip index (0-based)."),
    pitch:         z.union([z.number().int().min(0).max(127), z.string()]).optional().describe("If set, only notes with this exact pitch (MIDI number or name like 'C4') are deleted."),
    startBeatMin:  z.number().optional().describe("If set, only notes starting at or after this beat are deleted."),
    startBeatMax:  z.number().optional().describe("If set, only notes starting at or before this beat are deleted.")
  },
  async ({ clipIndex, pitch, startBeatMin, startBeatMax }) => {
    const payload = {
      type: "clip_launcher_delete_notes",
      clipIndex,
      pitch,
      startBeatMin,
      startBeatMax
    };
    const sent = broadcastToClients(payload);
    return { content: [{ type: "text", text: `Delete notes command sent for clip ${clipIndex} to ${sent} client(s).` }] };
  }
);

// Tool 24: Quantize notes in a clip
server.tool(
  "salban_quantize_clip",
  `Quantizes (snaps) note start times in a Clip Launcher clip to the nearest musical grid value. Optionally restricts quantization to a beat range or specific pitch. The quantize grid is expressed in beats (e.g. 0.25 = 16th note, 0.5 = 8th note, 1.0 = quarter note).`,
  {
    clipIndex:    z.number().int().min(0).describe("Target clip index (0-based)."),
    gridBeats:    z.number().min(0.0625).describe("Quantize grid resolution in beats (0.0625=64th, 0.125=32nd, 0.25=16th, 0.5=8th, 1.0=quarter)."),
    strength:     z.number().min(0).max(1).optional().describe("Quantize strength 0.0–1.0 (1.0 = full snap, 0.5 = halfway). Default: 1.0."),
    startBeatMin: z.number().optional().describe("Only quantize notes starting at or after this beat."),
    startBeatMax: z.number().optional().describe("Only quantize notes starting at or before this beat.")
  },
  async ({ clipIndex, gridBeats, strength, startBeatMin, startBeatMax }) => {
    const payload = {
      type: "clip_launcher_quantize",
      clipIndex,
      gridBeats,
      strength: strength ?? 1.0,
      startBeatMin,
      startBeatMax
    };
    const sent = broadcastToClients(payload);
    return { content: [{ type: "text", text: `Quantize command (grid=${gridBeats} beats, strength=${strength ?? 1.0}) sent for clip ${clipIndex} to ${sent} client(s).` }] };
  }
);

// ─── DRUM AUTO-TUNE TOOL ─────────────────────────────────────────────────────

// Tool 25: Set drum auto-tune target track
server.tool(
  "salban_set_drum_autotune",
  `Sets the auto-tune mode for a drum voice (kick, snare, or hat). When active, the drum pitch tracks the notes of the specified sequencer track in real-time. The snare uses the 10th overtone (10x multiplier) folded to 2000-5000 Hz for the rattle filter. Kick folds to 30-75 Hz. Hat folds to 6000-11000 Hz. Set to 'off' to disable auto-tuning.`,
  {
    voice:       z.enum(["kick", "snare", "hat"]).describe("The drum voice to configure auto-tune for."),
    targetTrack: z.enum(["off", "bass", "lead", "poly"]).describe("Target track to track pitch from: 'off'=disabled, 'bass'=Bassline, 'lead'=Lead Synth, 'poly'=Morph32.")
  },
  async ({ voice, targetTrack }) => {
    if (wss.clients.size === 0) {
      return { content: [{ type: "text", text: "Error: No browser client connected. Open salban.de first." }], isError: true };
    }

    // Send as a tweak_parameter so the browser's parameter-bridge handles it with validation
    const path = `synthParams.drums.autoTune${voice.charAt(0).toUpperCase() + voice.slice(1)}`;
    const tweetPayload = { type: "tweak_parameter", path, value: targetTrack };
    const sent = broadcastToClients(tweetPayload);

    // Also update local cache
    if (currentPresetState?.synthParams?.drums) {
      (currentPresetState.synthParams.drums as any)[`autoTune${voice.charAt(0).toUpperCase() + voice.slice(1)}`] = targetTrack;
    }

    const statusMsg = targetTrack === "off"
      ? `Drum auto-tune DISABLED for ${voice}.`
      : `Drum auto-tune for ${voice} set to track '${targetTrack}' sequence.`;

    return { content: [{ type: "text", text: `${statusMsg} Sent to ${sent} client(s).` }] };
  }
);

// ─── MORPH32 TOOLS ──────────────────────────────────────────────────────────

// Tool 26: Get Morph32 synthesizer state
server.tool(
  "salban_get_morph32",
  `Returns the full current state of the Morph32 8-voice polyphonic synthesizer. Includes oscillator types (oscType1/oscType2: sawtooth|square|triangle|sine|noise|wavetable), oscillator mix, footage (octave: '8', '16', '32'), dual stereo filter (filterMode, stereoMode, stereoCutoff, stereoSpacing, stereoReso), amplitude ADSR envelope (ampA/D/S/R), filter envelope (filtA/D/filtS/filtR), envMod, detune, portamento, ring modulation, voice distribution (chord/unison), max active voices (8/16/32), and the current Morph32 piano-roll sequence. Also returns the LFO assignments relevant to the poly voice.`,
  {},
  async () => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    const poly = currentPresetState?.synthParams?.poly ?? {};
    const polySeq = currentPresetState?.sequences?.poly ?? [];
    const polyMixer = currentPresetState?.mixer?.poly ?? {};
    const lfos = currentPresetState?.lfos ?? [];

    const result = {
      oscillators: {
        oscType1:    poly.oscType1    ?? "sawtooth",
        oscType2:    poly.oscType2    ?? "sawtooth",
        oscMix:      poly.oscMix      ?? 0.5,
        osc1Footage: poly.osc1Footage ?? "16",
        osc2Footage: poly.osc2Footage ?? "16",
        ringMod:     poly.ringMod     ?? 0
      },
      filter: {
        filterMode:       poly.filterMode       ?? "lowpass",
        cutoff:           poly.cutoff           ?? 1000,
        resonance:        poly.resonance        ?? 0,
        envMod:           poly.envMod           ?? 0,
        filtA:            poly.filtA            ?? 0.01,
        filtD:            poly.filtD            ?? 0.3,
        filtS:            poly.filtS            ?? 0.5,
        filtR:            poly.filtR            ?? 0.3
      },
      stereoFilter: {
        stereoMode:       poly.stereoMode       ?? "off",
        stereoFilterMode: poly.stereoFilterMode ?? "lowpass",
        stereoCutoff:     poly.stereoCutoff     ?? 1000,
        stereoSpacing:    poly.stereoSpacing    ?? 0,
        stereoReso:       poly.stereoReso       ?? 0,
        spacingKeyTrack:  poly.spacingKeyTrack  ?? 0,
        spacingCycleMod:  poly.spacingCycleMod  ?? 0,
        spacingSpreadMod: poly.spacingSpreadMod ?? 0
      },
      ampEnvelope: {
        ampA: poly.ampA ?? 0.01,
        ampD: poly.ampD ?? 0.3,
        ampS: poly.ampS ?? 0.8,
        ampR: poly.ampR ?? 0.3
      },
      voice: {
        detune:           poly.detune           ?? 0,
        portamento:       poly.portamento       ?? 0,
        maxVoices:        poly.maxVoices        ?? 8,
        distributionMode: poly.distributionMode ?? "chord",
        unisonVoices:     poly.unisonVoices     ?? 1
      },
      mixer: polyMixer,
      sequence: {
        stepCount:    polySeq.length,
        steps:        polySeq
      },
      lfoAssignments: lfos.filter((lfo: any) =>
        typeof lfo?.target === "string" && lfo.target.toLowerCase().includes("poly")
      )
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 27: Configure Morph32 synthesizer parameters
server.tool(
  "salban_set_morph32_params",
  `Configures one or more parameters of the Morph32 8-voice polyphonic synthesizer. All fields are optional — only provided fields are changed. Oscillator types: sawtooth|square|triangle|sine|noise|wavetable. Footage (octave select): '8'|'16'|'32'. Filter modes: lowpass|highpass. Stereo modes: off|spread|mirror. Distribution: chord|unison. Max voices: 8|16|32. All numeric values are in the same units as the groovebox knobs (e.g. cutoff in Hz 20-20000, envelope times in seconds 0.001-4.0, detune in cents 0-100, etc.).`,
  {
    // Oscillators
    oscType1:        z.enum(["sawtooth","square","triangle","sine","noise","wavetable"]).optional().describe("Oscillator 1 waveform type."),
    oscType2:        z.enum(["sawtooth","square","triangle","sine","noise","wavetable"]).optional().describe("Oscillator 2 waveform type."),
    oscMix:          z.number().min(0).max(1).optional().describe("Oscillator blend 0.0 (100% OSC1) to 1.0 (100% OSC2)."),
    osc1Footage:     z.enum(["8","16","32"]).optional().describe("OSC1 octave selector: '8'=super-low, '16'=normal, '32'=sub."),
    osc2Footage:     z.enum(["8","16","32"]).optional().describe("OSC2 octave selector."),
    ringMod:         z.number().min(0).max(100).optional().describe("Ring modulation amount (0=off, 100=full)."),
    // Main filter
    filterMode:      z.enum(["lowpass","highpass"]).optional().describe("Main filter type."),
    cutoff:          z.number().min(20).max(20000).optional().describe("Filter cutoff frequency in Hz."),
    resonance:       z.number().min(0).max(100).optional().describe("Filter resonance 0-100."),
    envMod:          z.number().min(-100).max(100).optional().describe("Filter envelope modulation depth."),
    // Filter envelope
    filtA:           z.number().min(0.001).max(4).optional().describe("Filter attack time in seconds."),
    filtD:           z.number().min(0.001).max(4).optional().describe("Filter decay time in seconds."),
    filtS:           z.number().min(0).max(1).optional().describe("Filter sustain level 0.0-1.0."),
    filtR:           z.number().min(0.001).max(4).optional().describe("Filter release time in seconds."),
    // Amp envelope
    ampA:            z.number().min(0.001).max(4).optional().describe("Amplitude attack time in seconds."),
    ampD:            z.number().min(0.001).max(4).optional().describe("Amplitude decay time in seconds."),
    ampS:            z.number().min(0).max(1).optional().describe("Amplitude sustain level 0.0-1.0."),
    ampR:            z.number().min(0.001).max(4).optional().describe("Amplitude release time in seconds."),
    // Stereo filter
    stereoMode:      z.enum(["off","spread","mirror"]).optional().describe("Stereo filter mode."),
    stereoFilterMode: z.enum(["lowpass","highpass"]).optional().describe("Stereo filter type."),
    stereoCutoff:    z.number().min(20).max(20000).optional().describe("Stereo filter cutoff in Hz."),
    stereoSpacing:   z.number().min(0).max(100).optional().describe("Stereo filter spacing 0-100."),
    stereoReso:      z.number().min(0).max(100).optional().describe("Stereo filter resonance 0-100."),
    spacingKeyTrack: z.number().min(0).max(100).optional().describe("Stereo spacing key-tracking amount 0-100."),
    spacingCycleMod: z.number().min(0).max(100).optional().describe("Stereo spacing cycle modulation 0-100."),
    spacingSpreadMod: z.number().min(0).max(100).optional().describe("Stereo spacing spread modulation 0-100."),
    // Voice
    detune:          z.number().min(0).max(100).optional().describe("Voice detune in cents 0-100."),
    portamento:      z.number().min(0).max(1).optional().describe("Portamento glide time in seconds."),
    maxVoices:       z.enum(["8","16","32"]).optional().describe("Maximum simultaneous voices: '8', '16', or '32'."),
    distributionMode: z.enum(["chord","unison"]).optional().describe("Voice distribution: 'chord'=polyphonic, 'unison'=stacked."),
    unisonVoices:    z.number().int().min(1).max(4).optional().describe("Number of unison voices stacked per note (1-4, only used when distributionMode='unison')."),
    // Mixer
    level:           z.number().min(0).max(100).optional().describe("Morph32 output level 0-100."),
    pan:             z.number().min(-100).max(100).optional().describe("Pan position -100 (L) to 100 (R)."),
    dlySend:         z.number().min(0).max(100).optional().describe("Delay send amount 0-100."),
    revSend:         z.number().min(0).max(100).optional().describe("Reverb send amount 0-100."),
    fuzSend:         z.number().min(0).max(100).optional().describe("Fuzz send amount 0-100.")
  },
  async (params) => {
    if (wss.clients.size === 0) {
      return { content: [{ type: "text", text: "Error: No browser client connected. Open salban.de first." }], isError: true };
    }

    const tweakMap: Record<string, string> = {
      oscType1: "synthParams.poly.oscType1", oscType2: "synthParams.poly.oscType2",
      oscMix: "synthParams.poly.oscMix", osc1Footage: "synthParams.poly.osc1Footage", osc2Footage: "synthParams.poly.osc2Footage",
      ringMod: "polyRingMod",
      filterMode: "synthParams.poly.filterMode",
      cutoff: "polyCutoff", resonance: "polyResonance", envMod: "polyEnvMod",
      filtA: "polyFiltA", filtD: "polyFiltD", filtS: "polyFiltS", filtR: "polyFiltR",
      ampA: "polyAmpA", ampD: "polyAmpD", ampS: "polyAmpS", ampR: "polyAmpR",
      stereoMode: "synthParams.poly.stereoMode", stereoFilterMode: "synthParams.poly.stereoFilterMode",
      stereoCutoff: "polyStereoCutoff", stereoSpacing: "polyStereoSpacing", stereoReso: "polyStereoReso",
      spacingKeyTrack: "polySpacingKeyTrack", spacingCycleMod: "polySpacingCycleMod", spacingSpreadMod: "polySpacingSpreadMod",
      detune: "polyDetune", portamento: "polyPortamento",
      maxVoices: "synthParams.poly.maxVoices", distributionMode: "synthParams.poly.distributionMode", unisonVoices: "synthParams.poly.unisonVoices",
      level: "mixer.poly.level", pan: "mixer.poly.pan", dlySend: "mixer.poly.dlySend", revSend: "mixer.poly.revSend", fuzSend: "mixer.poly.fuzSend"
    };

    let sentCount = 0;
    const changes: string[] = [];

    for (const [key, rawVal] of Object.entries(params)) {
      if (rawVal === undefined || rawVal === null) continue;
      const path = tweakMap[key];
      if (!path) continue;

      const value = key === "maxVoices" ? parseInt(rawVal as string, 10) : rawVal;
      broadcastToClients({ type: "tweak_parameter", path, value });
      sentCount++;
      changes.push(`${path} = ${value}`);

      // Update cache
      if (currentPresetState) {
        try { setNestedPath(currentPresetState, path, value); } catch (_) {}
      }
    }

    if (changes.length === 0) {
      return { content: [{ type: "text", text: "No parameters were provided. Nothing changed." }] };
    }

    return { content: [{ type: "text", text: `Morph32: applied ${changes.length} parameter(s):\n${changes.join("\n")}` }] };
  }
);

// Tool 28: Set Morph32 polyphonic piano-roll sequence
server.tool(
  "salban_set_morph32_sequence",
  `Sets the polyphonic step-sequencer pattern for the Morph32 synthesizer. Each step can hold multiple simultaneous notes (a chord). Steps have: notes (array of note names/numbers), active (bool), tie (bool for sustain into next step), accent (bool for velocity boost). Use up to 16 steps. Pass an empty notes array for a rest step.`,
  {
    steps: z.array(z.object({
      active:  z.boolean().describe("Whether this step triggers."),
      notes:   z.array(z.union([z.string(), z.number().int().min(0).max(127)])).describe("Notes to play as a chord (e.g. ['C3','E3','G3'] or [48,52,55]). Empty array = rest."),
      tie:     z.boolean().optional().describe("Sustain into next step (no retrigger)."),
      accent:  z.boolean().optional().describe("Accent (velocity boost).")
    })).min(1).max(16).describe("1 to 16 step objects defining the Morph32 sequence.")
  },
  async ({ steps }) => {
    const guard = requirePreset();
    if (!guard.ok) return guard.result;

    // Resolve note names to strings (keep as-is if already strings, normalize if numbers)
    const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
    const midiToName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

    const resolvedSteps = steps.map(step => ({
      active: step.active,
      notes: (step.notes ?? []).map((n: string | number) =>
        typeof n === "number" ? midiToName(n) : n
      ),
      tie:    step.tie    ?? false,
      accent: step.accent ?? false
    }));

    const preset = clonePreset();
    preset.sequences.poly = resolvedSteps;
    currentPresetState = preset;

    const sent = broadcastToClients({ type: "apply_preset", preset });
    return { content: [{ type: "text", text: `Morph32 sequence set (${resolvedSteps.length} steps) and sent to ${sent} client(s).` }] };
  }
);

// Tool 29: Get active MIDI configuration
server.tool(
  "salban_get_midi_config",
  "Returns the current MIDI configuration of the SAL BAN Monolith Engine. This includes active/connected MIDI input and output devices, channel routing assignments, Omni routing target, and the default CC mapping layout.",
  {},
  async () => {
    if (wss.clients.size === 0) {
      return { content: [{ type: "text", text: "Error: No browser client connected. Open salban.de first." }], isError: true };
    }
    
    const config = currentPresetState?.midiConfig || {
      channelRouting: {},
      omniRoute: "off",
      inputs: [],
      outputs: []
    };

    const defaultCcLayout = {
      "30": "Bass Mute (On/Off)",
      "31": "Bass Level (0-127)",
      "32": "Bass Cutoff (0-127)",
      "33": "Bass Resonance (0-127)",
      "34": "Bass Decay (0-127)",
      "35": "Bass Envelope Mod (0-127)",
      "42": "Lead Mute (On/Off)",
      "43": "Lead Level (0-127)",
      "44": "Lead Cutoff (0-127)",
      "45": "Lead Resonance (0-127)",
      "46": "Lead Decay (0-127)",
      "47": "Lead Envelope Mod (0-127)",
      "115": "Poly Mute (On/Off)",
      "116": "Poly Level (0-127)",
      "117": "Poly Cutoff (0-127)",
      "118": "Poly Resonance (0-127)",
      "119": "Poly Attack (0-127)",
      "120": "Poly Decay (0-127)"
    };

    const result = {
      activeMidiInputs: config.inputs || [],
      activeMidiOutputs: config.outputs || [],
      channelRouting: config.channelRouting || {},
      omniRoute: config.omniRoute || "off",
      defaultCcMappings: defaultCcLayout,
      helpText: "To route a physical MIDI controller, connect it via USB. The browser automatically detects it. Route specific MIDI channels (1-16) to synth engines using salban_configure_midi, or use Omni mode to route all incoming channels to a single voice."
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 30: Configure MIDI settings
server.tool(
  "salban_configure_midi",
  "Configures MIDI routing settings. You can set the Omni routing target or route individual MIDI channels (1-16) to specific synthesizer voices.",
  {
    omniRoute: z.enum(["off", "lead", "bass", "sampler", "poly"]).optional().describe("Set global Omni routing target."),
    channel: z.number().int().min(1).max(16).optional().describe("Specific MIDI channel (1-16) to configure."),
    target: z.enum(["off", "lead", "bass", "sampler", "poly"]).optional().describe("Target voice for the configured channel (required if channel is specified).")
  },
  async ({ omniRoute, channel, target }) => {
    if (wss.clients.size === 0) {
      return { content: [{ type: "text", text: "Error: No browser client connected. Open salban.de first." }], isError: true };
    }

    if (omniRoute) {
      broadcastToClients({ type: "midi_set_omni_route", route: omniRoute });
      if (currentPresetState && currentPresetState.midiConfig) {
        currentPresetState.midiConfig.omniRoute = omniRoute;
      }
      return { content: [{ type: "text", text: `MIDI Omni Route configured to: ${omniRoute}` }] };
    }

    if (channel !== undefined) {
      if (!target) {
        return { content: [{ type: "text", text: "Error: 'target' parameter is required when 'channel' is specified." }], isError: true };
      }
      broadcastToClients({ type: "midi_set_channel_route", channel, target });
      if (currentPresetState && currentPresetState.midiConfig && currentPresetState.midiConfig.channelRouting) {
        currentPresetState.midiConfig.channelRouting[channel.toString()] = target;
      }
      return { content: [{ type: "text", text: `MIDI Channel ${channel} configured to: ${target}` }] };
    }

    return { content: [{ type: "text", text: "Error: Must specify either 'omniRoute' or 'channel' + 'target'." }], isError: true };
  }
);

// Tool 31: Read website page or markdown file contents
server.tool(
  "salban_read_website_content",
  "Reads the text contents of the website files (like index.html, mcp-jam.html, midi-jam.html, architecture_and_status.md, etc.) to understand the background, updates, or configuration details of the Sal Ban synthesizer project.",
  {
    path: z.string().describe("The relative file path or filename to read (e.g. 'index.html', 'midi-jam.html', 'mcp-jam.html', 'architecture_and_status.md', 'llms.txt').")
  },
  async ({ path: filePath }) => {
    // 1. Try to read locally first
    const localContent = readLocalFile(filePath);
    if (localContent !== null) {
      return { content: [{ type: "text", text: localContent }] };
    }

    // 2. Fallback to requesting via browser WebSocket
    if (wss.clients.size === 0) {
      return { 
        content: [{ type: "text", text: `Error: File '${filePath}' not found locally, and no browser client is connected for remote fetch fallback.` }], 
        isError: true 
      };
    }

    try {
      const content = await sendRequestToBrowser("get_dom_content", { path: filePath });
      return { content: [{ type: "text", text: content }] };
    } catch (err: any) {
      return { 
        content: [{ type: "text", text: `Error reading file '${filePath}': ${err.message}` }], 
        isError: true 
      };
    }
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
