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

  async getTopics(style: SuggestionStyle, transcript: string, audioBase64?: string, audioMimeType?: string): Promise<{summary?: string, topics: string[]}> {
    let styleInstruction = "";
    if (style === 'personalized') {
      styleInstruction = "Highly relevant to the current conversation or the creator's specific niche.";
    } else if (style === 'balanced') {
      styleInstruction = "A mix of natural follow-ups to the current topic and broader channel-related themes.";
    } else if (style === 'abstract') {
      styleInstruction = "Fun pivots, new tangents, or broader questions to completely refresh the conversation.";
    }

    const transcriptInfo = transcript.trim() ? `Browser background transcript (may contain errors, use to understand broader context between audio clips): "${transcript}"` : "No background transcript available.";

    const promptText = `You are a live stream producer helping a creator avoid "dead air". Based on their profile and the current stream context, suggest 3 punchy, easy-to-read talking points to keep the broadcast moving.
    
Context given:
${transcriptInfo}

${audioBase64 ? "I have also provided the most recent high-quality 60-second audio clip. YOU MUST HEAVILY WEIGHT THIS AUDIO CLIP OVER THE TRANSCRIPT. Rely on the audio for accurate tone, energy, and the immediate context since the transcript may have errors or lack nuance. First, provide a 1-sentence 'summary' of the ongoing conversation to maintain continuity in our history. Then, suggest natural follow-ups, new angles, or pivot topics." : "No recent audio available. Leave the 'summary' empty and suggest engaging topics based on their general profile and transcript."}

CRITICAL REQUIREMENTS:
1. Goal: Cure "dead air". The suggestions must be instantly readable and spark immediate thoughts.
2. Format: Use punchy phrases, bold statements, or engaging questions. (e.g., "Thoughts on the new Zelda leaks?", "Story time: your worst gaming moment", "Hot take on the current meta").
3. Brevity: Keep it under 8-10 words. It must be readable in a split-second glance.
4. Style: ${styleInstruction}
5. No Echoing: Don't just summarize what they just said in the topics. Give them the *next* thing to talk about.

Return JSON with 'summary' (string) and 'topics' (array of strings).`;

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
            summary: { type: Type.STRING },
            topics: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ["summary", "topics"]
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
