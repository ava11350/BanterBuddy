import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { spawn } from "child_process";
import dotenv from "dotenv";
dotenv.config();

export async function transcodeAudioToWav(base64Data: string): Promise<string | null> {
  try {
    const inputBuffer = Buffer.from(base64Data, "base64");
    if (inputBuffer.length < 100) return null;

    return await new Promise<string>((resolve) => {
      let isResolved = false;
      const ff = spawn("ffmpeg", [
        "-i", "pipe:0",
        "-t", "30",            // Max 30 seconds of audio
        "-ar", "16000",        // 16kHz sample rate
        "-ac", "1",            // Mono
        "-c:a", "pcm_s16le",   // 16-bit PCM WAV
        "-f", "wav",
        "pipe:1"
      ]);

      const chunks: Buffer[] = [];
      ff.stdout.on("data", (chunk) => chunks.push(chunk));
      ff.stderr.on("data", () => {}); // silence stderr

      // CRITICAL: Prevent unhandled EPIPE crashes if ffmpeg exits early
      ff.stdin.on("error", () => {});

      ff.on("error", (err) => {
        if (!isResolved) {
          isResolved = true;
          console.warn("[Server Audio] Transcoder process notice:", err?.message || err);
          resolve(null);
        }
      });

      ff.on("close", (code) => {
        if (!isResolved) {
          isResolved = true;
          if (code === 0 && chunks.length > 0) {
            const wavBuffer = Buffer.concat(chunks);
            resolve(wavBuffer.toString("base64"));
          } else {
            resolve(null);
          }
        }
      });

      try {
        ff.stdin.write(inputBuffer);
        ff.stdin.end();
      } catch (_) {
        if (!isResolved) {
          isResolved = true;
          resolve(null);
        }
      }
    });
  } catch (err: any) {
    console.warn("[Server Audio] Transcoding notice:", err?.message || err);
    return null;
  }
}

// Create server-side shared Gemini client with required User-Agent header
export function getApiKey(): string {
  dotenv.config();
  return process.env.GEMINI_API_KEY || process.env.API_KEY || process.env.GOOGLE_API_KEY || '';
}

export function isApiKeyConfigured(): boolean {
  const key = getApiKey();
  return Boolean(key && key.trim().length > 0 && key !== 'MY_GEMINI_API_KEY');
}

export function isApiKeyError(error: any): boolean {
  if (!isApiKeyConfigured()) return true;
  const msg = String(error?.message || error || '').toLowerCase();
  const status = error?.status || error?.statusCode;
  return (status === 400 && (msg.includes('api key not valid') || msg.includes('api_key_invalid') || msg.includes('invalid api key'))) ||
         status === 401 || 
         status === 403 || 
         msg.includes('api key not valid') || 
         msg.includes('api_key_invalid') || 
         msg.includes('invalid api key') || 
         msg.includes('permission_denied') || 
         msg.includes('unauthenticated') || 
         msg.includes('api key is required') || 
         msg.includes('pass a valid api key');
}

export const ai = new GoogleGenAI({
  apiKey: getApiKey(),
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

export type SuggestionStyle = 'personalized' | 'balanced' | 'abstract';
export type GeminiModelPreference = 'pro' | 'flash' | 'flash-lite';
export type TTSModelOption = 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts';

// Quota and feature circuit breakers for Free Tier keys
let proQuotaExhaustedUntil = 0;
let searchGroundingExhaustedUntil = 0;

export function getModelWaterfall(preference: GeminiModelPreference = 'flash'): string[] {
  const now = Date.now();
  if (preference === 'flash') {
    return ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
  }
  if (preference === 'flash-lite') {
    return ['gemini-3.1-flash-lite', 'gemini-3.8-flash'];
  }
  // If pro was requested but Pro quota is currently exhausted (Free Tier), route to Flash
  if (now < proQuotaExhaustedUntil) {
    return ['gemini-3.8-flash', 'gemini-3.1-flash-lite'];
  }
  return ['gemini-4-argon', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
}

function isQuotaOr429Error(error: any): boolean {
  const msg = String(error?.message || error || '').toLowerCase();
  const status = error?.status;
  return status === 429 || 
         msg.includes('429') || 
         msg.includes('resource_exhausted') || 
         msg.includes('quota') ||
         msg.includes('rate limit');
}

export async function generateWithFallback(requestConfig: any, preference: GeminiModelPreference = 'flash') {
  let waterfall = getModelWaterfall(preference);
  let lastError: any = null;
  
  for (const model of waterfall) {
    try {
      const request = { ...requestConfig, model };
      console.log(`[Server Waterfall] Attempting request with model: ${model}`);
      
      // Allow up to 16 seconds per model attempt with ThinkingLevel.LOW
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Model ${model} timed out after 16s`)), 16000)
      );

      const response = await Promise.race([
        ai.models.generateContent(request),
        timeoutPromise
      ]);

      console.log(`[Server Waterfall] Successfully generated with model: ${model}`);
      return response;
    } catch (error: any) {
      if (isApiKeyError(error)) {
        console.warn(`[Server Waterfall] Gemini API key failure detected on model ${model}:`, error?.message || error);
        throw error;
      }
      if (isQuotaOr429Error(error)) {
        if (model === 'gemini-4-argon') {
          console.log(`[Server Waterfall] Gemini Pro quota exhausted (Free Tier detected). Routing to Flash models.`);
          proQuotaExhaustedUntil = Date.now() + 15 * 60 * 1000;
        } else {
          console.warn(`[Server Waterfall] Model ${model} quota rate limit encountered. Falling back to next model.`);
        }
      } else {
        console.warn(`[Server Waterfall] Model ${model} failed, falling back to next model. Error:`, error?.message || error);
      }
      lastError = error;
    }
  }
  
  throw lastError;
}

// Generate a valid 0.8s silent WAV buffer (24kHz 16-bit mono)
function createSilentWavBase64(): string {
  const sampleRate = 24000;
  const numSamples = sampleRate; // 1 second
  const byteRate = sampleRate * 2;
  const blockAlign = 2;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // 16-bit
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer.toString("base64");
}

export async function handleTTS(
  text: string, 
  voiceName: string = 'Aoede',
  styleInstruction?: string,
  modelName: TTSModelOption = 'gemini-3.8-flash-lite-tts'
): Promise<{ audioBase64: string; mimeType: string; apiKeyError?: { type: string; message: string } }> {
  if (!isApiKeyConfigured()) {
    console.warn("[Server TTS] No Gemini API key configured for speech synthesis.");
    return {
      audioBase64: createSilentWavBase64(),
      mimeType: 'audio/wav',
      apiKeyError: {
        type: 'missing',
        message: 'No GEMINI_API_KEY detected in server environment.'
      }
    };
  }

  const style = styleInstruction || 
    "Nonchalant, casual streamer co-host, relaxed and effortless cadence, understated and casual, matching natural chill streamer banter, unbothered, cool, and conversational without being overly bright, cheerleading, or chirpy.";

  const ttsWaterfall: string[] = modelName === 'gemini-3.8-flash-tts'
    ? ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']
    : ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];

  let lastError: any = null;

  for (const model of ttsWaterfall) {
    try {
      console.log(`[Server TTS] Attempting TTS generation with model: ${model}`);
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
      if (inlineData?.data) {
        return {
          audioBase64: inlineData.data,
          mimeType: inlineData.mimeType || 'audio/wav'
        };
      }
    } catch (err: any) {
      console.warn(`[Server TTS] Attempt with ${model} failed:`, err?.message || err);
      lastError = err;
      if (isApiKeyError(err)) {
        break; // Fast fail if API key itself is unauthorized
      }
    }
  }

  const isKeyError = isApiKeyError(lastError);
  console.warn("[Server TTS] All TTS model attempts failed, returning silent audio fallback:", lastError?.message || lastError);
  return {
    audioBase64: createSilentWavBase64(),
    mimeType: 'audio/wav',
    apiKeyError: isKeyError ? {
      type: 'invalid',
      message: lastError?.message || 'Gemini API key is invalid or rejected.'
    } : undefined
  };
}

function extractChannelName(streamIdentifier: string): string {
  let cleaned = streamIdentifier.trim();
  if (cleaned.includes('youtube.com/')) {
    try {
      const url = new URL(cleaned.startsWith('http') ? cleaned : `https://${cleaned}`);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length > 0) {
        const last = parts[parts.length - 1];
        if (last !== 'live') return last.replace(/^@/, '');
        if (parts.length > 1) return parts[parts.length - 2].replace(/^@/, '');
      }
    } catch (_) {}
  }
  return cleaned.replace(/^@/, '').split('/')[0] || 'Streamer';
}

export async function handleInitializeStream(
  streamIdentifier: string, 
  modelPreference: GeminiModelPreference = 'flash'
) {
  const channelNameFromId = extractChannelName(streamIdentifier);
  const prompt = `You are an AI co-host for a livestreamer. The livestream identifier/URL is: ${streamIdentifier} (channel handle: @${channelNameFromId}). The current time is ${new Date().toISOString()}.
    
Analyze this creator or channel (${streamIdentifier}) to understand their background, niche, typical speaking cadence, vocal delivery, and conversational context. Build a comprehensive internal profile of this creator.

Output a JSON object with:
1. 'channelName': the primary display name or handle of this creator.
2. 'deliveryStyle': a concise 10-15 word description of their typical vocal cadence, delivery, demeanor, and banter style (e.g. "Relaxed, deadpan humor with steady, nonchalant conversational cadence", "High-energy quick banter with witty sarcastic comebacks", "Calm, low-key observational humor"). This will be used to calibrate an AI co-host's TTS cadence and nonchalance to match the streamer and avoid being overly bright or chirpy.`;

  const userContent = { role: 'user', parts: [{ text: prompt }] };
  
  if (!isApiKeyConfigured()) {
    console.warn("[Server] No Gemini API key configured for initialize stream.");
    return {
      channelName: channelNameFromId,
      deliveryStyle: "Relaxed, deadpan humor with steady, nonchalant conversational cadence",
      groundSearchSuccessful: false,
      apiKeyError: {
        type: 'missing',
        message: 'No GEMINI_API_KEY detected in server environment.'
      },
      userContent,
      modelContent: {
        role: "model",
        parts: [{ text: JSON.stringify({ channelName: channelNameFromId, deliveryStyle: "Relaxed, deadpan humor with steady, nonchalant conversational cadence" }) }]
      }
    };
  }
  
  try {
    let response: any = null;
    let isGroundSearchSuccessful = false;
    const canAttemptSearch = Date.now() >= searchGroundingExhaustedUntil;

    if (canAttemptSearch) {
      try {
        console.log("[Server] Analyzing channel profile with Search grounding probe...");
        const timeoutPromise = new Promise<never>((_, reject) => 
          setTimeout(() => reject(new Error("Search probe timed out")), 25000)
        );

        response = await Promise.race([
          ai.models.generateContent({
            model: "gemini-3.8-flash",
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
          }),
          timeoutPromise
        ]);
        if (response) {
          isGroundSearchSuccessful = true;
          console.log("[Server] Ground Search (channel analysis) was successful! Channel profile grounded from live web context.");
        }
      } catch (searchError: any) {
        if (isQuotaOr429Error(searchError)) {
          console.log("[Server] Search grounding quota depleted or unavailable on Free Tier (429). Activating 30m circuit breaker and using direct model analysis.");
          searchGroundingExhaustedUntil = Date.now() + 30 * 60 * 1000;
        } else {
          console.log("[Server] Search grounding probe skipped:", searchError?.message || searchError);
        }
        response = null;
      }
    }

    // Direct model generation without search tools (bypasses 429 quota restrictions on Free Tier)
    if (!response) {
      console.log("[Server] Generating channel profile directly without search tool...");
      response = await generateWithFallback({
        contents: [userContent],
        config: {
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
    }

    let parsed: any = {};
    if (response?.text) {
      try {
        parsed = JSON.parse(response.text);
      } catch (e) {
        console.warn("Failed to parse channel info JSON:", e);
      }
    }

    const channelName = parsed.channelName || channelNameFromId;
    const deliveryStyle = parsed.deliveryStyle || "Relaxed, deadpan humor with steady, nonchalant conversational cadence";

    return {
      channelName,
      deliveryStyle,
      groundSearchSuccessful: isGroundSearchSuccessful,
      userContent,
      modelContent: response?.candidates?.[0]?.content || {
        role: "model",
        parts: [{ text: JSON.stringify({ channelName, deliveryStyle }) }]
      }
    };
  } catch (error: any) {
    console.warn("[Server] InitializeStream fallback profile activated:", error?.message || error);
    const channelName = channelNameFromId;
    const deliveryStyle = "Relaxed, deadpan humor with steady, nonchalant conversational cadence";
    const keyError = isApiKeyError(error);

    return {
      channelName,
      deliveryStyle,
      groundSearchSuccessful: false,
      apiKeyError: keyError ? {
        type: 'invalid',
        message: error?.message || 'Gemini API key is invalid or rejected.'
      } : undefined,
      userContent,
      modelContent: {
        role: "model",
        parts: [{ text: JSON.stringify({ channelName, deliveryStyle }) }]
      }
    };
  }
}

export function sanitizeContents(contents: any[]): any[] {
  if (!Array.isArray(contents) || contents.length === 0) {
    return [{ role: 'user', parts: [{ text: "Stream dialogue initialization" }] }];
  }

  const sanitized: any[] = [];
  
  for (const item of contents) {
    if (!item || !item.role || !Array.isArray(item.parts) || item.parts.length === 0) {
      continue;
    }

    const currentRole = item.role === 'model' ? 'model' : 'user';

    if (sanitized.length === 0) {
      // First message in multi-turn conversation must be 'user'
      if (currentRole === 'user') {
        sanitized.push({ role: 'user', parts: item.parts });
      }
    } else {
      const lastRole = sanitized[sanitized.length - 1].role;
      if (lastRole === currentRole) {
        // Enforce strict alternation: merge consecutive user turns, keep latest model turn
        if (currentRole === 'user') {
          sanitized[sanitized.length - 1].parts = [
            ...sanitized[sanitized.length - 1].parts,
            ...item.parts
          ];
        } else {
          sanitized[sanitized.length - 1] = { role: 'model', parts: item.parts };
        }
      } else {
        sanitized.push({ role: currentRole, parts: item.parts });
      }
    }
  }

  if (sanitized.length === 0) {
    sanitized.push({ role: 'user', parts: [{ text: "Stream dialogue update" }] });
  }

  // Ensure last message is 'user' before sending to Gemini
  if (sanitized[sanitized.length - 1].role !== 'user') {
    sanitized.push({ role: 'user', parts: [{ text: "Provide the next live dialogue update." }] });
  }

  return sanitized;
}

function generateFallbackTopics(
  style: SuggestionStyle,
  transcript: string,
  channelDeliveryStyle?: string
): { summary: string; topics: { quote?: string; text: string }[] } {
  let quote: string | undefined;
  if (transcript && transcript.trim().length > 10) {
    const sentences = transcript.trim().split(/[.?!]/).map(s => s.trim()).filter(s => s.length > 5);
    if (sentences.length > 0) {
      const last = sentences[sentences.length - 1];
      quote = last.length > 60 ? last.slice(-60) : last;
    }
  }

  const personalizedPool = [
    { text: "Honestly though, what's your take on that last move?" },
    { text: "Wait, hear me out — is that actually the meta right now?" },
    { text: "Chat was definitely reacting to that play." },
    { text: "That setup felt smooth. Are you sticking with it?" },
    { text: "Quick read: are you feeling confident about this match?" },
    { text: "Honestly, that was way closer than it looked." },
    { text: "Wait, do you think chat saw that angle?" },
    { text: "That looked clean. What's the plan for next round?" }
  ];

  const balancedPool = [
    { text: "I don't know, could definitely go either way." },
    { text: "Fair point. Where do you think we take this next?" },
    { text: "Wait, did you see how fast that shifted?" },
    { text: "That reminds me of your earlier run. Huge difference." },
    { text: "Honestly, that was an unexpected turn of events." },
    { text: "How are we feeling about the pace so far?" },
    { text: "Good timing on that. What's the main focus now?" },
    { text: "That looked solid. Are we playing it safe or going aggressive?" }
  ];

  const abstractPool = [
    { text: "Completely off-topic, but what's your top moment this week?" },
    { text: "Hot take time: what's the most overrated thing right now?" },
    { text: "Quick pivot — if you had to change the stream goal right now?" },
    { text: "Wait, imagine if the devs actually patched that tomorrow." },
    { text: "Random question for chat: best comfort food while gaming?" },
    { text: "If you could instantly master one mechanic, what is it?" },
    { text: "Off-topic tangent: what game has the best soundtrack?" },
    { text: "Quick pulse check on the stream vibe right now." }
  ];

  const pool = style === 'personalized' ? personalizedPool : style === 'abstract' ? abstractPool : balancedPool;

  // Shuffle pool so fallback topics don't repeat the exact same three
  const shuffled = [...pool].sort(() => Math.random() - 0.5);

  const topics = shuffled.slice(0, 3).map((item, idx) => {
    if (idx === 0 && quote) {
      return { quote, text: item.text };
    }
    return item;
  });

  return {
    summary: quote ? `Streamer was discussing: "${quote}"` : "Active stream dialogue and chat engagement.",
    topics
  };
}

export async function handleGetTopics(
  style: SuggestionStyle,
  transcript: string,
  intervalMinutes: number,
  audioBase64?: string,
  audioMimeType?: string,
  modelPreference: GeminiModelPreference = 'flash',
  history: any[] = [],
  channelDeliveryStyle?: string
) {
  let styleInstruction = "";
  if (style === 'personalized') {
    styleInstruction = "Highly relevant to the current conversation or the creator's specific niche.";
  } else if (style === 'balanced') {
    styleInstruction = "A mix of natural follow-ups to the current topic and broader channel-related themes.";
  } else if (style === 'abstract') {
    styleInstruction = "Fun pivots, new tangents, or broader questions to completely refresh the conversation.";
  }

  if (!isApiKeyConfigured()) {
    console.warn("[Server] No Gemini API key configured for dialogue generation.");
    const fallback = generateFallbackTopics(style, transcript, channelDeliveryStyle);
    return {
      summary: fallback.summary,
      topics: fallback.topics,
      apiKeyError: {
        type: 'missing',
        message: 'No GEMINI_API_KEY detected in server environment.'
      },
      userContentForHistory: { role: 'user', parts: [{ text: "Stream dialogue update" }] },
      modelContentForHistory: {
        role: "model",
        parts: [{ text: JSON.stringify(fallback) }]
      }
    };
  }

  let responseCountStr = "3";
  if (intervalMinutes <= 1) responseCountStr = "1-2";
  else if (intervalMinutes <= 3) responseCountStr = "2-3 (prefer 2)";
  else if (intervalMinutes <= 5) responseCountStr = "2-4 (prefer 3)";
  else responseCountStr = "3-4";

  const transcriptInfo = transcript.trim() ? `Browser background transcript (may contain errors, use to understand broader context between audio clips): "${transcript}"` : "No background transcript available.";

  const promptText = `You are an interactive AI co-host engaging in a live dialogue with the streamer. Based on their profile and the current stream context (especially the recent audio), provide ${responseCountStr} short, conversational responses or prompts that you (the co-host) are saying directly to the streamer. The streamer will read these to continue the back-and-forth dialogue.
  
Context given:
${transcriptInfo}

${audioBase64 ? "I have also provided the most recent high-quality 60-second audio clip. YOU MUST HEAVILY WEIGHT THIS AUDIO CLIP OVER THE TRANSCRIPT. Rely on the audio for accurate tone, energy, and the immediate context since the transcript may have errors or lack nuance. First, provide a 1-sentence 'summary' of the ongoing conversation to maintain continuity in our history. Then, suggest natural follow-ups, new angles, or pivot topics." : "No recent audio available. Leave the 'summary' empty and suggest engaging topics based on their general profile and transcript."}

CRITICAL REQUIREMENTS:
1. Goal: Act as an engaging co-host. Your responses should read like natural dialogue spoken directly to the streamer.
2. Tone & Candor: Keep responses nonchalant, casual, and grounded. Match the creator's natural banter cadence${channelDeliveryStyle ? ` (${channelDeliveryStyle})` : ''}. Avoid sounding overly bright, cheerleading, or robotic; speak like an unbothered, witty companion sitting right beside them.
3. Format: Use conversational, punchy sentences. Ask follow-up questions, make witty observations, or share a hot take as if you are sitting next to them. (e.g., "Honestly though, what if the meta flips?", "I don't know, hear me out...", "Wait, tell me you saved that clip.").
4. Structure: If your response is directly replying to something specific the streamer just said, include their exact phrase in the 'quote' field. If it's a new interjection or topic pivot, omit the 'quote' field. The 'text' field should be your actual response.
5. Brevity: Keep each response under 10-15 words. It must be readable in a split-second glance so the streamer can react to it live.
6. Style: ${styleInstruction}
7. Progress the Conversation: Do not just summarize what they just said. Actively participate by providing the *next* logical hook, a provocative question, or a fresh new angle as a co-host.
8. STRICTLY NO REPEATS: Carefully review the context history. DO NOT suggest any dialogue or ideas that you have already used previously. Freshness is paramount.

Return JSON with 'summary' (string) and 'topics' (array of objects with optional 'quote' and required 'text').`;

  const newParts: any[] = [{ text: promptText }];
  let hasValidAudio = false;

  if (audioBase64 && audioMimeType) {
    const rawMime = audioMimeType.split(';')[0].toLowerCase();
    let wavBase64: string | null = null;

    if (rawMime === 'audio/wav' || rawMime === 'audio/x-wav') {
      wavBase64 = audioBase64;
    } else {
      // Transcode WebM / Opus / other browser formats to 16kHz mono WAV for Gemini native audio ingest
      wavBase64 = await transcodeAudioToWav(audioBase64);
    }

    if (wavBase64) {
      hasValidAudio = true;
      newParts.push({
        inlineData: {
          data: wavBase64,
          mimeType: 'audio/wav'
        }
      });
    } else {
      console.warn("[Server] Audio could not be transcoded to WAV, proceeding with transcript context.");
    }
  }

  const newUserContent = { role: 'user', parts: newParts };
  const currentContents = sanitizeContents([...history, newUserContent]);

  let response: any = null;

  try {
    response = await generateWithFallback({
      contents: currentContents,
      config: {
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
  } catch (error: any) {
    if (isApiKeyError(error)) {
      throw error;
    }

    // Resilience: If multimodal request with audio failed or timed out, retry immediately with prompt & transcript only
    if (hasValidAudio) {
      console.warn("[Server] Multimodal audio request notice, immediately retrying with stream context:", error?.message || error);
      const textOnlyContent = { role: 'user', parts: [{ text: promptText }] };
      const fallbackContents = sanitizeContents([...history, textOnlyContent]);
      try {
        response = await generateWithFallback({
          contents: fallbackContents,
          config: {
            responseMimeType: "application/json",
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
      } catch (retryError: any) {
        if (isApiKeyError(retryError)) throw retryError;
        console.warn("[Server] Text retry also encountered notice:", retryError?.message || retryError);
      }
    } else {
      console.warn("[Server] Dialogue generation encountered notice:", error?.message || error);
    }
  }

  if (!response) {
    console.warn("[Server] Activating safe fallback topics.");
    const fallback = generateFallbackTopics(style, transcript, channelDeliveryStyle);
    return {
      summary: fallback.summary,
      topics: fallback.topics,
      userContentForHistory: { role: 'user', parts: [{ text: promptText }] },
      modelContentForHistory: {
        role: "model",
        parts: [{ text: JSON.stringify(fallback) }]
      }
    };
  }

  let parsed: any = { topics: [] };
  const text = response.text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.warn("Failed to parse topics JSON:", e);
    }
  }

  // Safety net: if model returned empty topics array or failed schema, populate with fallback
  if (!Array.isArray(parsed.topics) || parsed.topics.length === 0) {
    console.warn("[Server] Model returned 0 topics, generating co-host fallback topics.");
    const fallback = generateFallbackTopics(style, transcript, channelDeliveryStyle);
    parsed.topics = fallback.topics;
    if (!parsed.summary) {
      parsed.summary = fallback.summary;
    }
  }

  const modelContent = response.candidates?.[0]?.content || {
    role: "model",
    parts: [{ text: JSON.stringify(parsed) }]
  };

  return {
    summary: parsed.summary,
    topics: parsed.topics || [],
    userContentForHistory: { role: 'user', parts: [{ text: promptText }] },
    modelContentForHistory: modelContent
  };
}
