import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

const app = express();
// Health check endpoints
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) => res.send("healthy"));

// Twilio Voice webhook endpoint
app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wssUrl = `wss://${host}/media`;
  console.log("[VOICE] Incoming call, redirecting to WSS:", wssUrl);
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
    <response>
      <connect>
        <stream url="${wssUrl}"></stream>
      </connect>
    </response>`);
});

const server = http.createServer(app);
// Disable timeouts to prevent premature disconnections
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
server.requestTimeout = 0;

const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade
server.on("upgrade", (req, socket, head) => {
  const isWS = (req.headers.upgrade || "").toLowerCase() === "websocket";
  if (!isWS || !req.url?.startsWith("/media")) {
    socket.destroy();
    return;
  }
  console.log("[UPGRADE] WebSocket upgrade request for", req.url);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  console.log("[WS] Connected from", req.socket.remoteAddress);

  let streamSid = null;
  let callSid = null;
  let openaiWs = null;

  // NEW: media buffering and early start handling
  let mediaBuffer = [] as string[];
  let gotStart = false;
  let openaiStarted = false;
  let greetingSent = false;

  // OpenAI Realtime API configuration
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Default Rachel voice

  // Connect to OpenAI Realtime API
  function connectToOpenAI() {
    if (!OPENAI_API_KEY) {
      console.error("[OPENAI] API key not configured");
      return;
    }
    const openaiUrl = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01";
    openaiWs = new WebSocket(openaiUrl, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });
    openaiWs.on("open", () => {
      console.log("[OPENAI] Connected to Realtime API");
      // Configure session
      openaiWs!.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions:
              "You are a helpful AI voice receptionist. Greet callers warmly and assist them with their inquiries.",
            voice: "alloy",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
            },
          },
        })
      );
      console.log("[OPENAI] Session configured");

      // If we had buffered Twilio audio before 'start', flush it now
      if (mediaBuffer.length) {
        console.log("[OPENAI] Flushing", mediaBuffer.length, "buffered media chunks to OpenAI");
        for (const payload of mediaBuffer) {
          openaiWs!.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio: payload })
          );
        }
        openaiWs!.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        mediaBuffer = [];
      }
      openaiStarted = true;
    });

    openaiWs.on("message", async (data) => {
      try {
        const event = JSON.parse(data.toString());
        console.log("[OPENAI] Event:", event.type);
        switch (event.type) {
          case "session.created":
          case "session.updated":
            console.log("[OPENAI] Session ready:", event.session?.id);
            break;
          case "response.audio.delta":
            // Receive audio chunks from OpenAI
            if (event.delta && streamSid) {
              console.log("[OPENAI] Audio delta received, length:", event.delta.length);
              sendAudioToTwilio(event.delta);
            }
            break;
          case "response.audio.done":
            console.log("[OPENAI] Audio response complete");
            break;
          case "response.text.delta":
            console.log("[OPENAI] Text delta:", event.delta);
            break;
          case "response.text.done":
            console.log("[OPENAI] Text response:", event.text);
            // Optional: Use ElevenLabs for TTS
            if (ELEVENLABS_API_KEY && event.text) {
              await generateElevenLabsAudio(event.text);
            }
            break;
          case "response.done":
            console.log("[OPENAI] Response completed:", event.response?.id);
            break;
          case "input_audio_buffer.speech_started":
            console.log("[OPENAI] Speech started detected");
            break;
          case "input_audio_buffer.speech_stopped":
            console.log("[OPENAI] Speech stopped detected");
            break;
          case "conversation.item.input_audio_transcription.completed":
            console.log("[OPENAI] Transcription:", event.transcript);
            break;
          case "error":
            console.error("[OPENAI] Error:", event.error);
            break;
          default:
            console.log("[OPENAI] Unhandled event:", event.type);
        }
      } catch (err: any) {
        console.error("[OPENAI] Error parsing message:", err.message);
      }
    });

    openaiWs.on("error", (err: any) => {
      console.error("[OPENAI] WebSocket error:", err.message);
    });
    openaiWs.on("close", () => {
      console.log("[OPENAI] Connection closed");
    });
  }

  // Send audio to Twilio
  function sendAudioToTwilio(base64Audio: string) {
    if (!streamSid) {
      console.warn("[TWILIO] No streamSid, cannot send audio");
      return;
    }
    try {
      const mediaMessage = {
        event: "media",
        streamSid: streamSid,
        media: { payload: base64Audio },
      };
      ws.send(JSON.stringify(mediaMessage));
      console.log("[TWILIO] Audio sent, length:", base64Audio.length);
    } catch (err: any) {
      console.error("[TWILIO] Error sending audio:", err.message);
    }
  }

  // Generate audio using ElevenLabs TTS
  async function generateElevenLabsAudio(text: string) {
    if (!ELEVENLABS_API_KEY) {
      console.warn("[ELEVENLABS] API key not configured");
      return;
    }
    try {
      console.log("[ELEVENLABS] Generating audio for text:", text.substring(0, 50) + "...");
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
        {
          method: "POST",
          headers: {
            Accept: "audio/mpeg",
            "xi-api-key": ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text,
            model_id: "eleven_monolingual_v1",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );
      if (!response.ok) {
        throw new Error(`ElevenLabs API error: ${response.status}`);
      }
      console.log("[ELEVENLABS] Audio received, streaming to Twilio");
      const audioBuffer = await response.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString("base64");
      sendAudioToTwilio(base64Audio);
      console.log("[ELEVENLABS] Audio streaming complete");
    } catch (err: any) {
      console.error("[ELEVENLABS] Error:", err.message);
    }
  }

  // Fallback: greeting or early OpenAI start to avoid silence
  async function ensureNoSilenceFallback() {
    try {
      if (!openaiStarted && OPENAI_API_KEY) {
        console.log("[FALLBACK] Starting OpenAI session early due to early media");
        connectToOpenAI();
      }
      if (!greetingSent) {
        greetingSent = true;
        console.log("[FALLBACK] Sending early greeting audio to caller");
        // Simple 200ms of silence base64 PCM16 can be used, or use ElevenLabs if available
        // Prefer ElevenLabs short greeting for a natural prompt
        if (ELEVENLABS_API_KEY) {
          await generateElevenLabsAudio(
            "Hello, this is your AI receptionist. I'm listening. How can I help you today?"
          );
        } else {
          // Send a minimal beep-like PCM payload (optional noop if not supported)
          // No-op here to avoid incompatible payloads; logs suffice.
        }
      }
    } catch (e) {
      console.error("[FALLBACK] Error running fallback:", (e as any).message || e);
    }
  }

  // Keepalive ping
  const ka = setInterval(() => {
    try {
      ws.ping();
    } catch {}
  }, 10000);
  ws.on("pong", () => {});

  // Handle incoming Twilio messages
  ws.on("message", (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      console.log("[TWILIO] Event:", msg.event);
      switch (msg.event) {
        case "connected":
          console.log("[TWILIO] Connected");
          break;
        case "start":
          gotStart = true;
          streamSid = msg.start?.streamSid;
          callSid = msg.start?.callSid;
          console.log("[TWILIO] Stream started - streamSid:", streamSid, "callSid:", callSid);
          console.log("[TWILIO] Media format:", JSON.stringify(msg.start?.mediaFormat));

          // Connect to OpenAI when stream starts (if not started already)
          if (!openaiStarted) connectToOpenAI();

          // If any media was buffered before start, flush it to OpenAI now
          if (openaiWs && mediaBuffer.length) {
            console.log("[TWILIO→OPENAI] Flushing", mediaBuffer.length, "buffered chunks post-start");
            for (const payload of mediaBuffer) {
              openaiWs.send(
                JSON.stringify({ type: "input_audio_buffer.append", audio: payload })
              );
            }
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            mediaBuffer = [];
          }
          break;
        case "media":
          // If media arrives before 'start', buffer and trigger fallback to avoid silence
          if (!gotStart) {
            if (msg.media?.payload) mediaBuffer.push(msg.media.payload);
            console.log("[TWILIO] Media received before start. Buffered chunks:", mediaBuffer.length);
            ensureNoSilenceFallback();
            break;
          }

          // Forward audio to OpenAI Realtime API
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN && msg.media?.payload) {
            const audioAppend = { type: "input_audio_buffer.append", audio: msg.media.payload };
            openaiWs.send(JSON.stringify(audioAppend));
            console.log(
              "[TWILIO→OPENAI] Audio forwarded, payload length:",
              msg.media.payload.length
            );
          } else if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
            // Buffer until OpenAI is ready
            if (msg.media?.payload) mediaBuffer.push(msg.media.payload);
            console.log(
              "[BUFFER] OpenAI not ready. Buffered chunks:",
              mediaBuffer.length
            );
          }
          break;
        case "stop":
          console.log("[TWILIO] Stream stopped");
          if (openaiWs) {
            openaiWs.close();
          }
          break;
        default:
          console.log("[TWILIO] Unhandled event:", msg.event, JSON.stringify(msg).substring(0, 100));
      }
    } catch (err: any) {
      console.error("[TWILIO] Error parsing message:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Connection closed");
    clearInterval(ka);
    if (openaiWs) {
      openaiWs.close();
    }
  });
  ws.on("error", (err) => {
    console.error("[WS] Error:", (err as any)?.message || err);
  });

  // Send initial greeting
  try {
    ws.send(JSON.stringify({ event: "server", data: "hello-from-server" }));
    console.log("[WS] Greeting sent");
  } catch (err: any) {
    console.error("[WS] Error sending greeting:", err.message);
  }
});

const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => {
  console.log("[SERVER] Listening on port", PORT);
  console.log("[CONFIG] OpenAI API Key:", process.env.OPENAI_API_KEY ? "✓ Configured" : "✗ Missing");
  console.log("[CONFIG] ElevenLabs API Key:", process.env.ELEVENLABS_API_KEY ? "✓ Configured" : "✗ Missing");
});
