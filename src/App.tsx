/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { 
  StreamAnalyzerSession, 
  SuggestionStyle, 
  GeminiModelPreference, 
  TopicSuggestion, 
  generateTTSAudio, 
  TTSModelOption,
  ApiKeyErrorInfo,
  subscribeApiKeyError,
  checkApiKeyStatus
} from './lib/gemini';
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
  Trash2,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Sliders,
  Info
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
    const versionKey = 'banterBuddy_waterfall_v3';
    if (!localStorage.getItem(versionKey)) {
      localStorage.setItem(versionKey, 'true');
      localStorage.setItem('banterBuddy_modelPreference', 'flash');
      return 'flash';
    }
    const saved = localStorage.getItem('banterBuddy_modelPreference') as GeminiModelPreference;
    return saved || 'flash';
  });
  const [isPaused, setIsPaused] = useState(false);
  
  const [suggestionStyle, setSuggestionStyle] = useState<SuggestionStyle>(() => {
    return (localStorage.getItem('banterBuddy_suggestionStyle') as SuggestionStyle) || 'balanced';
  });
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('default');
  const [isAudioSettingsOpen, setIsAudioSettingsOpen] = useState(false);

  const [elapsedSeconds, setElapsedSeconds] = useState(() => Number(localStorage.getItem('banterBuddy_elapsedSeconds')) || 0);
  const [sliderValue, setSliderValue] = useState(0);
  const [secondsUntilNext, setSecondsUntilNext] = useState(intervalMinutes * 60);
  const secondsUntilNextRef = useRef(intervalMinutes * 60);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [channelName, setChannelName] = useState<string>(() => localStorage.getItem('banterBuddy_channelName') || 'Streamer');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const previousCycleBlobRef = useRef<Blob | null>(null);
  const transcriptRef = useRef<string>("");
  const speechRecognitionRef = useRef<any>(null);
  const analyzerRef = useRef<StreamAnalyzerSession | null>(null);
  const lastHeartbeatRef = useRef<number>(Date.now());

  // API Key Error State & Transparency Modal
  const [apiKeyError, setApiKeyError] = useState<ApiKeyErrorInfo | null>(null);
  const [isApiKeyDismissed, setIsApiKeyDismissed] = useState(false);
  const [isRecheckingKey, setIsRecheckingKey] = useState(false);
  const [recheckSuccess, setRecheckSuccess] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeApiKeyError((err) => {
      setApiKeyError(err);
      if (err) {
        setIsApiKeyDismissed(false);
      }
    });

    // Check API key configuration on initial mount
    checkApiKeyStatus();

    return () => unsubscribe();
  }, []);

  const handleRetryApiKey = async () => {
    setIsRecheckingKey(true);
    setRecheckSuccess(false);
    const err = await checkApiKeyStatus(true);
    setIsRecheckingKey(false);
    if (!err) {
      setRecheckSuccess(true);
      setTimeout(() => {
        setIsApiKeyDismissed(true);
        setRecheckSuccess(false);
      }, 1400);
    }
  };

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

  const [speechState, setSpeechState] = useState<'idle' | 'listening' | 'reconnecting' | 'restricted' | 'safari-unsupported' | 'unsupported'>('idle');
  const [speechCooldown, setSpeechCooldown] = useState<number>(0);
  const [recentSpeechSnippet, setRecentSpeechSnippet] = useState<string>('');

  const speechStateRef = useRef<'idle' | 'listening' | 'reconnecting' | 'restricted' | 'safari-unsupported' | 'unsupported'>('idle');
  const isMicEnabledRef = useRef<boolean>(false);
  const speechCooldownTimerRef = useRef<any>(null);
  const speechRestartTimeoutRef = useRef<any>(null);

  useEffect(() => {
    speechStateRef.current = speechState;
  }, [speechState]);

  useEffect(() => {
    isMicEnabledRef.current = isMicEnabled;
  }, [isMicEnabled]);

  const stopSpeechRecognition = useCallback(() => {
    if (speechCooldownTimerRef.current) {
      clearInterval(speechCooldownTimerRef.current);
      speechCooldownTimerRef.current = null;
    }
    if (speechRestartTimeoutRef.current) {
      clearTimeout(speechRestartTimeoutRef.current);
      speechRestartTimeoutRef.current = null;
    }
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.onresult = null;
        speechRecognitionRef.current.onerror = null;
        speechRecognitionRef.current.onend = null;
        speechRecognitionRef.current.abort();
      } catch (_) {}
      speechRecognitionRef.current = null;
    }
    setSpeechState('idle');
    speechStateRef.current = 'idle';
    setSpeechCooldown(0);
  }, []);

  const initSpeechRecognition = useCallback((force = false) => {
    if (speechCooldownTimerRef.current) {
      clearInterval(speechCooldownTimerRef.current);
      speechCooldownTimerRef.current = null;
    }
    if (speechRestartTimeoutRef.current) {
      clearTimeout(speechRestartTimeoutRef.current);
      speechRestartTimeoutRef.current = null;
    }
    setSpeechCooldown(0);

    if (!isMicEnabledRef.current && !force) {
      setSpeechState('idle');
      speechStateRef.current = 'idle';
      return;
    }

    const isSafari = typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
      console.info("[Speech Transcriber] Safari detected. Safari WebKit does not support continuous speech streaming. Direct 30s audio recording remains active.");
      setSpeechState('safari-unsupported');
      speechStateRef.current = 'safari-unsupported';
      return;
    }

    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      setSpeechState('unsupported');
      speechStateRef.current = 'unsupported';
      return;
    }

    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.onresult = null;
        speechRecognitionRef.current.onerror = null;
        speechRecognitionRef.current.onend = null;
        speechRecognitionRef.current.abort();
      } catch (_) {}
      speechRecognitionRef.current = null;
    }

    let consecutiveErrors = 0;

    try {
      const recognition = new SpeechRec();
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event: any) => {
        consecutiveErrors = 0;
        let currentFinal = '';
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            currentFinal += event.results[i][0].transcript + ' ';
          }
        }
        if (currentFinal) {
          transcriptRef.current += currentFinal;
          const trimmed = currentFinal.trim();
          setRecentSpeechSnippet(prev => {
            const combined = prev ? `${prev} ${trimmed}` : trimmed;
            return combined.length > 80 ? '...' + combined.slice(-75) : combined;
          });
        }
        if (speechStateRef.current !== 'listening') {
          setSpeechState('listening');
          speechStateRef.current = 'listening';
        }
      };

      recognition.onerror = (event: any) => {
        if (event.error === 'no-speech') return;
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          if (isSafari) {
            console.info("[Speech Transcriber] Safari does not support continuous Web Speech API. Direct 30s stream audio capture continues.");
            setSpeechState('safari-unsupported');
            speechStateRef.current = 'safari-unsupported';
          } else {
            console.info("[Speech Transcriber] Web Speech API restricted in current window/iframe. Direct 30s stream audio capture remains active.");
            setSpeechState('restricted');
            speechStateRef.current = 'restricted';
          }
          recognition.onend = null;
          try { recognition.abort(); } catch (_) {}
          return;
        }

        consecutiveErrors++;
        console.warn(`[Speech Recognition] Drop notice (drop count: ${consecutiveErrors}):`, event.error);

        // When drops occur repeatedly (e.g. Chrome's Web Speech socket died after long stream)
        if (consecutiveErrors >= 3) {
          recognition.onend = null;
          try { recognition.abort(); } catch (_) {}
          speechRecognitionRef.current = null;

          setSpeechState('reconnecting');
          speechStateRef.current = 'reconnecting';
          setSpeechCooldown(15);

          let remaining = 15;
          speechCooldownTimerRef.current = setInterval(() => {
            remaining -= 1;
            setSpeechCooldown(remaining);
            if (remaining <= 0) {
              if (speechCooldownTimerRef.current) {
                clearInterval(speechCooldownTimerRef.current);
                speechCooldownTimerRef.current = null;
              }
              if (isMicEnabledRef.current) {
                console.info("[Speech Recognition] Cooldown complete, attempting fresh connection...");
                initSpeechRecognition(true);
              } else {
                setSpeechState('idle');
                speechStateRef.current = 'idle';
              }
            }
          }, 1000);
        }
      };

      recognition.onend = () => {
        if (speechStateRef.current === 'reconnecting' || speechStateRef.current === 'restricted' || speechStateRef.current === 'safari-unsupported' || !isMicEnabledRef.current) {
          return;
        }

        const delay = consecutiveErrors > 0 ? 2500 : 800;
        if (speechRestartTimeoutRef.current) clearTimeout(speechRestartTimeoutRef.current);
        speechRestartTimeoutRef.current = setTimeout(() => {
          if (isMicEnabledRef.current && speechStateRef.current !== 'reconnecting' && speechStateRef.current !== 'restricted') {
            try {
              recognition.start();
              setSpeechState('listening');
              speechStateRef.current = 'listening';
            } catch (e) {
              // If start throws because socket invalidated, recreate fresh instance
              initSpeechRecognition(true);
            }
          }
        }, delay);
      };

      recognition.start();
      speechRecognitionRef.current = recognition;
      setSpeechState('listening');
      speechStateRef.current = 'listening';
    } catch (err) {
      console.warn("[Speech Recognition] Failed to initialize:", err);
      setSpeechState('reconnecting');
      speechStateRef.current = 'reconnecting';
      setSpeechCooldown(10);
      let remaining = 10;
      speechCooldownTimerRef.current = setInterval(() => {
        remaining -= 1;
        setSpeechCooldown(remaining);
        if (remaining <= 0) {
          if (speechCooldownTimerRef.current) {
            clearInterval(speechCooldownTimerRef.current);
            speechCooldownTimerRef.current = null;
          }
          if (isMicEnabledRef.current) {
            initSpeechRecognition(true);
          }
        }
      }, 1000);
    }
  }, []);

  const handleManualRestartSpeech = () => {
    initSpeechRecognition(true);
  };

  useEffect(() => {
    let active = true;
    let cycleInterval: any = null;
    let settleTimeout: any = null;
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
            if (e.data && e.data.size > 0) {
              audioChunksRef.current.push(e.data);
            }
            // Media-thread heartbeat: fires reliably every 25s even when tab is backgrounded
            const now = Date.now();
            if (now - lastHeartbeatRef.current > 25000) {
              lastHeartbeatRef.current = now;
              fetch('/api/health').catch(() => {});
            }
          };

          mediaRecorder.onstop = () => {
            if (audioChunksRef.current.length >= 5) {
              try {
                previousCycleBlobRef.current = new Blob(audioChunksRef.current, { 
                  type: mediaRecorder.mimeType || 'audio/webm' 
                });
              } catch (e) {}
            }
            audioChunksRef.current = [];
            if (active && isMicEnabled && mediaRecorder.state === 'inactive') {
              try {
                mediaRecorder.start(1000);
              } catch (e) {}
            }
          };
          
          mediaRecorder.start(1000); // 1 second chunks

          // Clean rotation every 30 seconds as requested by streamer
          cycleInterval = setInterval(() => {
            if (!active) return;
            if (mediaRecorder.state === 'recording') {
              try {
                mediaRecorder.stop();
              } catch (e) {}
            }
          }, 30000);

          // Allow audio hardware lock 350ms to settle after permission grant before starting speech recognition
          settleTimeout = setTimeout(() => {
            if (active && isMicEnabledRef.current) {
              initSpeechRecognition();
            }
          }, 350);

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
          stopSpeechRecognition();
        });
    } else {
      if (settleTimeout) clearTimeout(settleTimeout);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      mediaRecorderRef.current = null;
      audioChunksRef.current = [];
      previousCycleBlobRef.current = null;
      stopSpeechRecognition();
    }
    
    return () => {
      active = false;
      if (settleTimeout) clearTimeout(settleTimeout);
      if (cycleInterval) clearInterval(cycleInterval);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      stopSpeechRecognition();
    };
  }, [isMicEnabled, selectedDeviceId, initSpeechRecognition, stopSpeechRecognition]);

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

  // Server keep-alive heartbeat: prevents Cloud Run container scale-to-zero or idle eviction during live streams
  useEffect(() => {
    if (uplinkStatus !== 'connected') return;

    const pingServer = () => {
      fetch('/api/health').catch(() => {});
    };

    // Ping every 25 seconds to keep the Cloud Run container warm and active throughout the 10-minute intervals
    const keepAliveId = setInterval(pingServer, 25000);
    return () => clearInterval(keepAliveId);
  }, [uplinkStatus]);

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
        // Stagger first dialogue generation slightly to avoid concurrent burst quota spikes on Free Tier
        setTimeout(() => {
          if (stateRef.current.uplinkStatus === 'connected' && !stateRef.current.isAnalyzing) {
            triggerAnalysis();
          }
        }, 1200);
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

    // Safety watchdog: ensure isAnalyzing can NEVER stay stuck as true for more than 30s
    const watchdogId = setTimeout(() => {
      if (stateRef.current.isAnalyzing) {
        console.warn("[Watchdog] Analysis exceeded safety threshold of 30s, releasing analyze lock");
        setIsAnalyzing(false);
        stateRef.current.isAnalyzing = false;
        secondsUntilNextRef.current = stateRef.current.intervalMinutes * 60;
        setSecondsUntilNext(stateRef.current.intervalMinutes * 60);
      }
    }, 30000);
    
    let audioBase64: string | undefined;
    let audioMimeType: string | undefined;

    if (stateRef.current.isMicEnabled) {
      try {
        let audioBlob: Blob | null = null;
        if (audioChunksRef.current.length >= 10) {
          audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' });
        } else if (previousCycleBlobRef.current) {
          audioBlob = previousCycleBlobRef.current;
        } else if (audioChunksRef.current.length > 0) {
          audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorderRef.current?.mimeType || 'audio/webm' });
        }

        if (audioBlob && audioBlob.size > 0) {
          audioMimeType = audioBlob.type || 'audio/webm';
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
        }
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
        const newGroup = { 
          id: Date.now().toString(), 
          timestamp: new Date(), 
          elapsedAt: elapsedSecondsRef.current, 
          topics: result.topics 
        };
        setTopicGroups(prev => [newGroup, ...prev]);
        
        // Auto-advance timeline slider if streamer is watching live so fresh cards are immediately visible
        if (isAtLatestRef.current) {
          setSliderValue(elapsedSecondsRef.current);
        }
      }
    } catch (error) {
      console.error("Analysis failed", error);
    } finally {
      clearTimeout(watchdogId);
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
    const voiceVersionKey = 'banterBuddy_voice_default_v2';
    if (!localStorage.getItem(voiceVersionKey)) {
      localStorage.setItem(voiceVersionKey, 'true');
      localStorage.setItem('banterBuddy_ttsVoice', 'Aoede');
      return 'Aoede';
    }
    const saved = localStorage.getItem('banterBuddy_ttsVoice');
    return saved || 'Aoede';
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

  const handlePlayTTS = async (text: string, specificVoiceKey?: string) => {
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
    const voiceCacheKey = specificVoiceKey || `${ttsVoice} [${ttsModel.includes('lite') ? 'Lite' : 'Flash'}]`;
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
      {/* API Key Error Dialogue Box */}
      <AnimatePresence>
        {apiKeyError && !isApiKeyDismissed && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 12 }}
              className="w-full max-w-md bg-neutral-900 border border-red-500/30 rounded-2xl p-6 shadow-2xl shadow-red-500/10 relative overflow-hidden"
            >
              <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-red-500 via-orange-500 to-red-500" />
              
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 flex-shrink-0">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-base font-semibold text-white">
                      {apiKeyError.type === 'missing' ? 'Gemini API Key Required' : 'Gemini API Key Error'}
                    </h3>
                    <p className="text-xs text-red-400/90 font-medium">Authentication Notice</p>
                  </div>
                </div>
                <button 
                  onClick={() => setIsApiKeyDismissed(true)}
                  className="p-1.5 text-white/40 hover:text-white rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                  title="Dismiss dialogue"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-white/70 leading-relaxed mb-4">
                {apiKeyError.type === 'missing'
                  ? "BanterBuddy requires a Google Gemini API key to personalize dialogue, perform live stream analysis, and synthesize co-host speech. No active key was detected in the server environment."
                  : "The configured Gemini API key failed or was rejected by Google. Co-host capabilities cannot generate responses until a valid key is provided."}
              </p>

              {apiKeyError.message && (
                <div className="bg-black/60 border border-white/10 rounded-xl p-3 mb-4 text-xs font-mono text-white/60 break-words">
                  <span className="text-red-400 font-semibold mr-1.5">Details:</span>
                  {apiKeyError.message}
                </div>
              )}

              <div className="bg-white/[0.03] border border-white/5 rounded-xl p-3 mb-5 space-y-1.5 text-[11px] text-white/50">
                <div className="font-semibold text-white/80 text-xs mb-1">How to configure:</div>
                <p><span className="text-white/70 font-medium">Self-hosted / Local:</span> Add <code className="text-orange-300 bg-white/5 px-1 py-0.5 rounded font-mono">GEMINI_API_KEY=your_key</code> to your <code className="text-white/70 font-mono">.env</code> file.</p>
                <p><span className="text-white/70 font-medium">AI Studio:</span> Open <span className="text-white/70 font-medium">Settings &gt; Secrets</span> and ensure <code className="text-orange-300 font-mono">GEMINI_API_KEY</code> is attached.</p>
                <p><span className="text-white/70 font-medium">Get a key:</span> Free & paid keys available at <span className="text-orange-400">aistudio.google.com</span>.</p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={handleRetryApiKey}
                  disabled={isRecheckingKey || recheckSuccess}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl font-medium text-xs bg-orange-500 hover:bg-orange-600 text-white transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {isRecheckingKey ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Verifying Key...</>
                  ) : recheckSuccess ? (
                    <><CheckCircle2 className="w-3.5 h-3.5 text-green-300" /> Key Verified!</>
                  ) : (
                    <><RefreshCw className="w-3.5 h-3.5" /> Re-check API Key</>
                  )}
                </button>
                <button
                  onClick={() => setIsApiKeyDismissed(true)}
                  className="px-4 py-2.5 rounded-xl text-xs font-medium text-white/60 hover:text-white bg-white/5 hover:bg-white/10 transition-colors cursor-pointer"
                >
                  Dismiss
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

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
            {apiKeyError && (
              <button 
                onClick={() => setIsApiKeyDismissed(false)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/15 border border-red-500/30 text-red-400 rounded-full text-xs hover:bg-red-500/25 transition-all cursor-pointer animate-pulse"
                title="Gemini API Key issue detected. Click to view details."
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span className="font-medium">API Key Issue</span>
              </button>
            )}

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
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-white/50 uppercase tracking-wider">Audio Context</h2>
                {isMicEnabled && (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Mic Stream Live
                  </span>
                )}
              </div>
              <button
                onClick={() => setIsMicEnabled(!isMicEnabled)}
                className={`p-2 rounded-lg transition-colors cursor-pointer ${
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

            {isMicEnabled && (
              <div className="mt-4 pt-4 border-t border-white/10">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-white/50">Speech Transcriber</span>
                    {speechState === 'listening' && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        Listening
                      </span>
                    )}
                    {speechState === 'reconnecting' && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                        Cooldown {speechCooldown}s
                      </span>
                    )}
                    {speechState === 'safari-unsupported' && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-300 border border-amber-500/20" title="Safari WebKit does not support the continuous Web Speech API. Direct 30s stream audio capture is actively recording and sent to Gemini.">
                        <Info className="w-3 h-3 text-amber-400" />
                        Safari: Direct Audio Stream Active
                      </span>
                    )}
                    {speechState === 'restricted' && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/10 text-blue-300 border border-blue-500/20" title="Direct 30s stream audio capture is recording and sent to Gemini. Browser Web Speech is restricted by this window's sandbox.">
                        <Info className="w-3 h-3 text-blue-400" />
                        Direct Audio Active (Transcriber Paused)
                      </span>
                    )}
                    {speechState === 'unsupported' && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-zinc-500/10 text-zinc-400 border border-zinc-500/20">
                        Waveform only
                      </span>
                    )}
                    {speechState === 'idle' && (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-white/5 text-white/50 border border-white/10">
                        Idle
                      </span>
                    )}
                  </div>
                  {speechState === 'safari-unsupported' ? (
                    <span className="text-[10px] text-white/40 font-mono bg-white/[0.04] px-2 py-0.5 rounded border border-white/5">
                      Direct Audio Only
                    </span>
                  ) : (
                    <button
                      onClick={handleManualRestartSpeech}
                      className="flex items-center gap-1 text-[11px] text-white/60 hover:text-white px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 transition-colors border border-white/5 cursor-pointer"
                      title="Attempt fresh speech recognition session"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>{speechState === 'restricted' ? 'Retry Transcriber' : 'Restart Speech'}</span>
                    </button>
                  )}
                </div>

                {recentSpeechSnippet ? (
                  <div className="px-2.5 py-1.5 rounded-lg bg-black/30 border border-white/5 text-[11px] text-white/70 italic truncate">
                    "{recentSpeechSnippet}"
                  </div>
                ) : (
                  <p className="text-[11px] text-white/40 leading-snug">
                    {speechState === 'safari-unsupported'
                      ? "Safari does not support continuous speech-to-text. Your microphone is actively recording 30-second audio streams directly for Gemini dialogue!"
                      : speechState === 'restricted'
                      ? "Direct 30s stream audio capture is active and powering Gemini. (Browser live speech transcription is restricted by the embedding window's sandbox)."
                      : speechState === 'reconnecting'
                      ? `Speech socket resting. Auto-reconnecting in ${speechCooldown}s or click Restart Speech.`
                      : "Live speech-to-text supplements 30s audio recordings for instant dialogue context."}
                  </p>
                )}
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

            {/* Collapsible Audio & Voice Settings Section */}
            <div className="mt-4 pt-4 border-t border-white/10">
              <button
                type="button"
                onClick={() => setIsAudioSettingsOpen(!isAudioSettingsOpen)}
                className="w-full flex items-center justify-between text-left py-1 text-xs font-medium text-white/70 hover:text-white transition-colors cursor-pointer group"
              >
                <div className="flex items-center gap-2">
                  <Sliders className="w-3.5 h-3.5 text-orange-400" />
                  <span>Audio & Voice Settings</span>
                  <span className="text-[10px] text-white/40 font-normal">
                    (Device, Voice Model, Demeanor)
                  </span>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-white/40 group-hover:text-white/70 transition-colors">
                  <span>{isAudioSettingsOpen ? 'Hide' : 'Configure'}</span>
                  {isAudioSettingsOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </div>
              </button>

              <AnimatePresence>
                {isAudioSettingsOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden space-y-4 pt-3"
                  >
                    {/* Audio Input Device */}
                    {isMicEnabled && audioDevices.length > 0 && (
                      <div>
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

                    {/* TTS Model Selection */}
                    <div>
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
                    <div>
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
                  </motion.div>
                )}
              </AnimatePresence>
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
                          onClick={() => handlePlayTTS(item.text, item.voice)}
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
              onClick={() => {
                setIsAtLatest(true);
                isAtLatestRef.current = true;
                setSliderValue(elapsedSecondsRef.current);
                triggerAnalysis();
              }}
              disabled={uplinkStatus !== 'connected' || isAnalyzing}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
                <div className="flex items-center gap-2">
                  <span className="font-medium">Timeline</span>
                  {!isAtLatest && (
                    <button
                      onClick={() => {
                        setIsAtLatest(true);
                        isAtLatestRef.current = true;
                        setSliderValue(elapsedSeconds);
                      }}
                      className="px-2 py-0.5 rounded bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 text-[11px] font-medium transition-colors flex items-center gap-1 cursor-pointer"
                      title="Snap timeline to live stream"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
                      Jump to Live
                    </button>
                  )}
                </div>
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
                        const currentVoiceCacheKey = `${ttsVoice} [${ttsModel.includes('lite') ? 'Lite' : 'Flash'}]`;
                        const isCached = cachedQueries.some(q => 
                          q.text === trimmed && (
                            q.voice === currentVoiceCacheKey || 
                            q.voice.split(' ')[0] === ttsVoice ||
                            q.voice === ttsVoice
                          )
                        );
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
                                      <span className="text-[10px] bg-black/35 text-amber-200 border border-amber-400/35 px-1.5 py-0.5 rounded font-mono flex items-center gap-1 shadow-sm select-none" title="Saved in rolling cache for instant replay (0 quota)">
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
                                      <Volume2 className={`w-4 h-4 transition-opacity ${isCached ? 'opacity-100 text-amber-200' : 'opacity-0 group-hover:opacity-100'}`} />
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
