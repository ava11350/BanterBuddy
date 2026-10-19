import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export type SuggestionStyle = 'personalized' | 'balanced' | 'abstract';
export type GeminiModelPreference = 'pro' | 'flash' | 'flash-lite';
export type TTSModelOption = 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts';

function getModelWaterfall(preference: GeminiModelPreference = 'flash'): string[] {
  // Reordered fallback sequence:
  // 1st: Pro ('gemini-4-argon')
  // 2nd: Flash ('gemini-3.8-flash')
  // 3rd & final: Flash-lite ('gemini-3.1-flash-lite')
  if (preference === 'flash') {
    return ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
  }
  if (preference === 'flash-lite') {
    return ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];
  }
  return ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
}

async function generateWithFallback(requestConfig: any, preference: GeminiModelPreference = 'flash') {
  const waterfall = getModelWaterfall(preference);
  let lastError: any = null;
  
  for (const model of waterfall) {
    try {
      const request = { ...requestConfig, model };
      console.log(`[Waterfall] Attempting request with model: ${model}`);
      const response = await ai.models.generateContent(request);
      console.log(`[Waterfall] Successfully generated with model: ${model}`);
      return response;
    } catch (error: any) {
      console.warn(`[Waterfall] Model ${model} failed, falling back to next model. Error:`, error);
      lastError = error;
      // Continue to the next model in the waterfall
    }
  }
  
  throw lastError;
}

export interface TopicSuggestion { quote?: string; text: string; }

export async function generateTTSAudio(
  text: string, 
  voiceName: string = 'Aoede',
  styleInstruction?: string,
  modelName: TTSModelOption = 'gemini-3.8-flash-lite-tts'
): Promise<{ audioUrl: string | null }> {
  const style = styleInstruction || 
    "Nonchalant, casual streamer co-host, relaxed and effortless cadence, understated and casual, matching natural chill streamer banter, unbothered, cool, and conversational without being overly bright, cheerleading, or chirpy.";

  // Model waterfall for TTS: try user-selected TTS model first, then fall back to the alternate 3.8 TTS model
  const ttsWaterfall: string[] = modelName === 'gemini-3.8-flash-tts'
    ? ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']
    : ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];

  let lastError: any = null;

  for (const model of ttsWaterfall) {
    try {
      console.log(`Attempting TTS generation with model: ${model}`);
      const response = await ai.models.generateContent({
        model,
        contents: [{
          role: "user",
          parts: [{
            text,
            speechMetadata: {
              style
            }
          }] as any
        }],
        config: {
          responseModalities: ["AUDIO" as any],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        }
      });
      
      const inlineData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inlineData?.data) {
        continue;
      }

      // Decode base64 audio
      const binaryString = window.atob(inlineData.data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Check if output is already a complete RIFF WAV file (standard for Gemini 3.8 TTS unary)
      const isWav = bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
        bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45; // "WAVE"

      let blob: Blob;
      if (isWav) {
        // Direct WAV from modern Gemini 3.8 TTS
        blob = new Blob([bytes], { type: 'audio/wav' });
      } else {
        // Fallback for raw PCM (24kHz, 16-bit mono LE)
        const sampleRate = 24000;
        const wavHeader = new ArrayBuffer(44);
        const view = new DataView(wavHeader);

        view.setUint32(0, 0x52494646, false); // "RIFF"
        view.setUint32(4, 36 + len, true);    // Chunk size
        view.setUint32(8, 0x57415645, false); // "WAVE"
        view.setUint32(12, 0x666D7420, false); // "fmt "
        view.setUint32(16, 16, true);          // Subchunk1Size
        view.setUint16(20, 1, true);           // AudioFormat
        view.setUint16(22, 1, true);           // NumChannels
        view.setUint32(24, sampleRate, true);  // SampleRate
        view.setUint32(28, sampleRate * 2, true); // ByteRate
        view.setUint16(32, 2, true);           // BlockAlign
        view.setUint16(34, 16, true);          // BitsPerSample
        view.setUint32(36, 0x64617461, false); // "data"
        view.setUint32(40, len, true);         // Subchunk2Size

        blob = new Blob([wavHeader, bytes], { type: 'audio/wav' });
      }

      const audioUrl = URL.createObjectURL(blob);
      return { audioUrl };
    } catch (err: any) {
      console.warn(`TTS attempt with ${model} failed:`, err);
      lastError = err;
    }
  }

  console.error("All TTS waterfall attempts failed", lastError);
  return { audioUrl: null };
}

export class StreamAnalyzerSession {
  private history: any[] = [];
  private streamIdentifier: string;
  private channelDeliveryStyle?: string;

  constructor(streamIdentifier: string, existingHistory: any[] = []) {
    this.streamIdentifier = streamIdentifier;
    this.history = existingHistory;
  }

  getHistory() {
    return this.history;
  }

  getDeliveryStyle(): string | undefined {
    return this.channelDeliveryStyle;
  }

  setDeliveryStyle(style: string) {
    this.channelDeliveryStyle = style;
  }

  async initialize(modelPreference: GeminiModelPreference = 'pro'): Promise<{ channelName?: string; deliveryStyle?: string } | undefined> {
    if (this.history.length > 0) return undefined; // Skip initialization if we recovered history
    const prompt = `You are an AI co-host for a livestreamer. The current livestream identifier/URL is: ${this.streamIdentifier}. The current time is ${new Date().toISOString()}. 
    
First, use Google Search to find information, recent uploaded videos, stream archives, community updates, or news about this creator or channel (${this.streamIdentifier}) to understand their background, niche, typical speaking cadence, vocal delivery, and CURRENT context. Build a comprehensive internal profile of this creator.

Output a JSON object with:
1. 'channelName': the primary display name or handle of this creator.
2. 'deliveryStyle': a concise 10-15 word description of their typical vocal cadence, delivery, demeanor, and banter style (e.g. "Relaxed, deadpan humor with steady, nonchalant conversational cadence", "High-energy quick banter with witty sarcastic comebacks", "Calm, low-key observational humor"). This will be used to calibrate an AI co-host's TTS cadence and nonchalance to match the streamer and avoid being overly bright or chirpy.`;

    const userContent = { role: 'user', parts: [{ text: prompt }] };
    
    const response = await generateWithFallback({
      contents: [userContent],
      config: {
        tools: [{ googleSearch: {} }],
        toolConfig: { includeServerSideToolInvocations: true },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            channelName: { type: Type.STRING },
            deliveryStyle: { type: Type.STRING }
          },
          required: ["channelName"]
        }
      }
    }, modelPreference);

    this.history.push(userContent);
    if (response.candidates?.[0]?.content) {
      this.history.push(response.candidates[0].content);
    }

    try {
      if (response.text) {
        const parsed = JSON.parse(response.text);
        if (parsed.deliveryStyle) {
          this.channelDeliveryStyle = parsed.deliveryStyle;
        }
        return { channelName: parsed.channelName, deliveryStyle: parsed.deliveryStyle };
      }
    } catch (e) {
      console.error("Failed to parse channel info", e);
    }
    return undefined;
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

  async getTopics(style: SuggestionStyle, transcript: string, intervalMinutes: number, audioBase64?: string, audioMimeType?: string, modelPreference: GeminiModelPreference = 'flash'): Promise<{summary?: string, topics: TopicSuggestion[]}> {
    let styleInstruction = "";
    if (style === 'personalized') {
      styleInstruction = "Highly relevant to the current conversation or the creator's specific niche.";
    } else if (style === 'balanced') {
      styleInstruction = "A mix of natural follow-ups to the current topic and broader channel-related themes.";
    } else if (style === 'abstract') {
      styleInstruction = "Fun pivots, new tangents, or broader questions to completely refresh the conversation.";
    }

    let responseCountStr = "3";
    if (intervalMinutes <= 1) responseCountStr = "1-2";
    else if (intervalMinutes <= 3) responseCountStr = "2-3 (prefer 2)";
    else if (intervalMinutes <= 5) responseCountStr = "2-4 (prefer 3)";
    else responseCountStr = "up to 7";

    const transcriptInfo = transcript.trim() ? `Browser background transcript (may contain errors, use to understand broader context between audio clips): "${transcript}"` : "No background transcript available.";

    const promptText = `You are an interactive AI co-host engaging in a live dialogue with the streamer. Based on their profile and the current stream context (especially the recent audio), provide ${responseCountStr} short, conversational responses or prompts that you (the co-host) are saying directly to the streamer. The streamer will read these to continue the back-and-forth dialogue.
    
Context given:
${transcriptInfo}

${audioBase64 ? "I have also provided the most recent high-quality 60-second audio clip. YOU MUST HEAVILY WEIGHT THIS AUDIO CLIP OVER THE TRANSCRIPT. Rely on the audio for accurate tone, energy, and the immediate context since the transcript may have errors or lack nuance. First, provide a 1-sentence 'summary' of the ongoing conversation to maintain continuity in our history. Then, suggest natural follow-ups, new angles, or pivot topics." : "No recent audio available. Leave the 'summary' empty and suggest engaging topics based on their general profile and transcript."}

CRITICAL REQUIREMENTS:
1. Goal: Act as an engaging co-host. Your responses should read like natural dialogue spoken directly to the streamer.
2. Tone & Candor: Keep responses nonchalant, casual, and grounded. Match the creator's natural banter cadence${this.channelDeliveryStyle ? ` (${this.channelDeliveryStyle})` : ''}. Avoid sounding overly bright, cheerleading, or robotic; speak like an unbothered, witty companion sitting right beside them.
3. Format: Use conversational, punchy sentences. Ask follow-up questions, make witty observations, or share a hot take as if you are sitting next to them. (e.g., "Honestly though, what if the meta flips?", "I don't know, hear me out...", "Wait, tell me you saved that clip.").
4. Structure: If your response is directly replying to something specific the streamer just said, include their exact phrase in the 'quote' field. If it's a new interjection or topic pivot, omit the 'quote' field. The 'text' field should be your actual response.
5. Brevity: Keep each response under 10-15 words. It must be readable in a split-second glance so the streamer can react to it live.
6. Style: ${styleInstruction}
7. Progress the Conversation: Do not just summarize what they just said. Actively participate by providing the *next* logical hook, a provocative question, or a fresh new angle as a co-host.
8. STRICTLY NO REPEATS: Carefully review the context history. DO NOT suggest any dialogue or ideas that you have already used previously. Freshness is paramount.

Return JSON with 'summary' (string) and 'topics' (array of objects with optional 'quote' and required 'text').`;

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

    const response = await generateWithFallback({
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
              items: { 
                type: Type.OBJECT,
                properties: {
                  quote: { type: Type.STRING },
                  text: { type: Type.STRING }
                },
                required: ["text"]
              }
            }
          },
          required: ["summary", "topics"]
        }
      }
    }, modelPreference);

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
