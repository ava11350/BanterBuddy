import { GoogleGenAI } from "@google/genai";
async function test() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  try {
    const res = await ai.models.generateContent({
      model: "gemini-pro-latest",
      contents: "Hello",
      config: {
        responseModalities: ["AUDIO"],
      }
    });
    console.log("Success 8b");
  } catch (e: any) {
    console.error("ERROR 8b", e.message);
  }
}
test();
