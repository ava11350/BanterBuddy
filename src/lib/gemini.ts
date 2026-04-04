import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export type SuggestionStyle = 'personalized' | 'balanced' | 'abstract';

export class StreamAnalyzerSession {
  private history: any[] = [];
  private streamIdentifier: string;

  constructor(streamIdentifier: string) {
    this.streamIdentifier = streamIdentifier;
  }

  async initialize() {
    const prompt = `You are an AI co-host for a livestreamer. The current livestream identifier/URL is: ${this.streamIdentifier}. The current time is ${new Date().toISOString()}. 
    
First, use Google Search to find the most recent information, tweets, community updates, or news about this creator or stream to understand their background, niche, and CURRENT context. Build a comprehensive internal profile of this creator. You do not need to output the profile to me, just acknowledge that you have researched them and are ready to provide talking points.`;

    const userContent = { role: 'user', parts: [{ text: prompt }] };
    
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [userContent],
      config: {
        tools: [{ googleSearch: {} }],
        toolConfig: { includeServerSideToolInvocations: true }
      }
    });

    this.history.push(userContent);
    if (response.candidates?.[0]?.content) {
      this.history.push(response.candidates[0].content);
    }
  }

  async getTopics(style: SuggestionStyle, audioBase64?: string, audioMimeType?: string): Promise<{topics: string[]}> {
    let styleInstruction = "";
    if (style === 'personalized') {
      styleInstruction = "Suggest topics which directly draw from the user's background, niche, and the ongoing conversation.";
    } else if (style === 'balanced') {
      styleInstruction = "Hybridize personalized and abstract. Suggestions should not be as directly focused on the immediate conversation but still maintain relevancy via personalization and general interests.";
    } else if (style === 'abstract') {
      styleInstruction = "Help change the topic and start new dialogues. Topics should be related to the creator's general interests but less derived from the ongoing conversation. Introduce creative or wildcard scenarios.";
    }

    const promptText = `Based on your established profile of the creator, please suggest 3 extremely brief discussion seeds or talking points.
    
${audioBase64 ? "I have provided an audio recording of the recent stream discussion. Listen to this audio to understand the immediate conversational context." : "No recent audio is available, rely on the creator's general profile."}

CRITICAL REQUIREMENTS:
1. Style: ${styleInstruction}
2. Format: Provide open-ended concepts or talking points, NOT direct questions. (e.g., use "The new meta shift" instead of "What do you think about the new meta?")
3. Brevity: Maximum of 10 words per topic. They must be easy to glance at and naturally work into a flowing conversation.
4. High Variance: Do not repeat standard topics. Introduce wildcards, hot takes, or unusual angles.

Return JSON with 'topics' (array of strings).`;

    const newParts: any[] = [{ text: promptText }];
    if (audioBase64 && audioMimeType) {
      const cleanMimeType = audioMimeType.split(';')[0];
      newParts.push({
        inlineData: {
          data: audioBase64,
          mimeType: cleanMimeType
        }
      });
    }

    const newUserContent = { role: 'user', parts: newParts };
    const currentContents = [...this.history, newUserContent];

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: currentContents,
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
        }
      }
    });

    // Add to history WITHOUT the audio to save context window and prevent confusion
    this.history.push({ role: 'user', parts: [{ text: promptText }] });
    if (response.candidates?.[0]?.content) {
      this.history.push(response.candidates[0].content);
    }

    try {
      const text = response.text;
      if (!text) return { topics: [] };
      return JSON.parse(text);
    } catch (e) {
      console.error("Failed to parse topics", e);
      return { topics: [] };
    }
  }
}
