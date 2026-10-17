import { GoogleGenAI } from "@google/genai";
async function test() {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
  try {
    const res = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: "Hello",
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      }
    });
    console.log("Success");
  } catch (e: any) {
    console.error("ERROR", e.message);
  }
}
test();
