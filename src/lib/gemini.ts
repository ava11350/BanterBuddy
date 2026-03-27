import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export type SuggestionStyle = 'personalized' | 'balanced' | 'abstract';

export async function analyzeStreamForTopics(
  streamIdentifier: string,
  style: SuggestionStyle,
  audioBase64?: string,
  audioMimeType?: string
): Promise<{topics: string[]}> {
  
  let styleInstruction = "";
  if (style === 'personalized') {
    styleInstruction = "Suggest topics which directly draw from the user's background, niche, and the ongoing conversation.";
  } else if (style === 'balanced') {
    styleInstruction = "Hybridize personalized and abstract. Suggestions should not be as directly focused on the immediate conversation but still maintain relevancy via personalization and general interests.";
  } else if (style === 'abstract') {
    styleInstruction = "Help change the topic and start new dialogues. Topics should be related to the creator's general interests but less derived from the ongoing conversation. Introduce creative or wildcard scenarios.";
  }

  const prompt = `You are an AI co-host for a livestreamer. The current livestream identifier/URL is: ${streamIdentifier}. The current time is ${new Date().toISOString()}. 
      
First, use Google Search to find the most recent information, tweets, community updates, or news about this creator or stream to understand their background and CURRENT context.
${audioBase64 ? "I have also provided an audio recording of the recent stream discussion. Listen to this audio to understand the immediate conversational context." : ""}

Then, suggest 3 brief, punchy, and OPEN-ENDED discussion prompts (around 6-12 words, short of a full sentence). 

CRITICAL REQUIREMENTS:
1. Style: ${styleInstruction}
2. Open-Ended: They must prompt discussion, not just be statements.
3. High Variance: Do not repeat standard topics. Introduce wildcards, hot takes, or unusual questions.
4. Length: Around 6-12 words per topic. Short of a full sentence, but descriptive enough to spark a conversation.

Return JSON with 'topics' (array of strings).`;

  const parts: any[] = [{ text: prompt }];
  
  if (audioBase64 && audioMimeType) {
    parts.push({
      inlineData: {
        data: audioBase64,
        mimeType: audioMimeType
      }
    });
  }

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{ parts }],
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
