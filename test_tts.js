import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function run() {
  const response = await ai.models.generateContent({
    model: "gemini-3.1-flash-tts-preview",
    contents: [{ parts: [{ text: "Hello" }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
      },
    }
  });
  const part = response.candidates[0].content.parts[0];
  console.log("Keys:", Object.keys(part));
  if (part.inlineData) {
    console.log("MimeType:", part.inlineData.mimeType);
  }
}
run().catch(console.error);
