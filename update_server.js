const fs = require('fs');
let content = fs.readFileSync('server.ts', 'utf8');

const ttsRoute = `
  app.post("/api/tts", async (req, res) => {
    try {
      const { text, modelPreference } = req.body;
      if (!text || typeof text !== "string") {
        return res.status(400).json({ error: "Missing text" });
      }

      const { GoogleGenAI, Modality } = await import("@google/genai");
      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-tts-preview",
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (base64Audio) {
        return res.json({ audio: base64Audio });
      } else {
        return res.status(500).json({ error: "Failed to generate audio" });
      }
    } catch (e: any) {
      console.error("TTS failed:", e);
      return res.status(500).json({ error: e.message || "TTS failed" });
    }
  });
`;

if (!content.includes('/api/tts')) {
  content = content.replace('  // Vite middleware for development', ttsRoute + '\n  // Vite middleware for development');
  fs.writeFileSync('server.ts', content);
}
