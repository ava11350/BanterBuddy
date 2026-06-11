import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.post("/api/check-live", async (req, res) => {
    try {
      const { identifier } = req.body;
      if (!identifier || typeof identifier !== "string") {
        return res.status(400).json({ error: "Missing identifier" });
      }

      let channelPath = identifier.trim();
      
      // Extract channel path from URL or username
      if (channelPath.includes('youtube.com/')) {
        const url = new URL(channelPath.startsWith('http') ? channelPath : `https://${channelPath}`);
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts[0] === 'channel' || parts[0] === 'c') {
          channelPath = parts.slice(0, 2).join('/');
        } else {
          channelPath = parts[0]; // usually @username
        }
      } else if (!channelPath.startsWith('@')) {
        channelPath = `@${channelPath}`;
      }

      const targetUrl = `https://www.youtube.com/${channelPath}/live`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      const response = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        // CRITICAL: Consume the response body even on error to prevent Node.js memory leaks
        await response.text().catch(() => {});
        return res.json({ isLive: false });
      }
      
      const html = await response.text();
      
      // The most reliable indicators of a currently active live stream on a YouTube watch page.
      // We check for isLiveNow, hlsManifestUrl (which only exists for active streams), and isLiveContent.
      const isLiveNow = html.includes('"isLiveNow":true') || 
                        html.includes('\\"isLiveNow\\":true') ||
                        (html.includes('hlsManifestUrl') && html.includes('"isLiveContent":true'));
      
      if (isLiveNow) {
        return res.json({ isLive: true });
      }
      
      return res.json({ isLive: false });
    } catch (e) {
      console.error("Direct live check failed:", e);
      return res.json({ isLive: false });
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
