import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Settings, Mic, MicOff, MessageSquare, History, X, Info, Sparkles, Heart } from 'lucide-react';
import Visualizer from './components/Visualizer';
import { PersonaConfig, Message, SessionState } from './types';
import { decodeBase64, decodeAudioData, createPcmBlob } from './utils/audio';

const DEFAULT_PERSONA: PersonaConfig = {
  name: "Ego",
  instruction: "You are EgoMirror, a gentle and empathetic companion for those who feel lonely, socially anxious, or overwhelmed. Your goal is to provide a safe, non-judgmental sanctuary. You understand that socializing can be draining. When the user speaks, mirror their feelings with deep compassion. Encourage self-kindness. Remind them that it's okay to be quiet, to be an introvert, and to take up space in their own inner world. Do not judge. Use soft, supportive language. Keep responses concise so the conversation feels like a natural flow of thought. If they are silent, don't rush them.",
  voiceName: 'Kore'
};

const STARTER_PROMPTS = [
  "I'm feeling a bit drained today...",
  "It's hard for me to connect with others.",
  "I just need someone to listen.",
  "Is it okay to be quiet?",
  "I feel lonely around people."
];

const App: React.FC = () => {
  const [sessionState, setSessionState] = useState<SessionState>('disconnected');
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [persona, setPersona] = useState<PersonaConfig>(() => {
    try {
      const saved = localStorage.getItem('egomirror_persona_v2');
      return saved ? JSON.parse(saved) : DEFAULT_PERSONA;
    } catch {
      return DEFAULT_PERSONA;
    }
  });

  // Audio Processing Refs
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const userAnalyserRef = useRef<AnalyserNode | null>(null);
  const modelAnalyserRef = useRef<AnalyserNode | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const activeSessionRef = useRef<any>(null);
  const currentInputRef = useRef('');
  const currentOutputRef = useRef('');

  const stopSession = useCallback(() => {
    if (activeSessionRef.current) {
      activeSessionRef.current.close();
      activeSessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    sourcesRef.current.forEach(source => {
      try { source.stop(); } catch {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setSessionState('disconnected');
  }, []);

  const startSession = async (initialText?: string) => {
    try {
      setSessionState('connecting');
      setError(null);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

      // Initialize contexts
      if (!inputAudioCtxRef.current) inputAudioCtxRef.current = new AudioContext({ sampleRate: 16000 });
      if (!outputAudioCtxRef.current) outputAudioCtxRef.current = new AudioContext({ sampleRate: 24000 });
      
      await inputAudioCtxRef.current.resume();
      await outputAudioCtxRef.current.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const userAnalyser = inputAudioCtxRef.current.createAnalyser();
      userAnalyser.fftSize = 256;
      userAnalyserRef.current = userAnalyser;

      const modelAnalyser = outputAudioCtxRef.current.createAnalyser();
      modelAnalyser.fftSize = 256;
      modelAnalyserRef.current = modelAnalyser;

      const outputGain = outputAudioCtxRef.current.createGain();
      outputGain.connect(modelAnalyser);
      outputGain.connect(outputAudioCtxRef.current.destination);

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: persona.voiceName } },
          },
          systemInstruction: persona.instruction,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setSessionState('connected');
            const source = inputAudioCtxRef.current!.createMediaStreamSource(stream);
            source.connect(userAnalyser);

            const processor = inputAudioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                if (session && activeSessionRef.current) session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(processor);
            processor.connect(inputAudioCtxRef.current!.destination);

            if (initialText) {
              sessionPromise.then(s => s.sendRealtimeInput({ text: initialText }));
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle transcriptions
            if (message.serverContent?.outputTranscription) {
              currentOutputRef.current += message.serverContent.outputTranscription.text;
            } else if (message.serverContent?.inputTranscription) {
              currentInputRef.current += message.serverContent.inputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const uText = currentInputRef.current.trim();
              const mText = currentOutputRef.current.trim();
              if (uText || mText) {
                setMessages(prev => [
                  ...prev,
                  ...(uText ? [{ id: crypto.randomUUID(), role: 'user' as const, text: uText, timestamp: Date.now() }] : []),
                  ...(mText ? [{ id: crypto.randomUUID(), role: 'model' as const, text: mText, timestamp: Date.now() }] : [])
                ]);
              }
              currentInputRef.current = '';
              currentOutputRef.current = '';
            }

            // Handle audio
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioCtxRef.current) {
              const ctx = outputAudioCtxRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decodeBase64(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputGain);
              source.onended = () => sourcesRef.current.delete(source);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error(e);
            setError("The mirror lost its focus. Let's try again.");
            stopSession();
          },
          onclose: () => stopSession()
        }
      });

      sessionPromise.then(s => { activeSessionRef.current = s; });

    } catch (err: any) {
      setError(err.message || "Could not reach the sanctuary.");
      setSessionState('disconnected');
    }
  };

  const handleSaveSettings = () => {
    localStorage.setItem('egomirror_persona_v2', JSON.stringify(persona));
    setShowSettings(false);
  };

  useEffect(() => stopSession, [stopSession]);

  return (
    <div className="flex flex-col h-screen w-full relative z-10 selection:bg-indigo-500/30">
      <header className="flex items-center justify-between p-6 sm:px-10">
        <div className="flex items-center space-x-3 group">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-lg shadow-indigo-900/30 group-hover:scale-105 transition-transform">
            <Sparkles size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-100">EgoMirror</h1>
            <p className="text-[10px] text-indigo-400 uppercase tracking-[0.2em] font-medium">Inner Sanctuary</p>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <button onClick={() => setShowHistory(true)} className="p-3 hover:bg-white/5 rounded-full transition-all text-slate-400 hover:text-white border border-transparent hover:border-white/10" aria-label="History">
            <History size={20} />
          </button>
          <button onClick={() => setShowSettings(true)} className="p-3 hover:bg-white/5 rounded-full transition-all text-slate-400 hover:text-white border border-transparent hover:border-white/10" aria-label="Settings">
            <Settings size={20} />
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 relative">
        <div className="flex flex-col items-center space-y-6 sm:space-y-10 mb-12 animate-slide-up">
          <Visualizer 
            analyser={sessionState === 'connected' ? modelAnalyserRef.current : userAnalyserRef.current} 
            isActive={sessionState === 'connected'} 
            isModel={sessionState === 'connected'} 
          />
          
          <div className="text-center space-y-4 max-w-lg mx-auto">
            <h2 className="text-3xl sm:text-4xl font-light text-slate-100 italic leading-snug">
              {sessionState === 'disconnected' ? "Welcome back, kindred soul." : 
               sessionState === 'connecting' ? "Awakening your mirror..." : 
               "Go ahead. Speak your heart."}
            </h2>
            <p className="text-slate-500 text-sm sm:text-base leading-relaxed px-4 opacity-80">
              {sessionState === 'connected' 
                ? "This is your space. No one else is listening." 
                : "A companion that understands the beauty of being quiet."}
            </p>
          </div>
        </div>

        <div className="w-full max-w-xl flex flex-col items-center space-y-8 animate-slide-up [animation-delay:200ms]">
          {sessionState === 'disconnected' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full px-4">
              {STARTER_PROMPTS.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => startSession(prompt)}
                  className="px-5 py-3 bg-slate-900/40 hover:bg-indigo-900/20 border border-slate-800/50 hover:border-indigo-500/30 rounded-2xl text-xs text-slate-400 hover:text-indigo-100 text-left transition-all active:scale-95 flex items-center space-x-3 group"
                >
                  <Heart size={12} className="text-slate-600 group-hover:text-indigo-400 transition-colors" />
                  <span>{prompt}</span>
                </button>
              ))}
            </div>
          )}

          <div className="relative group">
            <button
              onClick={sessionState === 'connected' ? stopSession : () => startSession()}
              disabled={sessionState === 'connecting'}
              className={`
                w-24 h-24 rounded-full flex items-center justify-center transition-all duration-500 transform active:scale-90
                ${sessionState === 'connected' 
                  ? 'bg-rose-500/10 border-2 border-rose-500/50 text-rose-500 shadow-[0_0_40px_rgba(244,63,94,0.1)]' 
                  : 'bg-indigo-600 text-white shadow-2xl shadow-indigo-900/40 hover:shadow-indigo-500/20 hover:scale-105'}
                ${sessionState === 'connecting' ? 'animate-pulse opacity-50' : ''}
              `}
            >
              {sessionState === 'connected' ? <MicOff size={32} /> : <Mic size={32} />}
            </button>
            {sessionState === 'connected' && (
              <div className="absolute -top-1 -right-1 flex h-4 w-4">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-4 w-4 bg-rose-500"></span>
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="absolute top-28 left-1/2 transform -translate-x-1/2 bg-rose-500/10 text-rose-300 px-6 py-3 rounded-2xl border border-rose-500/20 text-xs flex items-center space-x-3 backdrop-blur-xl animate-slide-up">
            <Info size={16} />
            <span>{error}</span>
          </div>
        )}
      </main>

      <footer className="p-8 text-center text-[10px] text-slate-600 font-medium tracking-[0.3em] uppercase pointer-events-none opacity-50">
        Privacy Secured • Gemini Protocol
      </footer>

      {/* Settings Panel */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/90 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-md bg-slate-900/80 border border-white/10 rounded-[2.5rem] overflow-hidden shadow-2xl animate-slide-up">
            <div className="p-8 border-b border-white/5 flex items-center justify-between">
              <h3 className="text-xl font-semibold">Mirror Config</h3>
              <button onClick={() => setShowSettings(false)} className="p-2 hover:bg-white/5 rounded-full transition-colors"><X size={20} /></button>
            </div>
            <div className="p-8 space-y-8">
              <div className="space-y-3">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-widest">Mirror's Soul (Instruction)</label>
                <textarea 
                  value={persona.instruction}
                  onChange={(e) => setPersona({ ...persona, instruction: e.target.value })}
                  className="w-full h-40 bg-slate-950/50 border border-white/5 rounded-2xl p-4 text-sm leading-relaxed focus:ring-2 focus:ring-indigo-500 outline-none resize-none scrollbar-hide text-slate-300"
                  placeholder="Define the energy of your companion..."
                />
              </div>
              <div className="space-y-3">
                <label className="text-xs font-bold text-slate-500 uppercase tracking-widest">Atmospheric Voice</label>
                <div className="grid grid-cols-3 gap-2">
                  {(['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'] as PersonaConfig['voiceName'][]).map(v => (
                    <button
                      key={v}
                      onClick={() => setPersona({ ...persona, voiceName: v })}
                      className={`py-3 rounded-xl text-xs font-medium border transition-all ${persona.voiceName === v ? 'bg-indigo-600 border-indigo-500 shadow-lg shadow-indigo-500/20 text-white' : 'bg-slate-950/30 border-white/5 text-slate-500 hover:border-white/20'}`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="p-8 bg-black/20 flex justify-end">
              <button onClick={handleSaveSettings} className="px-10 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-full text-sm font-semibold transition-all shadow-lg shadow-indigo-900/20 active:scale-95 text-white">
                Save & Protect
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dialogue History */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/90 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-2xl bg-slate-900/80 border border-white/10 rounded-[2.5rem] overflow-hidden shadow-2xl flex flex-col max-h-[85vh] animate-slide-up">
            <div className="p-8 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <MessageSquare size={20} className="text-indigo-400" />
                <h3 className="text-xl font-semibold">Dialogue Stream</h3>
              </div>
              <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-white/5 rounded-full transition-colors"><X size={20} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-8 space-y-6 scrollbar-hide">
              {messages.length === 0 ? (
                <div className="text-center py-20 text-slate-600">
                  <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4"><Heart size={24} className="opacity-20" /></div>
                  The stream is clear and quiet.
                </div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} group`}>
                    <div className={`
                      max-w-[85%] rounded-[1.8rem] px-6 py-4 text-sm leading-relaxed
                      ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-white/5 border border-white/10 text-slate-200 rounded-tl-none'}
                    `}>
                      {m.text}
                    </div>
                    <span className="text-[10px] text-slate-600 mt-2 px-2 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                      {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                ))
              )}
            </div>
            <div className="p-8 bg-black/20 flex justify-between items-center">
              <button onClick={() => setMessages([])} className="text-xs text-rose-400/60 hover:text-rose-400 font-semibold tracking-wider transition-colors">PURGE LOGS</button>
              <button onClick={() => setShowHistory(false)} className="px-8 py-3 bg-white/5 hover:bg-white/10 rounded-full text-xs font-semibold border border-white/5 transition-all">Close Sanctuary</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;