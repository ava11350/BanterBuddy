import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function analyzeStreamForTopics(streamIdentifier: string): Promise<{isLive: boolean, topics: string[]}> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      `You are an AI co-host for a livestreamer named Ava (username: ava11350). The current livestream identifier/URL is: ${streamIdentifier}. The current time is ${new Date().toISOString()}. 
      
First, use Google Search to determine if this channel is CURRENTLY live right now. 
Then, suggest 3 extremely brief, punchy, and OPEN-ENDED discussion prompts (max 5-7 words each). 

CRITICAL REQUIREMENTS:
1. High Variance: Do not repeat standard topics. Introduce wildcards, hot takes, "what if" scenarios, or unusual questions.
2. Open-Ended: They must prompt discussion, not just be statements.
3. Personalized: Draw from the channel's vibe or recent search context if available.
4. Brevity: Maximum 5-7 words per topic. Easy to read at a glance.

Return JSON with 'isLive' (boolean) and 'topics' (array of strings).`
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          isLive: { type: Type.BOOLEAN },
          topics: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        },
        required: ["isLive", "topics"]
      },
      tools: [{ googleSearch: {} }],
      toolConfig: { includeServerSideToolInvocations: true }
    }
  });
  
  try {
    const text = response.text;
    if (!text) return { isLive: false, topics: [] };
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse topics", e);
    return { isLive: false, topics: [] };
  }
}
