// index.js
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';

const app = express();

// (optional) health check
app.get('/healthz', (_, res) => res.status(200).send('ok'));

const server = http.createServer(app);

// เปิด WS แบบ noServer แล้วคัดกรอง path เอง
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // รองรับเฉพาะ path นี้เท่านั้น
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  console.log('WS connected:', req.url);

  // กัน timeout: ส่ง ping ทุก 15s
  const ka = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 15000);

  ws.on('message', (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      // ตัวอย่าง event จาก Twilio: start / media / stop / mark
      if (msg.event === 'start') {
        console.log('stream start', msg.start?.callSid);
      }
      if (msg.event === 'media') {
        // รับเสียงฝั่งลูกค้า (base64 μ-law 8k) ที่ msg.media.payload
        // TODO: ส่งไป Whisper/LLM/TTS ตาม flow จริง
        // (ถ้าต้องการตอบเสียงกลับ ให้ส่ง message ประเภท "media" กลับไปยัง ws)
      }
      if (msg.event === 'stop') {
        console.log('stream stop');
      }
    } catch (e) {
      console.error('parse error:', e);
    }
  });

  ws.on('close', () => {
    clearInterval(ka);
    console.log('WS closed');
  });

  ws.on('error', (err) => {
    console.error('WS error', err);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log('Server listening on', PORT));
