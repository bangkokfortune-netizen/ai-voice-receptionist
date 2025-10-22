const Fastify = require('fastify');
const websocket = require('@fastify/websocket');
const dotenv = require('dotenv');
const WebSocket = require('ws');

dotenv.config();

const fastify = Fastify({ logger: true });
fastify.register(websocket);

const PORT = process.env.PORT || 5050;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'You are a helpful AI assistant.';

// Twilio Voice Webhook - Returns TwiML to connect to Media Stream
fastify.post('/voice-webhook', async (request, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;
  
  reply.type('text/xml').send(twiml);
});

// WebSocket endpoint for Twilio Media Streams
fastify.register(async (fastify) => {
  fastify.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('📞 Client connected to media stream');
    
    let openAiWs = null;
    let streamSid = null;

    const connectToOpenAI = () => {
      openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      openAiWs.on('open', () => {
        console.log('✅ Connected to OpenAI Realtime API');
        
        openAiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text', 'audio'],
            instructions: SYSTEM_PROMPT,
            voice: 'alloy',
            input_audio_format: 'g711_ulaw',
            output_audio_format: 'g711_ulaw',
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500
            }
          }
        }));
      });

      openAiWs.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          
          if (message.type === 'response.audio.delta' && message.delta) {
            const audioPayload = {
              event: 'media',
              streamSid: streamSid,
              media: { payload: message.delta }
            };
            connection.send(JSON.stringify(audioPayload));
          }

          if (message.type === 'response.done') {
            console.log('✅ Response completed');
          }
        } catch (error) {
          console.error('❌ Error processing OpenAI message:', error);
        }
      });

      openAiWs.on('error', (error) => {
        console.error('❌ OpenAI WebSocket error:', error);
      });

      openAiWs.on('close', () => {
        console.log('🔌 Disconnected from OpenAI');
      });
    };

    connection.on('message', (message) => {
      try {
        const msg = JSON.parse(message);

        switch (msg.event) {
          case 'start':
            streamSid = msg.start.streamSid;
            console.log('🎙️ Stream started:', streamSid);
            connectToOpenAI();
            break;

          case 'media':
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: msg.media.payload
              }));
            }
            break;

          case 'stop':
            console.log('⏹️ Stream stopped');
            if (openAiWs) openAiWs.close();
            break;
        }
      } catch (error) {
        console.error('❌ Error processing message:', error);
      }
    });

    connection.on('close', () => {
      console.log('👋 Client disconnected');
      if (openAiWs) openAiWs.close();
    });
  });
});

// Health check
fastify.get('/health', async (request, reply) => {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      hasOpenAIKey: !!OPENAI_API_KEY,
      port: PORT
    }
  };
});

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`
🚀 Server running on port ${PORT}
📡 Webhook URL: http://localhost:${PORT}/voice-webhook
🏥 Health check: http://localhost:${PORT}/health
    `);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

