/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { StreamAnalyzerSession, SuggestionStyle, GeminiModelPreference, TopicSuggestion, generateTTSAudio, TTSModelOption } from './lib/gemini';
import { checkIfLiveDirectly } from './lib/youtube';
import { 
  Sparkles, 
  Volume2, 
  Square, 
  RefreshCw, 
  Clock, 
  Loader2, 
  Link as LinkIcon, 
  Activity, 
  Pause, 
  Play, 
  Mic, 
  MicOff, 
  X,
  Zap,
  RotateCcw,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  getCachedTTSAudio, 
  storeCachedTTSAudio, 
  getRecentTTSCache, 
  clearTTSCache, 
  subscribeTTSCache, 
  CachedTTSQuery 
} from './lib/ttsCache';

export type TTSDemeanor = 'matched' | 'nonchalant' | 'deadpan' | 'casual' | 'lowkey';

function getDeliveryStyleInstruction(demeanor: TTSDemeanor, channelCadence?: string): string {
  if (demeanor === 'matched') {
    if (channelCadence && channelCadence.trim()) {
      return `Nonchalant, casual co-host dialogue specifically matching the creator's uploaded content style: ${channelCadence}. Relaxed, effortless cadence, natural stream banter, understated and unbothered, avoiding overly bright or corporate tones.`;
    }
    return "Nonchalant, conversational stream co-host, relaxed and effortless cadence, understated and casual, matching natural chill streamer banter, unbothered, cool, and conversational without being overly bright, cheerleading, or chirpy.";
  }
  if (demeanor === 'deadpan') {
    return "Deadpan, dry wit, low-energy nonchalant streamer delivery, understated and relaxed, unbothered cadence without forced excitement.";
  }
  if (demeanor === 'casual') {
    return "Casual, natural stream banter, effortless delivery, relaxed co-host cadence, cool and conversational.";
  }
  if (demeanor === 'lowkey') {
    return "Low-key, subdued, quiet nonchalant delivery, calm and relaxed streamer rhythm.";
  }
  return "Nonchalant, conversational stream co-host, relaxed and effortless cadence, understated and casual, matching natural chill streamer delivery, unbothered, cool, and conversational without being overly bright, cheerleading, or chirpy.";
}

type TopicGroup = {
  id: string;
  timestamp: Date;
  elapsedAt: number;
  topics: (string | TopicSuggestion)[];
};

export default function App() {
  const [streamInput, setStreamInput] = useState(() => {
    const lastInUse = localStorage.getItem('banterBuddy_lastIdentifier');
    if (lastInUse) return lastInUse;

    const saved = localStorage.getItem('banterBuddy_streamInput');
    if (saved) return saved;
    
    // Fallback: Recover from aiHistory if available but streamInput was lost
    try {
      const historyStr = localStorage.getItem('banterBuddy_aiHistory');
      if (historyStr) {
        const h = JSON.parse(historyStr);
        if (h.length > 0 && h[0].parts?.[0]?.text) {
          const match = h[0].parts[0].text.match(/identifier\/URL is:\s*(.*?)\.\s*The current time is/);
          if (match && match[1]) {
            return match[1];
          }
        }
      }
    } catch (e) {}
    return '';
  });
  const [uplinkStatus, setUplinkStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [isLive, setIsLive] = useState<boolean | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [topicGroups, setTopicGroups] = useState<TopicGroup[]>(() => {
    try {
      const saved = localStorage.getItem('banterBuddy_topicGroups');
      if (saved) {
        return JSON.parse(saved).map((g: any) => ({ ...g, timestamp: new Date(g.timestamp) }));
      }
    } catch (e) {}
    return [];
  });
  const [aiHistory, setAiHistory] = useState<any[]>(() => {
    try {
      const saved = localStorage.getItem('banterBuddy_aiHistory');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {}
    return [];
  });
  const hasSavedSession = topicGroups.length > 0 || aiHistory.length > 0;
  const [confirmTerminate, setConfirmTerminate] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(() => {
    const saved = localStorage.getItem('banterBuddy_intervalMinutes');
    return saved ? Number(saved) : 3;
  });
  const [modelPreference, setModelPreference] = useState<GeminiModelPreference>(() => {
    const versionKey = 'banterBuddy_waterfall_v2';
    if (!localStorage.getItem(versionKey)) {
      localStorage.setItem(versionKey, 'true');
      localStorage.setItem('banterBuddy_modelPreference', 'pro');
      return 'pro';
    }
    const saved = localStorage.getItem('banterBuddy_modelPreference') as GeminiModelPreference;
    return saved || 'pro';
  });
  const [isPaused, setIsPaused] = useState(false);
  
  const [suggestionStyle, setSuggestionStyle] = useState<SuggestionStyle>(() => {
    return (localStorage.getItem('banterBuddy_suggestionStyle') as SuggestionStyle) || 'balanced';
  });
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('default');

  const [elapsedSeconds, setElapsedSeconds] = useState(() => Number(localStorage.getItem('banterBuddy_elapsedSeconds')) || 0);
  const [sliderValue, setSliderValue] = useState(0);
  const [secondsUntilNext, setSecondsUntilNext] = useState(intervalMinutes * 60);
  const secondsUntilNextRef = useRef(intervalMinutes * 60);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [channelName, setChannelName] = useState<string>(() => localStorage.getItem('banterBuddy_channelName') || 'Streamer');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const transcriptRef = useRef<string>("");
  const speechRecognitionRef = useRef<any>(null);
  const analyzerRef = useRef<StreamAnalyzerSession | null>(null);

  // Persistence Effects
  useEffect(() => { 
    if (streamInput.trim()) {
      localStorage.setItem('banterBuddy_streamInput', streamInput); 
    }
  }, [streamInput]);
  useEffect(() => { localStorage.setItem('banterBuddy_topicGroups', JSON.stringify(topicGroups)); }, [topicGroups]);
  useEffect(() => { localStorage.setItem('banterBuddy_aiHistory', JSON.stringify(aiHistory)); }, [aiHistory]);
  useEffect(() => { localStorage.setItem('banterBuddy_intervalMinutes', intervalMinutes.toString()); }, [intervalMinutes]);
  useEffect(() => { localStorage.setItem('banterBuddy_modelPreference', modelPreference); }, [modelPreference]);
  useEffect(() => { localStorage.setItem('banterBuddy_suggestionStyle', suggestionStyle); }, [suggestionStyle]);
  useEffect(() => { localStorage.setItem('banterBuddy_elapsedSeconds', elapsedSeconds.toString()); }, [elapsedSeconds]);
  useEffect(() => { localStorage.setItem('banterBuddy_channelName', channelName); }, [channelName]);

  const stateRef = useRef({ isAnalyzing, uplinkStatus, streamInput, intervalMinutes, modelPreference, suggestionStyle, isMicEnabled });
  useEffect(() => { stateRef.current = { isAnalyzing, uplinkStatus, streamInput, intervalMinutes, modelPreference, suggestionStyle, isMicEnabled }; }, [isAnalyzing, uplinkStatus, streamInput, intervalMinutes, modelPreference, suggestionStyle, isMicEnabled]);

  const elapsedSecondsRef = useRef(elapsedSeconds);
  useEffect(() => { elapsedSecondsRef.current = elapsedSeconds; }, [elapsedSeconds]);

  const isAtLatestRef = useRef(isAtLatest);
  useEffect(() => { isAtLatestRef.current = isAtLatest; }, [isAtLatest]);

  useEffect(() => {
    secondsUntilNextRef.current = intervalMinutes * 60;
    setSecondsUntilNext(intervalMinutes * 60);
  }, [intervalMinutes]);

  useEffect(() => {
    let active = true;
    if (isMicEnabled) {
      const constraints: MediaStreamConstraints = { 
        audio: {
          deviceId: selectedDeviceId !== 'default' ? { exact: selectedDeviceId } : undefined,
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false
        } 
      };

      navigator.mediaDevices.getUserMedia(constraints)
        .then(stream => {
          if (!active) {
            stream.getTracks().forEach(track => track.stop());
            return;
          }
          const mediaRecorder = new MediaRecorder(stream);
          mediaRecorderRef.current = mediaRecorder;
          
          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              if (audioChunksRef.current.length === 0) {
                // Preserve the initialization chunk (header) at index 0
                audioChunksRef.current.push(e.data);
              } else {
                audioChunksRef.current.push(e.data);
                // Keep header at index 0, plus the last ~60 seconds of audio
                if (audioChunksRef.current.length > 61) {
                  audioChunksRef.current.splice(1, 1);
                }
              }
            }
          };
          
          mediaRecorder.start(1000); // 1 second chunks

          // Speech Recognition Setup
          const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
          if (SpeechRecognition) {
            try {
              const recognition = new SpeechRecognition();
              recognition.continuous = true;
              recognition.interimResults = true;

              recognition.onresult = (event: any) => {
                let currentFinal = '';
                for (let i = event.resultIndex; i < event.results.length; ++i) {
                  if (event.results[i].isFinal) {
                    currentFinal += event.results[i][0].transcript + ' ';
                  }
                }
                if (currentFinal) {
                  transcriptRef.current += currentFinal;
                }
              };

              recognition.onerror = (event: any) => {
                if (event.error === 'no-speech') {
                  // Silent restart is naturally handled by onend
                  return;
                }
                console.error("Speech recognition error:", event.error);
                if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
                  // Stop trying to use SpeechRecognition if it's blocked by the browser.
                  if (speechRecognitionRef.current) {
                    speechRecognitionRef.current.onend = null; // Prevent restart
                  }
                }
              };

              recognition.onend = () => {
                if (active && isMicEnabled) {
                  try { recognition.start(); } catch (e) {}
                }
              };

              recognition.start();
              speechRecognitionRef.current = recognition;
            } catch (err) {
              console.error("Failed to initialize speech recognition:", err);
            }
          }

          // Fetch devices now that we have permission
          navigator.mediaDevices.enumerateDevices().then(devices => {
            if (active) {
              setAudioDevices(devices.filter(d => d.kind === 'audioinput'));
            }
          });
        })
        .catch(err => {
          console.error("Error accessing microphone:", err);
          setIsMicEnabled(false);
        });
    } else {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      mediaRecorderRef.current = null;
      audioChunksRef.current = [];

      if (speechRecognitionRef.current) {
        speechRecognitionRef.current.stop();
        speechRecognitionRef.current = null;
      }
    }
    
    return () => {
      active = false;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      if (speechRecognitionRef.current) {
        speechRecognitionRef.current.stop();
        speechRecognitionRef.current = null;
      }
    };
  }, [isMicEnabled, selectedDeviceId]);

  useEffect(() => {
    if (uplinkStatus !== 'connected') {
      setIsLive(null);
      return;
    }

    const checkLiveStatus = async () => {
      const live = await checkIfLiveDirectly(streamInput);
      setIsLive(live);
    };

    // Check immediately upon connection
    checkLiveStatus();

    // Then check every 15 minutes to avoid rate limits
    const intervalId = setInterval(checkLiveStatus, 15 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [uplinkStatus, streamInput]);

  useEffect(() => {
    if (uplinkStatus !== 'connected' || isPaused) return;

    const intervalId = setInterval(() => {
      setElapsedSeconds(prev => {
        const next = prev + 1;
        if (isAtLatestRef.current) {
          setSliderValue(next);
        }
        return next;
      });

      if (!stateRef.current.isAnalyzing) {
        secondsUntilNextRef.current -= 1;
        if (secondsUntilNextRef.current <= 0) {
          triggerAnalysis();
        }
        setSecondsUntilNext(secondsUntilNextRef.current);
      }
    }, 1000);

    return () => clearInterval(intervalId);
  }, [uplinkStatus, isPaused, intervalMinutes]);

  const handleConnectNew = async () => {
    if (!streamInput.trim() || uplinkStatus === 'connecting') return;
    
    setUplinkStatus('connecting');
    const isValid = streamInput.includes('youtube.com') || streamInput.includes('youtu.be') || streamInput.startsWith('@');
    
    if (isValid) {
      try {
        setTopicGroups([]);
        setElapsedSeconds(0);
        setSliderValue(0);
        setAiHistory([]);
        localStorage.removeItem('banterBuddy_topicGroups');
        localStorage.removeItem('banterBuddy_elapsedSeconds');
        localStorage.removeItem('banterBuddy_aiHistory');
        localStorage.removeItem('banterBuddy_deliveryStyle');
        setChannelDeliveryStyle('');

        const analyzer = new StreamAnalyzerSession(streamInput);
        const initResult = await analyzer.initialize(stateRef.current.modelPreference);
        const name = initResult?.channelName;
        setChannelName(name || 'Streamer');
        if (initResult?.deliveryStyle) {
          setChannelDeliveryStyle(initResult.deliveryStyle);
          localStorage.setItem('banterBuddy_deliveryStyle', initResult.deliveryStyle);
        }
        analyzerRef.current = analyzer;
        setAiHistory(analyzer.getHistory());
        localStorage.setItem('banterBuddy_lastIdentifier', streamInput);

        setUplinkStatus('connected');
        stateRef.current.uplinkStatus = 'connected';
        setIsPaused(false);
        triggerAnalysis(); // Initial analysis
      } catch (error) {
        console.error("Failed to initialize analyzer session", error);
        setUplinkStatus('error');
      }
    } else {
      setUplinkStatus('error');
    }
  };

  const handleConnectRecover = async () => {
    if (!streamInput.trim() || uplinkStatus === 'connecting') return;
    
    setUplinkStatus('connecting');
    const isValid = streamInput.includes('youtube.com') || streamInput.includes('youtu.be') || streamInput.startsWith('@');
    
    if (isValid) {
      try {
        const analyzer = new StreamAnalyzerSession(streamInput, aiHistory);
        if (channelDeliveryStyle) {
          analyzer.setDeliveryStyle(channelDeliveryStyle);
        }
        await analyzer.initialize(stateRef.current.modelPreference); // Skips because history has length
        analyzerRef.current = analyzer;
        localStorage.setItem('banterBuddy_lastIdentifier', streamInput);

        setUplinkStatus('connected');
        stateRef.current.uplinkStatus = 'connected';
        setIsPaused(false);
      } catch (error) {
        console.error("Failed to recover analyzer session", error);
        setUplinkStatus('error');
      }
    } else {
      setUplinkStatus('error');
    }
  };

  const handleDisconnect = () => {
    setUplinkStatus('disconnected');
    setIsPaused(true);
    analyzerRef.current = null;
  };

  const triggerAnalysis = async () => {
    if (stateRef.current.isAnalyzing || stateRef.current.uplinkStatus !== 'connected') return;
    if (!analyzerRef.current) return;
    
    setIsAnalyzing(true);
    stateRef.current.isAnalyzing = true;
    secondsUntilNextRef.current = stateRef.current.intervalMinutes * 60;
    setSecondsUntilNext(stateRef.current.intervalMinutes * 60);
    
    let audioBase64: string | undefined;
    let audioMimeType: string | undefined;

    if (stateRef.current.isMicEnabled && audioChunksRef.current.length > 0) {
      try {
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' });
        audioMimeType = audioBlob.type;
        
        // Convert blob to base64
        audioBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => {
            if (typeof reader.result === 'string') {
              const base64data = reader.result.split(',')[1];
              resolve(base64data);
            } else {
              reject(new Error("Failed to read audio blob"));
            }
          };
          reader.onerror = reject;
          reader.readAsDataURL(audioBlob);
        });
      } catch (err) {
        console.error("Failed to process audio for analysis", err);
      }
    }
    
    let accumulatedTranscript = transcriptRef.current;
    transcriptRef.current = ""; // Clear for the next period

    try {
      const result = await analyzerRef.current.getTopics(
        stateRef.current.suggestionStyle,
        accumulatedTranscript,
        stateRef.current.intervalMinutes,
        audioBase64,
        audioMimeType,
        stateRef.current.modelPreference
      );
      setAiHistory(analyzerRef.current.getHistory());
      if (result.topics && result.topics.length > 0) {
        setTopicGroups(prev => [
          { id: Date.now().toString(), timestamp: new Date(), elapsedAt: elapsedSecondsRef.current, topics: result.topics },
          ...prev
        ]);
      }
    } catch (error) {
      console.error("Analysis failed", error);
    } finally {
      setIsAnalyzing(false);
      stateRef.current.isAnalyzing = false;
      secondsUntilNextRef.current = stateRef.current.intervalMinutes * 60;
      setSecondsUntilNext(stateRef.current.intervalMinutes * 60);
    }
  };

  const [playingText, setPlayingText] = useState<string | null>(null);
  const [isTtsLoading, setIsTtsLoading] = useState<string | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const inFlightRequests = useRef<Set<string>>(new Set());
  const [cachedQueries, setCachedQueries] = useState<CachedTTSQuery[]>(() => getRecentTTSCache());
  const [ttsVolume, setTtsVolume] = useState<number>(() => {
    const saved = localStorage.getItem('banterBuddy_ttsVolume');
    return saved !== null ? Number(saved) : 1;
  });
  const [ttsVoice, setTtsVoice] = useState<string>(() => {
    const saved = localStorage.getItem('banterBuddy_ttsVoice');
    return saved || 'Kore';
  });
  const [ttsModel, setTtsModel] = useState<TTSModelOption>(() => {
    const saved = localStorage.getItem('banterBuddy_ttsModel') as TTSModelOption;
    return saved || 'gemini-3.8-flash-lite-tts';
  });
  const [ttsDemeanor, setTtsDemeanor] = useState<TTSDemeanor>(() => {
    return (localStorage.getItem('banterBuddy_ttsDemeanor') as TTSDemeanor) || 'matched';
  });
  const [channelDeliveryStyle, setChannelDeliveryStyle] = useState<string>(() => {
    return localStorage.getItem('banterBuddy_deliveryStyle') || '';
  });

  useEffect(() => {
    return subscribeTTSCache(setCachedQueries);
  }, []);

  useEffect(() => {
    localStorage.setItem('banterBuddy_ttsVolume', ttsVolume.toString());
    if (audioPlayerRef.current) {
      audioPlayerRef.current.volume = ttsVolume;
    }
  }, [ttsVolume]);
  
  useEffect(() => {
    localStorage.setItem('banterBuddy_ttsVoice', ttsVoice);
  }, [ttsVoice]);

  useEffect(() => {
    localStorage.setItem('banterBuddy_ttsModel', ttsModel);
  }, [ttsModel]);

  useEffect(() => {
    localStorage.setItem('banterBuddy_ttsDemeanor', ttsDemeanor);
  }, [ttsDemeanor]);

  const handlePlayTTS = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // 1. If currently playing this text: toggle stop
    if (playingText === trimmed && audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
      audioPlayerRef.current = null;
      setPlayingText(null);
      return;
    }

    // 2. Prevent duplicate execution when button is clicked twice in quick succession
    if (inFlightRequests.current.has(trimmed) || isTtsLoading === trimmed) {
      return;
    }

    // 3. Stop any other audio that is currently playing
    if (audioPlayerRef.current) {
      audioPlayerRef.current.onended = null;
      audioPlayerRef.current.onerror = null;
      audioPlayerRef.current.pause();
      audioPlayerRef.current.currentTime = 0;
      audioPlayerRef.current = null;
      setPlayingText(null);
    }

    // 4. Check the 5-item rolling cache for instant replay (saving quota & avoiding duplicate API calls)
    const voiceCacheKey = `${ttsVoice} [${ttsModel.includes('lite') ? 'Lite' : 'Flash'}]`;
    const cachedUrl = getCachedTTSAudio(trimmed, voiceCacheKey);
    if (cachedUrl) {
      const audio = new Audio(cachedUrl);
      audio.volume = ttsVolume;
      audio.playbackRate = 1.15; // Slightly faster dialogue cadence
      audioPlayerRef.current = audio;

      audio.onended = () => {
        setPlayingText(null);
        audioPlayerRef.current = null;
      };
      audio.onerror = () => {
        setPlayingText(null);
        audioPlayerRef.current = null;
      };

      try {
        await audio.play();
        setPlayingText(trimmed);
      } catch (err) {
        console.error("Failed to play cached audio", err);
        setPlayingText(null);
        audioPlayerRef.current = null;
      }
      return;
    }

    // 5. Not cached: Lock in-flight and generate new TTS audio
    inFlightRequests.current.add(trimmed);
    setIsTtsLoading(trimmed);

    try {
      const styleInstruction = getDeliveryStyleInstruction(ttsDemeanor, channelDeliveryStyle);
      const { audioUrl } = await generateTTSAudio(trimmed, ttsVoice, styleInstruction, ttsModel);

      if (audioUrl) {
        // Store in the rolling 5-item cache (automatically evicts oldest and revokes Blob URL)
        storeCachedTTSAudio(trimmed, voiceCacheKey, audioUrl);

        const audio = new Audio(audioUrl);
        audio.volume = ttsVolume;
        audio.playbackRate = 1.15; // Slightly faster dialogue cadence
        audioPlayerRef.current = audio;

        audio.onended = () => {
          setPlayingText(null);
          audioPlayerRef.current = null;
        };
        audio.onerror = () => {
          setPlayingText(null);
          audioPlayerRef.current = null;
        };

        await audio.play();
        setPlayingText(trimmed);
      }
    } catch (err) {
      console.error("Failed to play TTS", err);
    } finally {
      inFlightRequests.current.delete(trimmed);
      setIsTtsLoading(null);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const visibleGroups = topicGroups.filter(group => group.elapsedAt <= sliderValue);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-orange-500/30">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">BanterBuddy</h1>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-white/60 bg-white/5 px-3 py-1.5 rounded-full" title="TTS Voice Profile">
              <Volume2 className="w-4 h-4 text-orange-400" />
              <select 
                value={ttsVoice}
                onChange={(e) => setTtsVoice(e.target.value)}
                className="bg-transparent border-none outline-none cursor-pointer text-white max-w-[120px] truncate"
              >
                <option value="Aoede" className="bg-neutral-900">Aoede</option>
                <option value="Charon" className="bg-neutral-900">Charon</option>
                <option value="Fenrir" className="bg-neutral-900">Fenrir</option>
                <option value="Kore" className="bg-neutral-900">Kore</option>
                <option value="Puck" className="bg-neutral-900">Puck</option>
              </select>
            </div>
            
            <div className="flex items-center gap-2 text-sm text-white/60 bg-white/5 px-3 py-1.5 rounded-full" title="Dialogue Waterfall: Pro -> Flash -> Flash-lite">
              <Sparkles className="w-4 h-4 text-orange-400" />
              <select 
                value={modelPreference}
                onChange={(e) => setModelPreference(e.target.value as GeminiModelPreference)}
                className="bg-transparent border-none outline-none cursor-pointer text-white max-w-[155px] truncate"
              >
                <option value="pro" className="bg-neutral-900">Gemini 4 Pro</option>
                <option value="flash" className="bg-neutral-900">Gemini 3.8 Flash</option>
                <option value="flash-lite" className="bg-neutral-900">Gemini 3.1 Flash Lite</option>
              </select>
            </div>
            
            <div className="flex items-center gap-2 text-sm text-white/60 bg-white/5 px-3 py-1.5 rounded-full">
              <Clock className="w-4 h-4" />
              <select 
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                className="bg-transparent border-none outline-none cursor-pointer text-white"
              >
                <option value={1} className="bg-neutral-900">1 min</option>
                <option value={3} className="bg-neutral-900">3 mins</option>
                <option value={5} className="bg-neutral-900">5 mins</option>
                <option value={10} className="bg-neutral-900">10 mins</option>
              </select>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Status & Controls */}
        <div className="lg:col-span-4 space-y-6">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h2 className="text-sm font-medium text-white/50 uppercase tracking-wider mb-4">Stream Uplink</h2>
            
            <div className="space-y-4 mb-6">
              <div>
                <label className="block text-xs text-white/50 mb-2">YouTube URL or @username</label>
                <div 
                  className="relative group block"
                  onMouseLeave={() => setConfirmTerminate(false)}
                >
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <LinkIcon className="h-4 w-4 text-white/40" />
                  </div>
                  <input
                    type="text"
                    value={streamInput}
                    onChange={(e) => {
                      setStreamInput(e.target.value);
                      if (uplinkStatus === 'error') setUplinkStatus('disconnected');
                    }}
                    readOnly={(hasSavedSession && streamInput.trim().length > 0) || uplinkStatus === 'connected' || uplinkStatus === 'connecting'}
                    disabled={uplinkStatus === 'connected' || uplinkStatus === 'connecting'}
                    placeholder="e.g., @ava11350 or https://youtube.com/..."
                    className={`block w-full pl-10 pr-3 py-2.5 border border-white/10 rounded-xl bg-black/50 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-transparent transition-all ${
                      (hasSavedSession && streamInput.trim().length > 0) ? 'cursor-default opacity-80' : ''
                    } disabled:opacity-50`}
                  />
                  
                  {(hasSavedSession && streamInput.trim().length > 0) && (
                    <div className="absolute inset-0 bg-red-500/65 backdrop-blur-[1px] rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all duration-200 z-10 cursor-pointer"
                         onClick={(e) => {
                           e.preventDefault();
                           if (confirmTerminate) {
                             handleDisconnect();
                             setStreamInput('');
                             setTopicGroups([]);
                             setElapsedSeconds(0);
                             setSliderValue(0);
                             setAiHistory([]);
                             localStorage.removeItem('banterBuddy_streamInput');
                             localStorage.removeItem('banterBuddy_topicGroups');
                             localStorage.removeItem('banterBuddy_elapsedSeconds');
                             localStorage.removeItem('banterBuddy_aiHistory');
                             localStorage.removeItem('banterBuddy_lastIdentifier');
                             localStorage.removeItem('banterBuddy_deliveryStyle');
                             setChannelDeliveryStyle('');
                             setConfirmTerminate(false);
                           } else {
                             setConfirmTerminate(true);
                           }
                         }}
                    >
                      <div className="flex items-center gap-2 text-white font-medium select-none">
                        {confirmTerminate ? (
                          <span>Confirm Termination</span>
                        ) : (
                          <span>Terminate Uplink</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                {uplinkStatus === 'connected' ? (
                  <button
                    onClick={handleDisconnect}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-medium transition-all bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20"
                  >
                    Disconnect
                  </button>
                ) : (
                  <>
                    <button
                      onClick={handleConnectNew}
                      disabled={!streamInput.trim() || uplinkStatus === 'connecting'}
                      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-medium transition-all bg-white text-black hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {uplinkStatus === 'connecting' ? (
                        <><Loader2 className="w-4 h-4 animate-spin" /> Connecting...</>
                      ) : (
                        topicGroups.length > 0 ? 'Establish New Uplink' : 'Establish Uplink'
                      )}
                    </button>
                    {(topicGroups.length > 0 || aiHistory.length > 0) && uplinkStatus !== 'connecting' && (
                      <button
                        onClick={handleConnectRecover}
                        disabled={!streamInput.trim()}
                        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-medium transition-all bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 border border-orange-500/20"
                      >
                        Recover Previous Uplink
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Status Indicator */}
            <div className="pt-4 border-t border-white/10">
              <div className="flex items-center gap-3">
                <div className="relative flex h-3 w-3">
                  {uplinkStatus === 'connected' && isLive && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  )}
                  <span className={`relative inline-flex rounded-full h-3 w-3 ${
                    uplinkStatus === 'connected' ? (isLive ? 'bg-green-500' : 'bg-orange-500') :
                    uplinkStatus === 'connecting' ? 'bg-yellow-500' :
                    uplinkStatus === 'error' ? 'bg-red-500' :
                    'bg-white/20'
                  }`}></span>
                </div>
                <span className={`text-sm font-medium ${
                  uplinkStatus === 'connected' ? (isLive ? 'text-green-500' : 'text-orange-500') :
                  uplinkStatus === 'connecting' ? 'text-yellow-500' :
                  uplinkStatus === 'error' ? 'text-red-500' :
                  'text-white/50'
                }`}>
                  {uplinkStatus === 'connected' ? (isLive ? 'Uplink established (Live detected)' : 'Uplink established (Offline / Monitoring)') :
                   uplinkStatus === 'connecting' ? 'Establishing uplink...' :
                   uplinkStatus === 'error' ? 'Invalid stream identifier' :
                   'Awaiting connection'}
                </span>
              </div>

            </div>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <h2 className="text-sm font-medium text-white/50 uppercase tracking-wider mb-4">Dialogue Style</h2>
            <div className="flex flex-col gap-3">
              <label className="flex items-center gap-3 cursor-pointer group">
                <div className={`w-5 h-5 flex-shrink-0 rounded-full border flex items-center justify-center transition-colors ${suggestionStyle === 'personalized' ? 'border-orange-500 bg-orange-500/20' : 'border-white/20 group-hover:border-white/40'}`}>
                  {suggestionStyle === 'personalized' && <div className="w-2.5 h-2.5 rounded-full bg-orange-500" />}
                </div>
                <input type="radio" className="hidden" checked={suggestionStyle === 'personalized'} onChange={() => setSuggestionStyle('personalized')} />
                <div>
                  <div className="text-sm font-medium text-white/90">Personalized</div>
                  <div className="text-xs text-white/50">Draws directly from background and ongoing conversation</div>
                </div>
              </label>
              
              <label className="flex items-center gap-3 cursor-pointer group">
                <div className={`w-5 h-5 flex-shrink-0 rounded-full border flex items-center justify-center transition-colors ${suggestionStyle === 'balanced' ? 'border-orange-500 bg-orange-500/20' : 'border-white/20 group-hover:border-white/40'}`}>
                  {suggestionStyle === 'balanced' && <div className="w-2.5 h-2.5 rounded-full bg-orange-500" />}
                </div>
                <input type="radio" className="hidden" checked={suggestionStyle === 'balanced'} onChange={() => setSuggestionStyle('balanced')} />
                <div>
                  <div className="text-sm font-medium text-white/90">Balanced</div>
                  <div className="text-xs text-white/50">Hybrid of personalized and abstract responses</div>
                </div>
              </label>

              <label className="flex items-center gap-3 cursor-pointer group">
                <div className={`w-5 h-5 flex-shrink-0 rounded-full border flex items-center justify-center transition-colors ${suggestionStyle === 'abstract' ? 'border-orange-500 bg-orange-500/20' : 'border-white/20 group-hover:border-white/40'}`}>
                  {suggestionStyle === 'abstract' && <div className="w-2.5 h-2.5 rounded-full bg-orange-500" />}
                </div>
                <input type="radio" className="hidden" checked={suggestionStyle === 'abstract'} onChange={() => setSuggestionStyle('abstract')} />
                <div>
                  <div className="text-sm font-medium text-white/90">Abstract</div>
                  <div className="text-xs text-white/50">Helps change the subject and start new dialogues</div>
                </div>
              </label>
            </div>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-medium text-white/50 uppercase tracking-wider">Audio Context</h2>
              <button
                onClick={() => setIsMicEnabled(!isMicEnabled)}
                className={`p-2 rounded-lg transition-colors ${
                  isMicEnabled ? 'bg-red-500/20 text-red-500 hover:bg-red-500/30' : 'bg-white/10 text-white/70 hover:text-white hover:bg-white/20'
                }`}
                title={isMicEnabled ? "Disable Microphone" : "Enable Microphone"}
              >
                {isMicEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-xs text-white/50 leading-relaxed">
              {isMicEnabled 
                ? "Listening to stream audio to provide immediate conversational context for dialogue." 
                : "Enable microphone to allow BanterBuddy to listen to your stream and provide more relevant dialogue."}
            </p>

            {isMicEnabled && audioDevices.length > 0 && (
              <div className="mt-4 pt-4 border-t border-white/10">
                <label className="block text-xs text-white/50 mb-2">Audio Input Device</label>
                <select 
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="block w-full px-3 py-2 border border-white/10 rounded-xl bg-black/50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50"
                >
                  <option value="default">Default System Device</option>
                  {audioDevices.map(device => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label || `Microphone ${device.deviceId.slice(0, 5)}...`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="mt-4 pt-4 border-t border-white/10">
              <div className="flex justify-between items-center mb-2">
                <label className="block text-xs text-white/50">TTS Output Volume</label>
                <span className="text-xs text-white/40">{Math.round(ttsVolume * 100)}%</span>
              </div>
              <input 
                type="range" 
                min="0" 
                max="1" 
                step="0.01" 
                value={ttsVolume} 
                onChange={(e) => setTtsVolume(parseFloat(e.target.value))}
                className="w-full accent-orange-500 cursor-pointer"
              />
            </div>

            {/* TTS Model Selection (Independent from Dialogue Model) */}
            <div className="mt-4 pt-4 border-t border-white/10">
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs text-white/50">TTS Voice Model</label>
                <span className="text-[10px] text-orange-400 font-mono uppercase tracking-wider">Independent</span>
              </div>
              <select 
                value={ttsModel}
                onChange={(e) => setTtsModel(e.target.value as TTSModelOption)}
                className="block w-full px-3 py-2 border border-white/10 rounded-xl bg-black/50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50"
              >
                <option value="gemini-3.8-flash-lite-tts" className="bg-neutral-900">Gemini 3.8 Flash Lite TTS (Fast & Quota-efficient)</option>
                <option value="gemini-3.8-flash-tts" className="bg-neutral-900">Gemini 3.8 Flash TTS (High-Fidelity Dialogue)</option>
              </select>
              <p className="mt-1.5 text-[11px] text-white/40 leading-snug">
                Speech audio synthesis is dedicated and runs independently from your dialogue co-host model.
              </p>
            </div>

            {/* Demeanor & Delivery Cadence */}
            <div className="mt-4 pt-4 border-t border-white/10">
              <label className="block text-xs text-white/50 mb-2">Voice Demeanor & Cadence</label>
              <select 
                value={ttsDemeanor}
                onChange={(e) => setTtsDemeanor(e.target.value as TTSDemeanor)}
                className="block w-full px-3 py-2 border border-white/10 rounded-xl bg-black/50 text-white text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50"
              >
                <option value="matched" className="bg-neutral-900">Channel-Matched Nonchalant</option>
                <option value="nonchalant" className="bg-neutral-900">Chill & Nonchalant</option>
                <option value="deadpan" className="bg-neutral-900">Deadpan & Dry Wit</option>
                <option value="casual" className="bg-neutral-900">Casual Banter</option>
                <option value="lowkey" className="bg-neutral-900">Subdued & Low-Key</option>
              </select>
              {channelDeliveryStyle ? (
                <div className="mt-2 text-[11px] text-orange-300/90 bg-orange-500/10 border border-orange-500/20 px-2.5 py-1.5 rounded-lg leading-snug">
                  <span className="font-semibold text-orange-200">Channel Cadence:</span> "{channelDeliveryStyle}"
                </div>
              ) : (
                <p className="mt-1.5 text-[11px] text-white/40 leading-snug">
                  Nonchalant delivery removes overly bright tones to match relaxed streamer banter.
                </p>
              )}
            </div>

            {/* Rolling 5-Query TTS Cache */}
            <div className="mt-4 pt-4 border-t border-white/10">
              <div className="flex justify-between items-center mb-1.5">
                <div className="flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-orange-400" />
                  <label className="text-xs text-white/70 font-medium">Recent TTS Queries (Rolling 5)</label>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-mono text-white/40">{cachedQueries.length}/5</span>
                  {cachedQueries.length > 0 && (
                    <button 
                      onClick={() => clearTTSCache()}
                      className="text-[11px] text-white/40 hover:text-red-400 transition-colors p-0.5"
                      title="Clear cached audio to free storage"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
              <p className="text-[11px] text-white/40 mb-2.5 leading-relaxed">
                Rolling window saves the 5 most recent speech queries for instant replay, reducing storage overhead and avoiding duplicate calls.
              </p>

              {cachedQueries.length === 0 ? (
                <div className="text-xs text-white/30 italic py-2.5 text-center bg-white/[0.02] rounded-lg border border-dashed border-white/5">
                  No cached audio yet. Click any dialogue to speak & cache.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {cachedQueries.map((item) => {
                    const isItemPlaying = playingText === item.text;
                    return (
                      <div 
                        key={item.id} 
                        className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                          isItemPlaying 
                            ? 'bg-orange-500/20 border-orange-500/40 text-orange-200' 
                            : 'bg-black/40 border-white/5 text-white/80 hover:bg-white/5'
                        }`}
                      >
                        <div className="truncate flex-1">
                          <span className="text-[10px] text-orange-400 font-mono mr-1.5">[{item.voice}]</span>
                          <span className="truncate">{item.text}</span>
                        </div>
                        <button
                          onClick={() => handlePlayTTS(item.text)}
                          className="p-1 hover:text-white text-orange-400 transition-colors flex-shrink-0"
                          title={isItemPlaying ? "Pause audio" : "Replay cached query"}
                        >
                          {isItemPlaying ? (
                            <Square className="w-3.5 h-3.5 fill-current" />
                          ) : (
                            <RotateCcw className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Topics Feed */}
        <div className="lg:col-span-8">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 mb-8">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-sm font-medium text-white/50 uppercase tracking-wider">Analysis Timer</h2>
              <button
                onClick={() => setIsPaused(!isPaused)}
                disabled={uplinkStatus !== 'connected'}
                className={`p-2 rounded-lg transition-colors disabled:opacity-50 ${
                  isPaused ? 'bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30' : 'bg-white/10 text-white/70 hover:text-white hover:bg-white/20'
                }`}
                title={isPaused ? "Resume Timer" : "Pause Timer"}
              >
                {isPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              </button>
            </div>

            <div className="mb-6">
               <div className="flex justify-between text-xs text-white/50 mb-2">
                 <span>{isPaused ? 'Paused' : 'Next analysis in'}</span>
                 <span className="font-mono">{formatTime(secondsUntilNext)}</span>
               </div>
               <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                 <div
                   className={`h-full transition-all duration-1000 ease-linear ${isPaused ? 'bg-yellow-500' : 'bg-orange-500'}`}
                   style={{ width: `${((intervalMinutes * 60 - secondsUntilNext) / (intervalMinutes * 60)) * 100}%` }}
                 />
               </div>
            </div>
            
            <button
              onClick={triggerAnalysis}
              disabled={uplinkStatus !== 'connected' || isAnalyzing}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className={`w-4 h-4 ${isAnalyzing ? 'animate-spin' : ''}`} />
              {isAnalyzing ? 'Analyzing Stream...' : 'Generate Responses Now'}
            </button>
          </div>

          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-orange-500" />
              <h2 className="text-xl font-medium">Co-Host Dialogue</h2>
            </div>
            {topicGroups.length > 0 && (
              <span className="text-sm text-white/50">{visibleGroups.length} visible</span>
            )}
          </div>

          {topicGroups.length > 0 && (
            <div className="mb-8 bg-white/5 border border-white/10 rounded-2xl p-4">
              <div className="flex items-center justify-between text-xs text-white/50 mb-3">
                <span className="font-medium">Timeline</span>
                <span className="font-mono">{formatTime(sliderValue)} / {formatTime(elapsedSeconds)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={elapsedSeconds}
                value={sliderValue}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setSliderValue(val);
                  setIsAtLatest(val >= elapsedSeconds - 2);
                }}
                className="w-full accent-orange-500 h-2 bg-white/10 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          )}

          {visibleGroups.length === 0 ? (
            <div className="h-64 border border-white/10 border-dashed rounded-2xl flex flex-col items-center justify-center text-white/40">
              <Sparkles className="w-8 h-8 mb-3 opacity-50" />
              <p>{topicGroups.length > 0 ? "No dialogue at this point in time." : "No responses generated yet."}</p>
              <p className="text-sm mt-1">{topicGroups.length > 0 ? "Drag the slider to view later dialogue." : "Establish an uplink to begin the conversation."}</p>
            </div>
          ) : (
            <div className="space-y-6">
              <AnimatePresence>
                {visibleGroups.map((group) => (
                  <motion.div
                    key={group.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="relative pl-8"
                  >
                    {/* Timeline line */}
                    <div className="absolute left-[11px] top-8 bottom-[-24px] w-px bg-white/10" />
                    
                    {/* Timeline dot */}
                    <div className="absolute left-0 top-1.5 w-6 h-6 rounded-full bg-[#0a0a0a] border-2 border-orange-500 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-orange-500" />
                    </div>

                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-sm text-white/50">
                        {group.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="text-xs font-mono text-orange-400/70 bg-orange-500/10 px-2 py-0.5 rounded">
                        +{formatTime(group.elapsedAt)}
                      </span>
                    </div>

                    <div className="flex flex-col gap-4">
                      {group.topics.map((topic, i) => {
                        const text = typeof topic === 'string' ? topic : topic.text;
                        const quote = typeof topic === 'string' ? undefined : topic.quote;
                        const trimmed = text.trim();
                        const isCached = cachedQueries.some(q => q.text === trimmed && q.voice === ttsVoice);
                        const isThisPlaying = playingText === trimmed;
                        const isThisLoading = isTtsLoading === trimmed;

                        return (
                          <div key={i} className="flex flex-col gap-2 w-full">
                            {quote && (
                              <div className="flex justify-start">
                                <div className="bg-white/10 text-white/80 text-sm px-4 py-3 rounded-2xl rounded-bl-sm max-w-[85%]">
                                  <span className="text-xs text-white/50 block mb-1 font-semibold uppercase tracking-wider">{channelName}</span>
                                  "{quote}"
                                </div>
                              </div>
                            )}
                            <div className="flex justify-end">
                              <div 
                                onClick={() => handlePlayTTS(text)}
                                className={`bg-gradient-to-br from-orange-600 to-red-600 hover:from-orange-500 hover:to-red-500 text-white text-base px-5 py-3 rounded-2xl rounded-br-sm max-w-[85%] shadow-lg relative group cursor-pointer transition-all ${
                                  isThisPlaying ? 'ring-2 ring-orange-300 ring-offset-2 ring-offset-[#0a0a0a]' : ''
                                }`}
                                title={isCached ? "Instant Replay (Cached in 5-query rolling window, 0 API quota)" : "Click to read aloud"}
                              >
                                <div className="flex justify-between items-center mb-1 gap-2">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-xs text-orange-200 font-semibold uppercase tracking-wider">BB</span>
                                    {isCached && (
                                      <span className="text-[10px] bg-black/25 text-orange-200 px-1.5 py-0.5 rounded font-mono flex items-center gap-1" title="Saved in rolling cache for instant replay">
                                        <Zap className="w-2.5 h-2.5 fill-current text-yellow-300" />
                                        Cached
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-1 text-orange-200">
                                    {isThisLoading ? (
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : isThisPlaying ? (
                                      <div className="flex items-center gap-1.5">
                                        <span className="w-1.5 h-1.5 rounded-full bg-white animate-ping" />
                                        <Square className="w-4 h-4 fill-current" />
                                      </div>
                                    ) : (
                                      <Volume2 className={`w-4 h-4 transition-opacity ${isCached ? 'opacity-90' : 'opacity-0 group-hover:opacity-100'}`} />
                                    )}
                                  </div>
                                </div>
                                <p className="leading-relaxed">{text}</p>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
