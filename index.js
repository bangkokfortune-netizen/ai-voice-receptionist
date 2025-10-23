// index.js
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { WebSocket as WS } from 'ws';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 5050;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'You are a helpful AI voice assistant.';

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY environment variable is required');
  process.exit(1);
}

// Health check endpoint
app.get('/healthz', (_, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// WebSocket upgrade handler
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Main WebSocket connection handler
wss.on('connection', async (twilioWs, req) => {
  console.log('WS connected:', req.url);
  
  let openaiWs = null;
  let streamSid = null;

  // Initialize OpenAI Realtime API connection
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    
    // Connect to OpenAI Realtime API
    openaiWs = new WS('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });

    // OpenAI connection opened
    openaiWs.on('open', () => {
      console.log('OpenAI Realtime API connected');
      
      // Send session configuration
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: SYSTEM_PROMPT,
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      }));
      console.log('Session configuration sent to OpenAI');
    });

    // OpenAI messages
    openaiWs.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        // Log important events
        if (event.type === 'session.created' || event.type === 'session.updated') {
          console.log(`OpenAI: ${event.type}`);
        }
        
        if (event.type === 'conversation.item.created') {
          console.log('OpenAI: conversation item created');
        }
        
        if (event.type === 'response.audio.delta' && event.delta) {
          // Convert PCM16 from OpenAI to μ-law for Twilio
          const audioData = Buffer.from(event.delta, 'base64');
          const mulawData = pcm16ToMulaw(audioData);
          
          // Send audio to Twilio
          if (streamSid && twilioWs.readyState === WS.OPEN) {
            twilioWs.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: mulawData.toString('base64')
              }
            }));
          }
        }
        
        if (event.type === 'response.audio_transcript.done') {
          console.log('AI transcript:', event.transcript);
        }
        
        if (event.type === 'error') {
          console.error('OpenAI error:', event.error);
        }
      } catch (err) {
        console.error('Error parsing OpenAI message:', err);
      }
    });

    openaiWs.on('error', (err) => {
      console.error('OpenAI WebSocket error:', err);
    });

    openaiWs.on('close', () => {
      console.log('OpenAI WebSocket closed');
    });

  } catch (err) {
    console.error('Failed to connect to OpenAI:', err);
  }

  // Twilio WebSocket message handler
  twilioWs.on('message', async (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('stream start', streamSid);
      }
      
      if (msg.event === 'media' && openaiWs && openaiWs.readyState === WS.OPEN) {
        // Convert μ-law from Twilio to PCM16 for OpenAI
        const mulawData = Buffer.from(msg.media.payload, 'base64');
        const pcm16Data = mulawToPcm16(mulawData);
        
        // Send audio to OpenAI
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcm16Data.toString('base64')
        }));
      }
      
      if (msg.event === 'stop') {
        console.log('stream stop');
        if (openaiWs && openaiWs.readyState === WS.OPEN) {
          openaiWs.close();
        }
      }
    } catch (e) {
      console.error('parse error:', e);
    }
  });

  // Twilio WebSocket close handler
  twilioWs.on('close', () => {
    console.log('Twilio WS closed');
    if (openaiWs && openaiWs.readyState === WS.OPEN) {
      openaiWs.close();
    }
  });

  // Keep-alive ping
  const ka = setInterval(() => {
    if (twilioWs.readyState === WS.OPEN) {
      twilioWs.ping();
    }
  }, 15000);
  
  twilioWs.on('close', () => clearInterval(ka));
});

// Audio conversion functions
function mulawToPcm16(mulawData) {
  const mulawTable = [
    -32124,-31100,-30076,-29052,-28028,-27004,-25980,-24956,
    -23932,-22908,-21884,-20860,-19836,-18812,-17788,-16764,
    -15996,-15484,-14972,-14460,-13948,-13436,-12924,-12412,
    -11900,-11388,-10876,-10364,-9852,-9340,-8828,-8316,
    -7932,-7676,-7420,-7164,-6908,-6652,-6396,-6140,
    -5884,-5628,-5372,-5116,-4860,-4604,-4348,-4092,
    -3900,-3772,-3644,-3516,-3388,-3260,-3132,-3004,
    -2876,-2748,-2620,-2492,-2364,-2236,-2108,-1980,
    -1884,-1820,-1756,-1692,-1628,-1564,-1500,-1436,
    -1372,-1308,-1244,-1180,-1116,-1052,-988,-924,
    -876,-844,-812,-780,-748,-716,-684,-652,
    -620,-588,-556,-524,-492,-460,-428,-396,
    -372,-356,-340,-324,-308,-292,-276,-260,
    -244,-228,-212,-196,-180,-164,-148,-132,
    -120,-112,-104,-96,-88,-80,-72,-64,
    -56,-48,-40,-32,-24,-16,-8,0,
    32124,31100,30076,29052,28028,27004,25980,24956,
    23932,22908,21884,20860,19836,18812,17788,16764,
    15996,15484,14972,14460,13948,13436,12924,12412,
    11900,11388,10876,10364,9852,9340,8828,8316,
    7932,7676,7420,7164,6908,6652,6396,6140,
    5884,5628,5372,5116,4860,4604,4348,4092,
    3900,3772,3644,3516,3388,3260,3132,3004,
    2876,2748,2620,2492,2364,2236,2108,1980,
    1884,1820,1756,1692,1628,1564,1500,1436,
    1372,1308,1244,1180,1116,1052,988,924,
    876,844,812,780,748,716,684,652,
    620,588,556,524,492,460,428,396,
    372,356,340,324,308,292,276,260,
    244,228,212,196,180,164,148,132,
    120,112,104,96,88,80,72,64,
    56,48,40,32,24,16,8,0
  ];
  
  const pcm16 = Buffer.alloc(mulawData.length * 2);
  for (let i = 0; i < mulawData.length; i++) {
    const sample = mulawTable[mulawData[i]];
    pcm16.writeInt16LE(sample, i * 2);
  }
  return pcm16;
}

function pcm16ToMulaw(pcm16Data) {
  const mulaw = Buffer.alloc(pcm16Data.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = pcm16Data.readInt16LE(i * 2);
    mulaw[i] = linearToMulaw(sample);
  }
  return mulaw;
}

function linearToMulaw(sample) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  
  let sign = (sample < 0) ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1);
  
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let mulaw = ~(sign | (exponent << 4) | mantissa);
  
  return mulaw & 0xFF;
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
