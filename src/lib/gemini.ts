export type SuggestionStyle = 'personalized' | 'balanced' | 'abstract';
export type GeminiModelPreference = 'pro' | 'flash' | 'flash-lite';
export type TTSModelOption = 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts';

export interface TopicSuggestion { quote?: string; text: string; }

export type ApiKeyErrorInfo = {
  type: 'missing' | 'invalid' | 'quota' | 'general';
  message: string;
};

type ApiKeyErrorListener = (error: ApiKeyErrorInfo | null) => void;
const apiKeyErrorListeners = new Set<ApiKeyErrorListener>();

export function subscribeApiKeyError(listener: ApiKeyErrorListener) {
  apiKeyErrorListeners.add(listener);
  return () => { apiKeyErrorListeners.delete(listener); };
}

export function notifyApiKeyError(error: ApiKeyErrorInfo | null) {
  apiKeyErrorListeners.forEach(listener => {
    try { listener(error); } catch (e) { console.error(e); }
  });
}

export async function checkApiKeyStatus(verify = false): Promise<ApiKeyErrorInfo | null> {
  try {
    const res = await fetch(`/api/gemini/status${verify ? '?verify=true' : ''}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && !data.ok)) {
      const err: ApiKeyErrorInfo = data?.apiKeyError || {
        type: 'general',
        message: 'Could not connect to Gemini API service.'
      };
      notifyApiKeyError(err);
      return err;
    }
    notifyApiKeyError(null);
    return null;
  } catch (e: any) {
    console.debug("[Client] API status check notice:", e);
    return null;
  }
}

export async function generateTTSAudio(
  text: string, 
  voiceName: string = 'Aoede',
  styleInstruction?: string,
  modelName: TTSModelOption = 'gemini-3.8-flash-lite-tts'
): Promise<{ audioUrl: string | null }> {
  try {
    const response = await fetch('/api/gemini/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voiceName,
        styleInstruction,
        modelName,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.warn("[Client TTS] Server returned error:", errData);
      return { audioUrl: null };
    }

    const data = await response.json().catch(() => ({}));
    if (data?.apiKeyError) {
      notifyApiKeyError(data.apiKeyError);
    }

    const audioBase64 = data?.audioBase64;
    if (!audioBase64) {
      return { audioUrl: null };
    }

    // Decode base64 audio
    const binaryString = window.atob(audioBase64);
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
  } catch (err) {
    console.error("[Client TTS] Request failed:", err);
    return { audioUrl: null };
  }
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

  async initialize(modelPreference: GeminiModelPreference = 'flash'): Promise<{ channelName?: string; deliveryStyle?: string } | undefined> {
    if (this.history.length > 0) return undefined; // Skip initialization if we recovered history

    try {
      const response = await fetch('/api/gemini/analyze/init', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          streamIdentifier: this.streamIdentifier,
          modelPreference,
        }),
      });

      if (!response.ok) {
        console.warn("[Client] Could not retrieve stream profile from server, using fallback");
        return undefined;
      }

      const data = await response.json();
      if (data.apiKeyError) {
        notifyApiKeyError(data.apiKeyError);
      }
      if (data.userContent) {
        this.history.push(data.userContent);
      }
      if (data.modelContent) {
        this.history.push(data.modelContent);
      }

      if (data.deliveryStyle) {
        this.channelDeliveryStyle = data.deliveryStyle;
      }

      if (data.groundSearchSuccessful) {
        console.log(`[Client] Ground Search (channel analysis) was successful! Calibrated cadence: "${data.deliveryStyle}"`);
      }

      return {
        channelName: data.channelName,
        deliveryStyle: data.deliveryStyle,
      };
    } catch (e) {
      console.warn("[Client] Initialize notice:", e);
      return undefined;
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

  async getTopics(
    style: SuggestionStyle, 
    transcript: string, 
    intervalMinutes: number, 
    audioBase64?: string, 
    audioMimeType?: string, 
    modelPreference: GeminiModelPreference = 'flash'
  ): Promise<{summary?: string, topics: TopicSuggestion[]}> {
    try {
      const response = await fetch('/api/gemini/analyze/topics', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          style,
          transcript,
          intervalMinutes,
          audioBase64,
          audioMimeType,
          modelPreference,
          history: this.history,
          channelDeliveryStyle: this.channelDeliveryStyle,
        }),
      });

      if (!response.ok) {
        console.warn("[Client] Could not fetch topics from server, using fallback");
        return { topics: [] };
      }

      const data = await response.json();
      if (data.apiKeyError) {
        notifyApiKeyError(data.apiKeyError);
      }

      if (data.userContentForHistory) {
        this.history.push(data.userContentForHistory);
      }
      if (data.modelContentForHistory) {
        this.history.push(data.modelContentForHistory);
      }

      this.pruneHistory();

      return {
        summary: data.summary,
        topics: data.topics || [],
      };
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        console.debug("[Client] getTopics notice:", e?.message || e);
      }
      return { topics: [] };
    }
  }
}
