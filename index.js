import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import fastifyFormBody from '@fastify/formbody';
import WebSocket from 'ws';

const fastify = Fastify({ logger: true });

// ✅ Register plugins ก่อน - สำคัญมาก!
await fastify.register(fastifyFormBody);
await fastify.register(fastifyWebSocket);

// Configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

// Store active sessions
const sessions = new Map();

// ✅ 1. Twilio Voice Webhook - POST endpoint รับ form-urlencoded
fastify.post('/voice-webhook', async (request, reply) => {
  fastify.log.info('📞 Incoming call from Twilio');
  fastify.log.info('Request body:', request.body);

  // ✅ Return TwiML ให้ Twilio เชื่อมต่อ Media Stream
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

  reply
    .code(200)
    .header('Content-Type', 'text/xml')
    .send(twiml);
});

// ✅ 2. WebSocket endpoint สำหรับ Twilio Media Stream
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    fastify.log.info('🔌 WebSocket connection established with Twilio');
    
    const sessionId = Date.now().toString();
    let streamSid = null;
    let callSid = null;
    let openAiWs = null;

    // Connect to OpenAI Realtime API
    const connectToOpenAI = () => {
      const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
      
      openAiWs = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      openAiWs.on('open', () => {
        fastify.log.info('✅ Connected to OpenAI Realtime API');
        
        // Configure session
        openAiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            turn_detection: { type: 'server_vad' },
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            voice: 'alloy',
            instructions: 'คุณคือพนักงานต้อนรับของบริษัท พูดภาษาไทยได้คล่อง ตอบคำถามเกี่ยวกับบริษัทและบริการต่างๆ อย่างสุภาพและเป็นมิตร',
            modalities: ['text', 'audio'],
            temperature: 0.8
          }
        }));
      });

      openAiWs.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          
          // Handle different response types
          if (response.type === 'response.audio.delta' && response.delta) {
            // Send audio back to Twilio
            const audioMessage = {
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: response.delta
              }
            };
            connection.socket.send(JSON.stringify(audioMessage));
          }
          
          if (response.type === 'response.audio_transcript.done') {
            fastify.log.info('🤖 AI response:', response.transcript);
          }
          
          if (response.type === 'conversation.item.input_audio_transcription.completed') {
            fastify.log.info('👤 User said:', response.transcript);
          }
          
          if (response.type === 'error') {
            fastify.log.error('❌ OpenAI error:', response.error);
          }
        } catch (error) {
          fastify.log.error('Error parsing OpenAI message:', error);
        }
      });

      openAiWs.on('error', (error) => {
        fastify.log.error('❌ OpenAI WebSocket error:', error);
      });

      openAiWs.on('close', () => {
        fastify.log.info('🔴 OpenAI connection closed');
      });
    };

    // Handle messages from Twilio
    connection.socket.on('message', (message) => {
      try {
        const msg = JSON.parse(message.toString());
        
        switch (msg.event) {
          case 'start':
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            fastify.log.info(`📞 Stream started: ${streamSid}`);
            
            // Connect to OpenAI when stream starts
            connectToOpenAI();
            
            sessions.set(sessionId, {
              streamSid,
              callSid,
              openAiWs,
              startTime: Date.now()
            });
            break;

          case 'media':
            // Forward audio to OpenAI
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: 'input_audio_buffer.append',
                audio: msg.media.payload
              };
              openAiWs.send(JSON.stringify(audioAppend));
            }
            break;

          case 'stop':
            fastify.log.info(`📞 Stream stopped: ${streamSid}`);
            if (openAiWs) {
              openAiWs.close();
            }
            sessions.delete(sessionId);
            break;
        }
      } catch (error) {
        fastify.log.error('Error handling Twilio message:', error);
      }
    });

    connection.socket.on('close', () => {
      fastify.log.info('🔴 Twilio connection closed');
      if (openAiWs) {
        openAiWs.close();
      }
      sessions.delete(sessionId);
    });

    connection.socket.on('error', (error) => {
      fastify.log.error('❌ Twilio WebSocket error:', error);
    });
  });
});

// ✅ 3. Health check endpoint
fastify.get('/health', async (request, reply) => {
  return { 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeSessions: sessions.size
  };
});

// ✅ 4. Root endpoint
fastify.get('/', async (request, reply) => {
  return { 
    message: 'AI Voice Receptionist API',
    endpoints: {
      voiceWebhook: 'POST /voice-webhook',
      mediaStream: 'WS /media-stream',
      health: 'GET /health'
    }
  };
});

// Start server
const start = async () => {
  try {
    if (!OPENAI_API_KEY) {
      throw new Error('❌ OPENAI_API_KEY environment variable is required');
    }

    await fastify.listen({ 
      port: PORT, 
      host: '0.0.0.0' // สำคัญสำหรับ Railway deployment
    });
    
    fastify.log.info(`🚀 Server listening on port ${PORT}`);
    fastify.log.info(`📞 Twilio webhook URL: https://your-domain.railway.app/voice-webhook`);
    fastify.log.info(`🔌 Media stream URL: wss://your-domain.railway.app/media-stream`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
