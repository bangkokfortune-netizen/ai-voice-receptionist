// index.js - Complete OpenAI Realtime API with Audio Resampling Pipeline
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { WebSocket as WS } from 'ws';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 5050;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "You are FortuneOne AI Receptionist.";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
const TONE_TEST = process.env.TONE_TEST === 'true';
const ECHO_TEST = process.env.ECHO_TEST === 'true';

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY required');
  process.exit(1);
}

// ========== μ-law encode/decode ==========
const MULAW_TABLE = (() => {
  const table = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) {
    const pcm = (i - 32768);
    const sign = pcm < 0 ? 0x80 : 0;
    const absVal = Math.abs(pcm);
    const adjusted = 33 + Math.log(1 + 255 * (absVal / 32768)) / Math.log(256) * 255;
    table[i] = sign | (Math.min(127, Math.floor(adjusted)) ^ 0x55);
  }
  return table;
})();

function linear2ulaw(pcm16Sample) {
  return MULAW_TABLE[(pcm16Sample + 32768) & 0xFFFF];
}

function ulaw2linear(ulawByte) {
  ulawByte = ~ulawByte;
  const sign = (ulawByte & 0x80) ? -1 : 1;
  const exponent = (ulawByte & 0x70) >> 4;
  const mantissa = ulawByte & 0x0F;
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude = magnitude - 0x84;
  return sign * magnitude;
}

function ulawB64ToPCM8k(ulawB64) {
  const ulawBuf = Buffer.from(ulawB64, 'base64');
  const pcmBuf = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    const linear = ulaw2linear(ulawBuf[i]);
    pcmBuf.writeInt16LE(linear, i * 2);
  }
  return pcmBuf;
}

function pcm8kToUlawB64(pcmBuf) {
  const ulawBuf = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    ulawBuf[i] = linear2ulaw(sample);
  }
  return ulawBuf.toString('base64');
}

// ========== Resample 8k <-> 16k ==========
function up8to16(pcm8k) {
  const samples8k = pcm8k.length / 2;
  const pcm16k = Buffer.alloc(samples8k * 4);
  for (let i = 0; i < samples8k; i++) {
    const sample = pcm8k.readInt16LE(i * 2);
    pcm16k.writeInt16LE(sample, i * 4);
    pcm16k.writeInt16LE(sample, i * 4 + 2);
  }
  return pcm16k;
}

function down16to8(pcm16k) {
  const samples16k = pcm16k.length / 2;
  const pcm8k = Buffer.alloc(samples16k);
  for (let i = 0; i < samples16k / 2; i++) {
    const s1 = pcm16k.readInt16LE(i * 4);
    const s2 = pcm16k.readInt16LE(i * 4 + 2);
    const avg = Math.floor((s1 + s2) / 2);
    pcm8k.writeInt16LE(avg, i * 2);
  }
  return pcm8k;
}

// ========== Split into 20ms frames @ 8kHz ==========
function splitFrames20msPCM8k(pcmBuf) {
  const FRAME_SIZE = 160 * 2; // 160 samples * 2 bytes = 320 bytes
  const frames = [];
  for (let offset = 0; offset < pcmBuf.length; offset += FRAME_SIZE) {
    const chunk = pcmBuf.slice(offset, offset + FRAME_SIZE);
    if (chunk.length === FRAME_SIZE) {
      frames.push(chunk);
    }
  }
  return frames;
}

// ========== Tone Test Function ==========
function generateTone440Hz(durationMs) {
  const SAMPLE_RATE = 8000;
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const buf = Buffer.alloc(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const amplitude = 0.5;
    const pcm16 = Math.floor(amplitude * 32767 * Math.sin(2 * Math.PI * 440 * t));
    buf[i] = linear2ulaw(pcm16);
  }
  return buf;
}

// ========== HTTP Server + WebSocket Upgrade ==========
app.get('/health', (_, res) => res.status(200).send('OK'));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ========== Main Connection Handler ==========
wss.on('connection', async (twilioWs, req) => {
  console.log('WS connected:', req.url);
  
  let openaiWs = null;
  let streamSid = null;
  let audioBuffer = [];
  let debounceTimer = null;

  // Connect to OpenAI Realtime
  try {
    openaiWs = new WS('wss://api.openai.com/v1/realtime?model=' + OPENAI_REALTIME_MODEL, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    openaiWs.on('open', () => {
      console.log('OpenAI connected');
      
      // session.update
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          voice: 'alloy',
          turn_detection: { type: 'none' },
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          instructions: SYSTEM_PROMPT
        }
      }));
      
      // Initial greeting
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['audio'],
          instructions: 'Greet the caller briefly and professionally.'
        }
      }));
    });

    openaiWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      // Handle both delta event types
      if (msg.type === 'response.audio.delta' || msg.type === 'response.output_audio.delta') {
        const deltaB64 = msg.delta;
        if (deltaB64 && streamSid) {
          console.log('delta len:', Buffer.from(deltaB64, 'base64').length);
          
          // PCM16 16k -> PCM16 8k -> split -> μ-law -> Twilio
          const pcm16k = Buffer.from(deltaB64, 'base64');
          const pcm8k = down16to8(pcm16k);
          const frames = splitFrames20msPCM8k(pcm8k);
          
          frames.forEach(frame => {
            const ulawB64 = pcm8kToUlawB64(frame);
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: ulawB64 }
            }));
          });
          
          console.log('frames out:', frames.length);
        }
      }
      
      if (msg.type === 'error') {
        console.error('OpenAI error:', msg.error);
      }
    });

    openaiWs.on('error', (err) => {
      console.error('OpenAI WS error:', err);
    });

    openaiWs.on('close', () => {
      console.log('OpenAI disconnected');
    });

  } catch (err) {
    console.error('Failed to connect to OpenAI:', err);
  }

  // Twilio events
  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      console.log('stream start', streamSid);
      
      // Tone test if enabled
      if (TONE_TEST) {
        console.log('TONE_TEST enabled - sending 1s tone');
        const toneBuf = generateTone440Hz(1000);
        const frames = [];
        for (let i = 0; i < toneBuf.length; i += 160) {
          frames.push(toneBuf.slice(i, i + 160));
        }
        frames.forEach(frame => {
          if (frame.length === 160) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: frame.toString('base64') }
            }));
          }
        });
      }
    }
    
    if (msg.event === 'media' && openaiWs && openaiWs.readyState === WS.OPEN) {
      const ulawB64 = msg.media.payload;
      
      // Echo test if enabled
      if (ECHO_TEST) {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: ulawB64 }
        }));
        return;
      }
      
      // μ-law 8k -> PCM16 8k -> PCM16 16k
      const pcm8k = ulawB64ToPCM8k(ulawB64);
      const pcm16k = up8to16(pcm8k);
      const pcm16kB64 = pcm16k.toString('base64');
      
      // Append to buffer
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm16kB64
      }));
      
      console.log('append', pcm16k.length, 'bytes');
      
      // Debounce commit + response.create
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        openaiWs.send(JSON.stringify({ type: 'response.create' }));
        console.log('commit + response.create');
      }, 400);
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio disconnected');
    if (openaiWs) openaiWs.close();
    if (debounceTimer) clearTimeout(debounceTimer);
  });
});

server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  console.log('TONE_TEST:', TONE_TEST);
  console.log('ECHO_TEST:', ECHO_TEST);
  console.log('OPENAI_REALTIME_MODEL:', OPENAI_REALTIME_MODEL);
});
