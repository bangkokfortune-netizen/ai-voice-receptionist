# 🤖 AI Voice Receptionist

ระบบพนักงานต้อนรับด้วย AI ที่ใช้ Fastify + Twilio + OpenAI Realtime API สามารถสนทนาด้วยเสียงแบบ real-time และรองรับภาษาไทย

## 🎯 Features

✅ **Real-time Voice Conversation** - สนทนาด้วยเสียงแบบ real-time  
✅ **Thai Language Support** - รองรับภาษาไทยได้อย่างคล่องแคล่ว  
✅ **Server-side VAD** - ตรวจจับเสียงพูดอัตโนมัติ  
✅ **Production Ready** - พร้อม deploy บน Railway  
✅ **Session Management** - จัดการ session และ logging ครบถ้วน  
✅ **Error Handling** - จัดการ error และ edge cases

---

## 📦 Requirements

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **OpenAI API Key** (with GPT-4 Realtime API access)
- **Twilio Account** (with phone number)
- **Railway Account** (for deployment)

---

## 🚀 Installation

### 1. Clone และติดตั้ง dependencies

```bash
# Clone repository
git clone <your-repo-url>
cd ai-voice-receptionist

# ติดตั้ง dependencies
npm install
```

### 2. สร้างไฟล์ .env

```bash
cp .env.example .env
```

แก้ไขไฟล์ `.env`:

```env
OPENAI_API_KEY=sk-proj-your-actual-key-here
PORT=5050
SYSTEM_PROMPT=คุณคือพนักงานต้อนรับของบริษัท XYZ...
```

### 3. ทดสอบ local

```bash
npm start
```

Server จะรันที่ `http://localhost:5050`

---

## 🔧 สิ่งที่แก้ไขจากโค้ดเดิม

### ✅ 1. Register @fastify/formbody Plugin

**ปัญหา:** Twilio ส่ง POST request เป็น `application/x-www-form-urlencoded` แต่ไม่มีการ register plugin

**แก้ไข:**
```javascript
const formbody = require('@fastify/formbody');

// ต้อง register ก่อนสร้าง routes
fastify.register(formbody);
fastify.register(websocket);
```

### ✅ 2. แก้ไข TwiML Response

**ปัญหา:** TwiML ไม่สมบูรณ์ ไม่มี greeting และไม่รองรับ HTTPS/WSS

**แก้ไข:**
```javascript
const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Aditi" language="th-TH">สวัสดีค่ะ กำลังเชื่อมต่อกับระบบ AI</Say>
    <Connect>
        <Stream url="${protocol}://${host}/media-stream">
            <Parameter name="callSid" value="${callSid}" />
        </Stream>
    </Connect>
</Response>`;
```

### ✅ 3. เพิ่ม Error Handling

**เพิ่มเติม:**
- Try-catch ในทุก webhook และ WebSocket handlers
- Error TwiML response เมื่อเกิดปัญหา
- Graceful shutdown สำหรับปิด connections
- Logging ครบถ้วนทุก events

### ✅ 4. Session Management

**เพิ่มเติม:**
```javascript
const activeSessions = new Map();

// เก็บข้อมูล session
activeSessions.set(sessionId, {
  streamSid,
  callSid,
  openaiWs,
  startTime: Date.now()
});
```

### ✅ 5. เพิ่ม Endpoints

- `/health` - Health check พร้อม system metrics
- `/status` - ดู active sessions
- `/` - API documentation

### ✅ 6. Production Configuration

```javascript
await fastify.listen({ 
  port: PORT, 
  host: '0.0.0.0' // สำคัญ! Railway ต้องใช้ 0.0.0.0
});
```

---

## 🌐 Deploy บน Railway

### Step 1: Push code ไปยัง GitHub

```bash
git init
git add .
git commit -m "Initial commit: AI Voice Receptionist"
git branch -M main
git remote add origin <your-github-repo>
git push -u origin main
```

### Step 2: Deploy บน Railway

1. ไปที่ [Railway.app](https://railway.app)
2. คลิก **New Project**
3. เลือก **Deploy from GitHub repo**
4. เลือก repository ของคุณ
5. Railway จะ auto-detect Node.js และ deploy

### Step 3: เพิ่ม Environment Variables

ใน Railway Dashboard:
1. เข้าไปที่ project ของคุณ
2. ไปที่ tab **Variables**
3. เพิ่ม variables:

```
OPENAI_API_KEY=sk-proj-your-key
SYSTEM_PROMPT=คุณคือพนักงานต้อนรับ...
```

### Step 4: ดู Deployment URL

Railway จะให้ URL เช่น: `https://your-app.railway.app`

---

## 📞 Configure Twilio

### Step 1: ไปที่ Twilio Console

1. เข้า [Twilio Console](https://console.twilio.com)
2. ไปที่ **Phone Numbers** → **Manage** → **Active Numbers**
3. เลือกเบอร์ที่ต้องการใช้

### Step 2: ตั้งค่า Voice Webhook

```
A CALL COMES IN:
  Webhook: https://your-app.railway.app/voice-webhook
  HTTP: POST
  
PRIMARY HANDLER FAILS:
  Webhook: https://your-app.railway.app/voice-webhook
  HTTP: POST
```

### Step 3: Save Configuration

คลิก **Save** ด้านล่างของหน้า

---

## 🧪 Testing

### 1. Test Health Endpoint

```bash
curl https://your-app.railway.app/health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-XX...",
  "activeSessions": 0,
  "memory": {...},
  "environment": {...}
}
```

### 2. Test Voice Call

1. โทรเข้าเบอร์ Twilio ของคุณ
2. ระบบจะพูดว่า "สวัสดีค่ะ กำลังเชื่อมต่อกับระบบ AI"
3. เริ่มสนทนากับ AI ได้เลย!

### 3. Monitor Logs

ใน Railway Dashboard:
- ไปที่ **Deployments** tab
- คลิก **View Logs**
- ดู real-time logs:

```
📞 Incoming call from Twilio
🔌 WebSocket connection established
✅ Connected to OpenAI Realtime API
👤 User said: "สวัสดีครับ"
🤖 AI said: "สวัสดีค่ะ ยินดีต้อนรับ..."
```

---

## 🎨 Customization

### เปลี่ยน AI Voice

แก้ไขใน `index.js`:
```javascript
voice: 'alloy' // เปลี่ยนเป็น: alloy, echo, fable, onyx, nova, shimmer
```

### เปลี่ยน System Prompt

แก้ไขใน `.env`:
```env
SYSTEM_PROMPT=คุณคือผู้ช่วยที่...
```

หรือแก้ไขตรงใน code:
```javascript
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 'Your custom prompt here';
```

### ปรับ Voice Detection

แก้ไขใน `index.js`:
```javascript
turn_detection: { 
  type: 'server_vad',
  threshold: 0.5,        // ความไวในการตรวจจับเสียง (0.0-1.0)
  prefix_padding_ms: 300, // เวลาก่อนเริ่มพูด
  silence_duration_ms: 500 // เวลาเงียบก่อนหยุดฟัง
}
```

---

## 📊 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | API documentation |
| `/voice-webhook` | POST | Twilio voice webhook (TwiML) |
| `/media-stream` | WebSocket | Twilio media stream |
| `/health` | GET | Health check + metrics |
| `/status` | GET | Active sessions status |

---

## 🔍 Troubleshooting

### ปัญหา: "Unsupported Media Type"

**สาเหตุ:** ไม่ได้ register `@fastify/formbody`

**แก้ไข:** ตรวจสอบว่ามี `fastify.register(formbody)` ก่อน routes

---

### ปัญหา: WebSocket ไม่เชื่อมต่อ

**สาเหตุ:** URL ใช้ `ws://` แทน `wss://` บน production

**แก้ไข:** ใช้ code ที่ auto-detect protocol:
```javascript
const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
```

---

### ปัญหา: OpenAI ไม่ตอบ

**ตรวจสอบ:**
1. OPENAI_API_KEY ถูกต้อง
2. มี access to GPT-4 Realtime API
3. ดู logs ว่ามี error อะไร

---

## 📝 TwiML Response Examples

### ✅ Success Response

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Aditi" language="th-TH">
        สวัสดีค่ะ กำลังเชื่อมต่อกับระบบ AI
    </Say>
    <Connect>
        <Stream url="wss://your-domain.railway.app/media-stream">
            <Parameter name="callSid" value="CA123..." />
        </Stream>
    </Connect>
</Response>
```

### ❌ Error Response

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Aditi" language="th-TH">
        ขออภัยค่ะ ระบบมีปัญหา กรุณาลองใหม่อีกครั้ง
    </Say>
    <Hangup/>
</Response>
```

---

## 🛠️ Development Tips

### Run with auto-reload

```bash
npm run dev
```

### View logs in real-time

```bash
npm start | grep "📞\|🤖\|👤"
```

### Test Twilio webhook locally

ใช้ [ngrok](https://ngrok.com):
```bash
ngrok http 5050
```

แล้วใช้ ngrok URL ตั้งค่าใน Twilio webhook

---

## 📚 Additional Resources

- [Twilio Voice Documentation](https://www.twilio.com/docs/voice)
- [OpenAI Realtime API](https://platform.openai.com/docs/api-reference/realtime)
- [Fastify Documentation](https://www.fastify.io/docs/latest/)
- [Railway Documentation](https://docs.railway.app/)

---

## 🤝 Support

หากมีปัญหา:
1. ตรวจสอบ logs ใน Railway Dashboard
2. ทดสอบ `/health` endpoint
3. ดู active sessions ที่ `/status`

---

## 📄 License

MIT

---

## 🎉 Success Indicators

เมื่อทุกอย่างทำงานถูกต้อง คุณจะเห็น:

```
✅ Connected to OpenAI Realtime API
📞 Stream started - StreamSid: MZ123...
👤 User said: "สวัสดีครับ"
🤖 AI said: "สวัสดีค่ะ ยินดีต้อนรับ..."
```

**ขอให้โชคดีกับโปรเจค AI Voice Receptionist ของคุณ! 🚀**
