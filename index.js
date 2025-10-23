// FortuneOne Voice Gateway — hardened pipeline
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { WebSocket as WS } from 'ws';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 8080;
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

function ulawBufToPCM16(ulawB64) {
  const ulawBuf = Buffer.from(ulawB64, 'base64');
  const pcmBuf = Buffer.alloc(ulawBuf.length * 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    const linear = ulaw2linear(ulawBuf[i]);
    pcmBuf.writeInt16LE(linear, i * 2);
  }
  return pcmBuf;
}

function pcm16ToUlawBuf(pcmBuf) {
  const ulawBuf = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < ulawBuf.length; i++) {
    const pcm = pcmBuf.readInt16LE(i * 2);
    ulawBuf[i] = linear2ulaw(pcm);
  }
  return ulawBuf;
}

// ========== resample 16k PCM → 8k PCM ==========
function downsample16to8(pcm16k) {
  const out = Buffer.alloc(pcm16k.length / 2);
  for (let i = 0; i < out.length; i++) {
    out.writeInt16LE(pcm16k.readInt16LE(i * 4), i * 2);
  }
  return out;
}

// ========== split PCM into 20ms @ 8kHz (160 samples) ==========
function splitFrames20ms(pcmBuf) {
  const frames = [];
  const frameSize = 320; // 160 samples * 2 bytes
  for (let i = 0; i < pcmBuf.length; i += frameSize) {
    frames.push(pcmBuf.subarray(i, i + frameSize));
  }
  return frames;
}

// ========== tone generator @ 440Hz ==========
function generateTone440Hz() {
  const sampleRate = 8000;
  const durationSeconds = 1;
  const samples = sampleRate * durationSeconds;
  const pcmBuf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const val = Math.floor(Math.sin(2 * Math.PI * 440 * t) * 16000);
    pcmBuf.writeInt16LE(val, i * 2);
  }
  return pcmBuf;
}

// ========== Twilio route ==========
app.get('/healthz', (_, res) => res.status(200).send('OK'));

app.post('/incoming', (req, res) => {
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello, connecting you now.</Say>
  <Connect><Stream url="wss://${req.headers.host}/media"/></Connect>
</Response>`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (twilioWs) => {
  console.log('Twilio connected');
  let streamSid = null;
  let openai = null;

  // TONE_TEST mode
  if (TONE_TEST) {
    console.log('TONE_TEST enabled');
    twilioWs.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('stream start:', streamSid);
        const tonePcm = generateTone440Hz();
        const toneUlaw = pcm16ToUlawBuf(tonePcm);
        const frames = splitFrames20ms(Buffer.concat([toneUlaw]));
        console.log('tone frames out:', frames.length);
        frames.forEach((f, idx) => {
          setTimeout(() => {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: f.toString('base64') }
            }));
          }, idx * 20);
        });
      }
    });
    return;
  }

  // ECHO_TEST mode
  if (ECHO_TEST) {
    console.log('ECHO_TEST enabled');
    twilioWs.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('stream start:', streamSid);
      } else if (msg.event === 'media') {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid: msg.streamSid,
          media: { payload: msg.media.payload }
        }));
      }
    });
    return;
  }

  // AI mode
  console.log('AI mode');
  openai = new WS('wss://api.openai.com/v1/realtime?model=' + OPENAI_REALTIME_MODEL, {
    headers: { 'Authorization': 'Bearer ' + OPENAI_API_KEY, 'OpenAI-Beta': 'realtime=v1' }
  });

  let sessionConfigured = false;

  openai.on('open', () => {
    console.log('OpenAI connected');
  });

  openai.on('message', (raw) => {
    const event = JSON.parse(raw);
    // console.log('← OpenAI:', event.type);

    if (event.type === 'session.created') {
      openai.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: SYSTEM_PROMPT,
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 500 }
        }
      }));
      sessionConfigured = true;
      // trigger initial greeting
      openai.send(JSON.stringify({ type: 'response.create' }));
      console.log('initial response.create sent');
    }

    // Accept BOTH delta variants
    if (event.type === 'response.audio.delta' || event.type === 'response.output_audio.delta') {
      const delta = event.delta || '';
      if (!delta) return;
      const pcm16 = Buffer.from(delta, 'base64');
      const pcm8 = downsample16to8(pcm16);
      const ulaw = pcm16ToUlawBuf(pcm8);
      const frames = splitFrames20ms(ulaw);
      frames.forEach((f) => {
        if (streamSid) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: f.toString('base64') }
          }));
        }
      });
      console.log('frames out:', frames.length);
    }

    if (event.type === 'input_audio_buffer.speech_started') {
      console.log('speech started');
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      console.log('speech stopped');
    }
    if (event.type === 'input_audio_buffer.committed') {
      console.log('commit');
      openai.send(JSON.stringify({ type: 'response.create' }));
    }
  });

  openai.on('error', (err) => {
    console.error('OpenAI error:', err);
  });
  openai.on('close', () => {
    console.log('OpenAI disconnected');
  });

  twilioWs.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.event === 'start') {
      streamSid = msg.start.streamSid;
      console.log('stream start:', streamSid);
    } else if (msg.event === 'media' && sessionConfigured) {
      const pcm16 = ulawBufToPCM16(msg.media.payload);
      openai.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm16.toString('base64')
      }));
    }
  });

  twilioWs.on('close', () => {
    console.log('Twilio disconnected');
    if (openai) openai.close();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
