import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function analyzeStreamForTopics(streamIdentifier: string): Promise<{topics: string[]}> {
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      `You are an AI co-host for a livestreamer. The current livestream identifier/URL is: ${streamIdentifier}. The current time is ${new Date().toISOString()}. 
      
First, use Google Search to find the most recent information, tweets, community updates, or news about this creator or stream to understand the CURRENT context of their broadcast.

Then, suggest 3 extremely brief, punchy, and OPEN-ENDED discussion prompts (max 5-7 words each) based heavily on the recent context you found. 

CRITICAL REQUIREMENTS:
1. High Variance: Do not repeat standard topics. Introduce wildcards, hot takes, "what if" scenarios, or unusual questions.
2. Open-Ended: They must prompt discussion, not just be statements.
3. Contextual: Draw directly from the channel's current vibe, recent search context, or ongoing events if available.
4. Brevity: Maximum 5-7 words per topic. Easy to read at a glance.

Return JSON with 'topics' (array of strings).`
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          topics: {
            type: Type.ARRAY,
            items: { type: Type.STRING }
          }
        },
        required: ["topics"]
      },
      tools: [{ googleSearch: {} }],
      toolConfig: { includeServerSideToolInvocations: true }
    }
  });
  
  try {
    const text = response.text;
    if (!text) return { topics: [] };
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse topics", e);
    return { topics: [] };
  }
}
