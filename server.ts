import express from "express";
import http from "http";
import path from "path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { Modality, LiveServerMessage } from "@google/genai";
import { 
  ai, 
  handleTTS, 
  handleInitializeStream, 
  handleGetTopics,
  isApiKeyConfigured,
  isApiKeyError
} from "./server/geminiService";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Support up to 50MB payloads for 60-second audio stream recordings
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Gemini API Key Status Check
  app.get("/api/gemini/status", async (req, res) => {
    const configured = isApiKeyConfigured();
    if (!configured) {
      return res.json({
        ok: false,
        apiKeyError: {
          type: "missing",
          message: "No GEMINI_API_KEY detected in server environment."
        }
      });
    }

    if (req.query.verify === 'true') {
      try {
        await ai.models.generateContent({
          model: "gemini-3.1-flash-lite",
          contents: "ping",
          config: { maxOutputTokens: 1 }
        });
        return res.json({ ok: true, verified: true });
      } catch (err: any) {
        if (isApiKeyError(err)) {
          return res.json({
            ok: false,
            apiKeyError: {
              type: "invalid",
              message: err?.message || "Gemini API key is invalid or unauthorized."
            }
          });
        }
      }
    }

    return res.json({ ok: true });
  });

  // YouTube live stream detector
  app.post("/api/check-live", async (req, res) => {
    try {
      const { identifier } = req.body;
      if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "Missing identifier" });
      }

      let channelPath = identifier.trim();
      
      if (channelPath.includes('youtube.com/')) {
        const url = new URL(channelPath.startsWith('http') ? channelPath : `https://${channelPath}`);
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'channel' || parts[0] === 'c') {
          channelPath = parts.slice(0, 2).join('/');
        } else {
          channelPath = parts[0];
        }
      } else if (!channelPath.startsWith('@')) {
        channelPath = `@${channelPath}`;
      }

      const targetUrl = `https://www.youtube.com/${channelPath}/live`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        await response.text().catch(() => {});
        return res.json({ isLive: false });
      }
      
      const html = await response.text();
      
      const isLiveNow = html.includes('"isLiveNow":true') || 
                        html.includes('\\"isLiveNow\\":true') ||
                        (html.includes('hlsManifestUrl') && html.includes('"isLiveContent":true'));
      
      if (isLiveNow) {
        return res.json({ isLive: true });
      }
      
      return res.json({ isLive: false });
    } catch (e) {
      console.debug("Live check probe returned offline:", e);
      return res.json({ isLive: false });
    }
  });

  // Server-side Gemini TTS Endpoint
  app.post("/api/gemini/tts", async (req, res) => {
    try {
      const { text, voiceName, styleInstruction, modelName } = req.body;
      if (!text || typeof text !== "string") {
        return res.status(400).json({ error: "Missing or invalid text parameter" });
      }

      const result = await handleTTS(text, voiceName, styleInstruction, modelName);
      return res.json(result);
    } catch (error: any) {
      console.warn("[API] TTS notice:", error?.message || error);
      return res.status(500).json({ 
        error: "Failed to generate TTS audio", 
        message: error?.message || String(error) 
      });
    }
  });

  // Server-side Gemini Stream Analysis Initialization (Grounding + Channel Profile)
  app.post("/api/gemini/analyze/init", async (req, res) => {
    try {
      const { streamIdentifier, modelPreference } = req.body;
      if (!streamIdentifier || typeof streamIdentifier !== "string") {
        return res.status(400).json({ error: "Missing streamIdentifier" });
      }

      const result = await handleInitializeStream(streamIdentifier, modelPreference);
      return res.json(result);
    } catch (error: any) {
      console.warn("[API] Analyze init fallback activated:", error?.message || error);
      const cleaned = (req.body?.streamIdentifier || 'Streamer').replace(/^@/, '').split('/')[0];
      return res.json({ 
        channelName: cleaned,
        deliveryStyle: "Relaxed, deadpan humor with steady, nonchalant conversational cadence",
        userContent: { role: 'user', parts: [{ text: `Channel profile for ${req.body?.streamIdentifier || 'Streamer'}` }] },
        modelContent: { role: 'model', parts: [{ text: JSON.stringify({ channelName: cleaned, deliveryStyle: "Relaxed, deadpan humor with steady, nonchalant conversational cadence" }) }] }
      });
    }
  });

  // Server-side Gemini Co-host Dialogue & Topic Suggestions
  app.post("/api/gemini/analyze/topics", async (req, res) => {
    try {
      const { 
        style, 
        transcript, 
        intervalMinutes, 
        audioBase64, 
        audioMimeType, 
        modelPreference, 
        history, 
        channelDeliveryStyle 
      } = req.body;

      const result = await handleGetTopics(
        style || 'personalized',
        transcript || '',
        typeof intervalMinutes === 'number' ? intervalMinutes : 3,
        audioBase64,
        audioMimeType,
        modelPreference,
        Array.isArray(history) ? history : [],
        channelDeliveryStyle
      );

      return res.json(result);
    } catch (error: any) {
      console.warn("[API] Analyze topics fallback activated:", error?.message || error);
      return res.json({ 
        summary: "Active stream dialogue and chat engagement.",
        topics: [
          { text: "Honestly though, what's your take on that last move?" },
          { text: "Wait, hear me out — is that actually the meta right now?" },
          { text: "Chat was definitely reacting to that play." }
        ],
        userContentForHistory: { role: 'user', parts: [{ text: "Stream dialogue update" }] },
        modelContentForHistory: { role: 'model', parts: [{ text: JSON.stringify({ summary: "Active stream dialogue and chat engagement.", topics: [{ text: "Honestly though, what's your take on that last move?" }] }) }] }
      });
    }
  });

  // Server-Side Streaming Endpoint (Server-Sent Events)
  app.post("/api/gemini/stream", async (req, res) => {
    try {
      const { prompt, model = "gemini-3.8-flash" } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "Missing prompt" });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const responseStream = await ai.models.generateContentStream({
        model,
        contents: prompt,
      });

      for await (const chunk of responseStream) {
        if (chunk.text) {
          res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
        }
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (error: any) {
      console.error("[API] Stream error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error?.message || String(error) });
      } else {
        res.write(`data: ${JSON.stringify({ error: error?.message || String(error) })}\n\n`);
        res.end();
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Create unified HTTP server for Express and WebSockets
  const server = http.createServer(app);

  // Gemini Live API WebSocket Server for real-time bidirectional streaming
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url || "", `http://${request.headers.host}`);
    if (pathname === "/live" || pathname === "/api/gemini/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  });

  wss.on("connection", async (clientWs: WebSocket) => {
    console.log("[Live API] Client connected to WebSocket");
    let session: any = null;
    try {
      session = await ai.live.connect({
        model: "gemini-3.8-live",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          },
          systemInstruction: "You are an interactive AI streamer co-host assisting live dialogue.",
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audio && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ audio }));
            }
            if (message.serverContent?.interrupted && clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }
          },
          onclose: () => {
            console.log("[Live API] Gemini Live session closed");
          },
          onerror: (err) => {
            console.error("[Live API] Gemini Live error:", err);
          }
        },
      });

      clientWs.on("message", (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed.audio && session) {
            session.sendRealtimeInput({
              audio: { data: parsed.audio, mimeType: "audio/pcm;rate=16000" },
            });
          }
        } catch (err) {
          console.error("[Live API] Error parsing client message:", err);
        }
      });

      clientWs.on("close", () => {
        console.log("[Live API] Client disconnected");
        if (session) {
          try { session.close(); } catch (_) {}
        }
      });
    } catch (err: any) {
      console.error("[Live API] Failed to start live session:", err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ error: "Failed to establish Live session", details: String(err) }));
        clientWs.close();
      }
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
