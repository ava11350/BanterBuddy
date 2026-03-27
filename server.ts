import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API routes FIRST
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/check-live", async (req, res) => {
    try {
      const { identifier } = req.query;
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
      
      const response = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      
      if (!response.ok) {
        return res.json({ isLive: false });
      }
      
      const html = await response.text();
      
      // The most reliable indicator of a currently active live stream on a YouTube watch page.
      // Past broadcasts (VODs) and channel pages will not have this set to true for the main video.
      // We check for both standard and escaped JSON formats.
      const isLiveNow = html.includes('"isLiveNow":true') || 
                        html.includes('\\"isLiveNow\\":true');
      
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
