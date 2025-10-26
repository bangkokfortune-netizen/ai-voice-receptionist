import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.get("/",  (_,res)=>res.send("OK"));
app.get("/health",(_,res)=>res.send("healthy"));

app.post("/voice", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const wssUrl = `wss://${host}/media`;
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Connecting you now.</Say>
      <Connect><Stream url="${wssUrl}"/></Connect>
    </Response>`);
});

const server = http.createServer(app);

// ❗️ปิด timeout ที่อาจทำให้หลุดเร็ว
server.keepAliveTimeout = 0;   // disable keep-alive timeout
server.headersTimeout   = 0;   // disable header timeout
server.requestTimeout   = 0;   // disable request timeout

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const isWS = (req.headers.upgrade || "").toLowerCase() === "websocket";
  if (!isWS || !req.url?.startsWith("/media")) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  console.log("[WS] connected from", req.socket.remoteAddress);

  // ส่ง greeting เพื่อพิสูจน์ว่า server ไม่ปิดเอง
  try { ws.send(JSON.stringify({ event:"server", data:"hello-from-server" })); } catch {}

  // ❗️keepalive กัน proxy ตัดสาย
  const ka = setInterval(() => { try { ws.ping(); } catch {} }, 10000);

  ws.on("pong", ()=>{}); // แค่ consume
  ws.on("close", () => { clearInterval(ka); console.log("[WS] closed"); });
  ws.on("error", (e) => console.error("[WS] error:", e?.message||e));
  ws.on("message", (buf) => {
    // กัน throw ที่ทำให้ปิดเอง
    try {
      const m = JSON.parse(buf.toString());
      if (m?.event) console.log("[WS] event:", m.event);
    } catch { /* ignore non-JSON */ }
  });
});

const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
