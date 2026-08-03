import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export type SuggestionStyle = 'personalized' | 'balanced' | 'abstract';

export class StreamAnalyzerSession {
  private history: any[] = [];
  private streamIdentifier: string;

  constructor(streamIdentifier: string, existingHistory: any[] = []) {
    this.streamIdentifier = streamIdentifier;
    this.history = existingHistory;
  }

  getHistory() {
    return this.history;
  }

  async initialize() {
    if (this.history.length > 0) return; // Skip initialization if we recovered history
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

  private pruneHistory() {
    const MAX_HISTORY_LENGTH = 20; // Maximum number of items in history before we prune
    const RECENT_WINDOW = 12; // Keep the last 6 exchanges untouched

    if (this.history.length > MAX_HISTORY_LENGTH) {
      const initialExchange = this.history.slice(0, 2);
      const recentWindow = this.history.slice(this.history.length - RECENT_WINDOW);
      const middleExchanges = this.history.slice(2, this.history.length - RECENT_WINDOW);

      let accumulatedSummary = "";
      
      for (let i = 0; i < middleExchanges.length; i++) {
        const msg = middleExchanges[i];
        const text = msg?.parts?.[0]?.text || "";
        
        if (msg.role === 'user' && text.startsWith("We are condensing older history.")) {
           const extracted = text.substring(text.indexOf(":") + 1).trim();
           if (extracted) accumulatedSummary += " " + extracted;
        } else if (msg.role === 'model') {
           try {
             // Extract JSON summary from previous model responses
             const jsonStr = text.replace(/```json\n?|\n?```/g, '');
             const parsed = JSON.parse(jsonStr);
             if (parsed.summary) {
               accumulatedSummary += " " + parsed.summary;
             }
           } catch(e) {}
        }
      }

      accumulatedSummary = accumulatedSummary.trim();

      if (accumulatedSummary) {
        const summaryExchange = [
          { role: 'user', parts: [{ text: `We are condensing older history. Please acknowledge this summary of older parts of the stream so you don't forget the context: ${accumulatedSummary}` }] },
          { role: 'model', parts: [{ text: "Acknowledged. I will keep this previous context in mind." }] }
        ];
        this.history = [...initialExchange, ...summaryExchange, ...recentWindow];
      } else {
        this.history = [...initialExchange, ...recentWindow];
      }
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

    const promptText = `You are an interactive AI co-host engaging in a live dialogue with the streamer. Based on their profile and the current stream context (especially the recent audio), provide 3 short, conversational responses or prompts that you (the co-host) are saying directly to the streamer. The streamer will read these to continue the back-and-forth dialogue.
    
Context given:
${transcriptInfo}

${audioBase64 ? "I have also provided the most recent high-quality 60-second audio clip. YOU MUST HEAVILY WEIGHT THIS AUDIO CLIP OVER THE TRANSCRIPT. Rely on the audio for accurate tone, energy, and the immediate context since the transcript may have errors or lack nuance. First, provide a 1-sentence 'summary' of the ongoing conversation to maintain continuity in our history. Then, suggest natural follow-ups, new angles, or pivot topics." : "No recent audio available. Leave the 'summary' empty and suggest engaging topics based on their general profile and transcript."}

CRITICAL REQUIREMENTS:
1. Goal: Act as an engaging co-host. Your responses should read like natural dialogue spoken directly to the streamer.
2. Format: Use conversational, punchy sentences. Ask follow-up questions, make witty observations, or share a hot take as if you are sitting next to them. (e.g., "That's crazy, but what if the meta shifts tomorrow?", "I completely disagree! Hear me out...", "Wait, tell me more about that crazy moment you just mentioned.").
3. Brevity: Keep each response under 10-15 words. It must be readable in a split-second glance so the streamer can react to it live.
4. Style: ${styleInstruction}
5. Progress the Conversation: Do not just summarize what they just said. Actively participate by providing the *next* logical hook, a provocative question, or a fresh new angle as a co-host.
6. STRICTLY NO REPEATS: Carefully review the context history. DO NOT suggest any dialogue or ideas that you have already used previously. Freshness is paramount.

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
        temperature: 0.9,
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

    this.pruneHistory();

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
