/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { analyzeStreamForTopics } from './lib/gemini';
import { Sparkles, RefreshCw, Clock, Loader2, Link as LinkIcon, Activity, Pause, Play } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

type TopicGroup = {
  id: string;
  timestamp: Date;
  elapsedAt: number;
  topics: string[];
};

export default function App() {
  const [streamInput, setStreamInput] = useState('');
  const [uplinkStatus, setUplinkStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [isLive, setIsLive] = useState<boolean | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [topicGroups, setTopicGroups] = useState<TopicGroup[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(3);
  const [isPaused, setIsPaused] = useState(false);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [sliderValue, setSliderValue] = useState(0);
  const [secondsUntilNext, setSecondsUntilNext] = useState(intervalMinutes * 60);
  const secondsUntilNextRef = useRef(intervalMinutes * 60);
  const [isAtLatest, setIsAtLatest] = useState(true);

  const stateRef = useRef({ isAnalyzing, uplinkStatus, streamInput, intervalMinutes });
  useEffect(() => { stateRef.current = { isAnalyzing, uplinkStatus, streamInput, intervalMinutes }; }, [isAnalyzing, uplinkStatus, streamInput, intervalMinutes]);

  const elapsedSecondsRef = useRef(elapsedSeconds);
  useEffect(() => { elapsedSecondsRef.current = elapsedSeconds; }, [elapsedSeconds]);

  const isAtLatestRef = useRef(isAtLatest);
  useEffect(() => { isAtLatestRef.current = isAtLatest; }, [isAtLatest]);

  useEffect(() => {
    secondsUntilNextRef.current = intervalMinutes * 60;
    setSecondsUntilNext(intervalMinutes * 60);
  }, [intervalMinutes]);

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

  const handleConnect = async () => {
    if (!streamInput.trim()) return;
    
    if (uplinkStatus === 'connected') {
      setUplinkStatus('disconnected');
      setIsPaused(true);
      return;
    }

    setUplinkStatus('connecting');
    
    // Simulate connection validation delay for UX
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Basic validation: check if it looks like a URL or a username
    const isValid = streamInput.includes('youtube.com') || streamInput.includes('youtu.be') || streamInput.startsWith('@');
    
    if (isValid) {
      setUplinkStatus('connected');
      stateRef.current.uplinkStatus = 'connected';
      setIsPaused(false);
      triggerAnalysis(); // Initial analysis
    } else {
      setUplinkStatus('error');
    }
  };

  const triggerAnalysis = async () => {
    if (stateRef.current.isAnalyzing || stateRef.current.uplinkStatus !== 'connected') return;
    
    setIsAnalyzing(true);
    stateRef.current.isAnalyzing = true;
    secondsUntilNextRef.current = stateRef.current.intervalMinutes * 60;
    setSecondsUntilNext(stateRef.current.intervalMinutes * 60);
    
    try {
      const result = await analyzeStreamForTopics(stateRef.current.streamInput);
      setIsLive(result.isLive);
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

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const visibleGroups = topicGroups.filter(group => group.elapsedAt <= sliderValue);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white font-sans selection:bg-purple-500/30">
      {/* Header */}
      <header className="border-b border-white/10 bg-black/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">BanterBuddy</h1>
          </div>
          
          <div className="flex items-center gap-4">
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
                <div className="relative">
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
                    disabled={uplinkStatus === 'connected' || uplinkStatus === 'connecting'}
                    placeholder="e.g., @ava11350 or https://youtube.com/..."
                    className="block w-full pl-10 pr-3 py-2.5 border border-white/10 rounded-xl bg-black/50 text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-transparent disabled:opacity-50 transition-all"
                  />
                </div>
              </div>

              <button
                onClick={handleConnect}
                disabled={!streamInput.trim() || uplinkStatus === 'connecting'}
                className={`w-full flex items-center justify-center gap-2 py-2.5 rounded-xl font-medium transition-all ${
                  uplinkStatus === 'connected'
                    ? 'bg-red-500/10 text-red-500 hover:bg-red-500/20 border border-red-500/20'
                    : 'bg-white text-black hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed'
                }`}
              >
                {uplinkStatus === 'connecting' ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Connecting...</>
                ) : uplinkStatus === 'connected' ? (
                  'Disconnect'
                ) : (
                  'Establish Uplink'
                )}
              </button>
            </div>

            {/* Status Indicator */}
            <div className="pt-4 border-t border-white/10">
              <div className="flex items-center gap-3">
                <div className="relative flex h-3 w-3">
                  {uplinkStatus === 'connected' && isLive && (
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  )}
                  <span className={`relative inline-flex rounded-full h-3 w-3 ${
                    uplinkStatus === 'connected' ? (isLive ? 'bg-green-500' : 'bg-neutral-500') :
                    uplinkStatus === 'connecting' ? 'bg-yellow-500' :
                    uplinkStatus === 'error' ? 'bg-red-500' :
                    'bg-white/20'
                  }`}></span>
                </div>
                <span className={`text-sm font-medium ${
                  uplinkStatus === 'connected' ? (isLive ? 'text-green-500' : 'text-neutral-400') :
                  uplinkStatus === 'connecting' ? 'text-yellow-500' :
                  uplinkStatus === 'error' ? 'text-red-500' :
                  'text-white/50'
                }`}>
                  {uplinkStatus === 'connected' ? (isLive ? 'Uplink established (Live)' : 'Uplink established (Offline)') :
                   uplinkStatus === 'connecting' ? 'Establishing uplink...' :
                   uplinkStatus === 'error' ? 'Invalid stream identifier' :
                   'Awaiting connection'}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-white/5 border border-white/10 rounded-2xl p-6">
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
                   className={`h-full transition-all duration-1000 ease-linear ${isPaused ? 'bg-yellow-500' : 'bg-purple-500'}`}
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
              {isAnalyzing ? 'Analyzing Stream...' : 'Suggest Topics Now'}
            </button>
          </div>
        </div>

        {/* Right Column: Topics Feed */}
        <div className="lg:col-span-8">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-2">
              <Activity className="w-5 h-5 text-purple-500" />
              <h2 className="text-xl font-medium">Live Suggestions</h2>
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
                className="w-full accent-purple-500 h-2 bg-white/10 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          )}

          {visibleGroups.length === 0 ? (
            <div className="h-64 border border-white/10 border-dashed rounded-2xl flex flex-col items-center justify-center text-white/40">
              <Sparkles className="w-8 h-8 mb-3 opacity-50" />
              <p>{topicGroups.length > 0 ? "No topics at this point in time." : "No topics suggested yet."}</p>
              <p className="text-sm mt-1">{topicGroups.length > 0 ? "Drag the slider to view later topics." : "Establish an uplink to generate ideas."}</p>
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
                    <div className="absolute left-0 top-1.5 w-6 h-6 rounded-full bg-[#0a0a0a] border-2 border-purple-500 flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-purple-500" />
                    </div>

                    <div className="flex items-center gap-3 mb-3">
                      <span className="text-sm text-white/50">
                        {group.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="text-xs font-mono text-purple-400/70 bg-purple-500/10 px-2 py-0.5 rounded">
                        +{formatTime(group.elapsedAt)}
                      </span>
                    </div>

                    <div className="grid gap-3">
                      {group.topics.map((topic, i) => (
                        <div 
                          key={i}
                          className="bg-white/5 border border-white/10 rounded-xl p-4 hover:bg-white/10 transition-colors cursor-default"
                        >
                          <p className="text-white/90 text-lg font-medium leading-relaxed">{topic}</p>
                        </div>
                      ))}
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
