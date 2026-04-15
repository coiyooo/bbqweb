import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Flame,
  Bot,
  Cpu,
  Mic,
  Send,
  Play,
  Pause,
  Square,
  RefreshCw,
  Clock,
  CheckCircle2,
  History,
  LayoutGrid,
  Terminal,
  Utensils,
  Volume2,
  Settings,
  Download
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

  
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8788';

type Status = 'idle' | 'running' | 'paused' | 'error' | 'success' | 'offline';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface ApiWorkflowStep {
  key: string;
  label: string;
  status: 'done' | 'running' | 'todo';
}

interface ApiCurrentOrder {
  order_id?: string | null;
  task_id?: string | null;
  status?: string;
  item_type?: string | null;
  count?: number;
  spoken_text?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  execution_round?: number | null;
}

interface ApiKitchenSlot {
  slot: string;
  occupied: boolean;
  item_id?: string | null;
  item_type?: string | null;
  entered_at?: string | null;
}

interface ApiTimer {
  item_id: string;
  item_type: string;
  slot: string;
  entered_A3_at?: string | null;
  expected_done_at?: string | null;
  remaining_seconds: number;
  total_seconds: number;
  progress_percent: number;
  cron_name?: string | null;
  status: string;
}

interface ApiLog {
  time: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

interface ApiStatusResponse {
  ok: boolean;
  timestamp: string;
  agent_status: Status;
  robot_status: Status;
  voice_status: Status;
  tts_status: Status;
  current_stage: string;
  current_stage_label: string;
  system_mode: string;
  is_paused: boolean;
  has_error: boolean;
  error_message: string;
  current_order: ApiCurrentOrder;
  workflow: {
    steps: ApiWorkflowStep[];
  };
  kitchen_state: Record<string, ApiKitchenSlot[]>;
  timers: ApiTimer[];
  latest_reply: string;
  logs: ApiLog[];
}

interface ChatResponse {
  ok: boolean;
  user_message: string;
  assistant_message: string;
  intent: string;
  accepted: boolean;
  order_id?: string | null;
  task_id?: string | null;
  agent_status: Status;
  robot_status: Status;
  created_at?: string | null;
}

const QUICK_COMMANDS = ['来两串牛肉', '来三串鱼豆腐', '暂停任务', '少油'];

const DEFAULT_WORKFLOW = [
  { key: 'PENDING', label: '待处理', status: 'todo' as const },
  { key: 'A1_TO_A2', label: 'A1夹取', status: 'todo' as const },
  { key: 'PREPARE', label: '喷油/撒料', status: 'todo' as const },
  { key: 'A2_TO_A3', label: 'A2上炉', status: 'todo' as const },
  { key: 'GRILL_WAIT', label: 'A3烤制', status: 'todo' as const },
  { key: 'A3_TO_A4', label: 'A4出串', status: 'todo' as const },
  { key: 'DONE', label: '完成', status: 'todo' as const },
];

function formatTime(input?: string | Date | null) {
  if (!input) return '--:--:--';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString([], { hour12: false });
}

function mapStatusText(status?: string) {
  if (!status) return '未知';
  const m: Record<string, string> = {
    pending: '待处理',
    running: '执行中',
    paused: '已暂停',
    done: '已完成',
    failed: '失败',
    stopped: '已停止',
    completed: '已完成',
    in_progress: '执行中',
  };
  return m[status] || status;
}

function flattenKitchenState(kitchenState: Record<string, ApiKitchenSlot[]>) {
  return ['A1', 'A2', 'A3', 'A4'].flatMap((zone) =>
    (kitchenState[zone] || []).map((slot) => ({
      ...slot,
      zone,
    }))
  );
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.json();
}



async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`POST ${path} failed: ${res.status}`);
  }
  return res.json();
}

export default function App() {
  const [agentStatus, setAgentStatus] = useState<Status>('idle');
  const [armStatus, setArmStatus] = useState<Status>('idle');
  const [voiceStatus, setVoiceStatus] = useState<Status>('idle');
  const [ttsStatus, setTtsStatus] = useState<Status>('idle');
  const [isDemoRunning, setIsDemoRunning] = useState(false);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'init-1',
      role: 'assistant',
      content: '你好！我是你的智能烧烤助手“烤汪汪”。今天想吃点什么？',
      timestamp: new Date(),
    },
  ]);
  const [userInput, setUserInput] = useState('');
  const [currentOrder, setCurrentOrder] = useState<ApiCurrentOrder | null>(null);
  const [kitchenState, setKitchenState] = useState<Record<string, ApiKitchenSlot[]>>({
    A1: [],
    A2: [],
    A3: [],
    A4: [],
  });
  const [timers, setTimers] = useState<ApiTimer[]>([]);
  const [logs, setLogs] = useState<ApiLog[]>([]);
  const [workflowSteps, setWorkflowSteps] = useState<ApiWorkflowStep[]>(DEFAULT_WORKFLOW);
  const [currentStage, setCurrentStage] = useState<string>('PENDING');
  const [latestReply, setLatestReply] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [isSending, setIsSending] = useState(false);

const asrWsRef = useRef<WebSocket | null>(null);
const audioContextRef = useRef<AudioContext | null>(null);
const processorRef = useRef<ScriptProcessorNode | null>(null);
const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
const mediaStreamRef = useRef<MediaStream | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);

  const flatKitchenState = useMemo(() => flattenKitchenState(kitchenState), [kitchenState]);

  const appendMessage = (role: 'user' | 'assistant', content: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role,
        content,
        timestamp: new Date(),
      },
    ]);
  };
  const downsampleBuffer = (
  buffer: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
) => {
  if (outputSampleRate === inputSampleRate) return buffer;

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
};

const floatTo16BitPCM = (float32Array: Float32Array) => {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);

  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }

  return buffer;
};

const stopFunASR = () => {
  try {
    asrWsRef.current?.send(JSON.stringify({ type: 'finish' }));
  } catch {}

  try {
    processorRef.current?.disconnect();
  } catch {}

  try {
    sourceRef.current?.disconnect();
  } catch {}

  mediaStreamRef.current?.getTracks().forEach((track) => track.stop());

  if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
    audioContextRef.current.close().catch(() => {});
  }

  asrWsRef.current = null;
  audioContextRef.current = null;
  processorRef.current = null;
  sourceRef.current = null;
  mediaStreamRef.current = null;

  setIsListening(false);
  setVoiceStatus('idle');
};

const startFunASR = async () => {
  try {
    const ws = new WebSocket('ws://127.0.0.1:8790/asr');
    ws.binaryType = 'arraybuffer';
    asrWsRef.current = ws;

    ws.onopen = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;

        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;

        const source = audioContext.createMediaStreamSource(stream);
        sourceRef.current = source;

        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (event) => {
          if (!asrWsRef.current || asrWsRef.current.readyState !== WebSocket.OPEN) return;

          const inputData = event.inputBuffer.getChannelData(0);
          const downsampled = downsampleBuffer(inputData, audioContext.sampleRate, 16000);
          const pcmBuffer = floatTo16BitPCM(downsampled);

          asrWsRef.current.send(pcmBuffer);
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        setIsListening(true);
        setVoiceStatus('running');
      } catch (err) {
        console.error(err);
        setVoiceStatus('error');
        stopFunASR();
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'result') {
          if (typeof data.text === 'string') {
            setUserInput(data.text);
          }
        }

        if (data.type === 'error') {
          console.error('FunASR error:', data.message);
          setVoiceStatus('error');
          stopFunASR();
        }

        if (data.type === 'task-finished') {
          stopFunASR();
        }
      } catch (err) {
        console.error(err);
      }
    };

    ws.onerror = (err) => {
      console.error(err);
      setVoiceStatus('error');
      stopFunASR();
    };

    ws.onclose = () => {
      setIsListening(false);
      setVoiceStatus('idle');
    };
  } catch (err) {
    console.error(err);
    setVoiceStatus('error');
    stopFunASR();
  }
};

const toggleVoiceInput = async () => {
  if (isListening) {
    stopFunASR();
    return;
  }

  await startFunASR();
};
  const playTTS = (content: string) => {
    if (!content || !('speechSynthesis' in window)) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(content);
    utterance.lang = 'zh-CN';
    utterance.rate = 1.08;
    utterance.pitch = 1.08;

    utterance.onstart = () => setTtsStatus('running');
    utterance.onend = () => setTtsStatus('idle');
    utterance.onerror = () => setTtsStatus('error');

    window.speechSynthesis.speak(utterance);
  };

  const syncStatus = async () => {
    try {
      const data = await apiGet<ApiStatusResponse>('/api/status');

      setAgentStatus(data.agent_status || 'idle');
      setArmStatus(data.robot_status || 'idle');
      setVoiceStatus((prev) => (isListening ? prev : data.voice_status || 'idle'));
      setTtsStatus((prev) => (prev === 'running' ? prev : data.tts_status || 'idle'));

      setCurrentOrder(data.current_order || null);
      setKitchenState(
        data.kitchen_state || {
          A1: [],
          A2: [],
          A3: [],
          A4: [],
        }
      );
      setTimers(data.timers || []);
      setLogs(data.logs || []);
      setWorkflowSteps(data.workflow?.steps || DEFAULT_WORKFLOW);
      setCurrentStage(data.current_stage || 'PENDING');
      setLatestReply(data.latest_reply || '');
    } catch (err) {
      console.error(err);
      setAgentStatus('offline');
      setArmStatus('offline');
    }
  };


  const handleSend = async (forcedText?: string) => {
    const text = (forcedText ?? userInput).trim();
    if (!text || isSending) return;

    appendMessage('user', text);
    setUserInput('');
    setIsSending(true);

    try {
      const data = await apiPost<ChatResponse>('/api/chat', {
        message: text,
        source: 'web',
        session_id: 'default',
      });

      setAgentStatus(data.agent_status || 'idle');
      setArmStatus(data.robot_status || 'idle');

      if (data.assistant_message) {
        appendMessage('assistant', data.assistant_message);
      }
      

      await syncStatus();
    } catch (err) {
      console.error(err);
      appendMessage('assistant', '前端发送失败，暂时没有成功连接 bridge API。');
      setAgentStatus('error');
    } finally {
      setIsSending(false);
    }
  };

  const resetSystem = async () => {
    try {
      await apiPost('/api/stop');
      await syncStatus();
      appendMessage('assistant', '当前任务已终止，系统已重置到空闲态。');
    } catch (err) {
      console.error(err);
    }
  };

  const pauseTask = async () => {
    try {
      await apiPost('/api/pause', { reason: 'web_manual_pause' });
      await syncStatus();
    } catch (err) {
      console.error(err);
    }
  };

  const resumeTask = async () => {
    try {
      await apiPost('/api/resume');
      await syncStatus();
    } catch (err) {
      console.error(err);
    }
  };

  const stopTask = async () => {
    try {
      await apiPost('/api/stop');
      await syncStatus();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="flex flex-col h-screen max-h-screen overflow-hidden text-sm">
      <header className="flex items-center justify-between px-6 py-3 border-b border-white/10 bg-bbq-card/50 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className="p-2 rounded-lg bg-bbq-orange/20 text-bbq-orange">
            <Flame className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">
              烧烤大师 <span className="text-bbq-orange">Barbecue Master</span>
            </h1>
            <p className="text-xs text-gray-400">OpenClaw 智能烧烤协作系统 v1.0</p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <StatusIndicator icon={<Bot size={14} />} label="Agent" status={agentStatus} />
          <StatusIndicator icon={<Cpu size={14} />} label="机械臂" status={armStatus} />
          <StatusIndicator icon={<Mic size={14} />} label="语音" status={voiceStatus} />
          <StatusIndicator icon={<Volume2 size={14} />} label="TTS" status={ttsStatus} />

          <button
            onClick={() => setIsDemoRunning(!isDemoRunning)}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-full font-medium transition-all ${
              isDemoRunning
                ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                : 'bg-bbq-orange text-white hover:bg-bbq-orange/90'
            }`}
          >
            {isDemoRunning ? <Square size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            {isDemoRunning ? '停止演示' : '开始演示'}
          </button>
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden p-4 gap-4">
        <section className="w-1/4 flex flex-col gap-4">
          <div className="flex-1 flex flex-col glass-panel overflow-hidden">
            <div className="p-3 border-b border-white/5 flex items-center justify-between bg-white/5">
              <div className="flex items-center gap-2">
                <Bot size={16} className="text-bbq-orange" />
                <span className="font-semibold">智能助手: 烤汪汪</span>
              </div>
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse delay-75" />
                <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse delay-150" />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] p-3 rounded-2xl ${
                      msg.role === 'user'
                        ? 'bg-bbq-orange text-white rounded-tr-none'
                        : 'bg-white/10 text-gray-200 rounded-tl-none border border-white/5'
                    }`}
                  >
                    <p className="leading-relaxed">{msg.content}</p>
                    <span className="text-[10px] opacity-50 mt-1 block text-right">
                      {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            <div className="p-3 bg-white/5 border-t border-white/5 space-y-3">
              <div className="flex flex-wrap gap-2">
                {QUICK_COMMANDS.map((cmd) => (
                  <button
                    key={cmd}
                    onClick={() => handleSend(cmd)}
                    className="px-2 py-1 text-[11px] bg-white/5 hover:bg-white/10 border border-white/10 rounded-md text-gray-400 transition-colors"
                  >
                    {cmd}
                  </button>
                ))}
              </div>

              <div className="relative">
                <input
                  type="text"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                  placeholder="输入指令或闲聊..."
                  className="w-full bg-bbq-dark/50 border border-white/10 rounded-xl py-2.5 pl-4 pr-20 focus:outline-none focus:border-bbq-orange/50 transition-all"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  <button
                    onClick={toggleVoiceInput}
                    className={`p-1.5 rounded-lg transition-colors ${
                      isListening ? 'bg-red-500 text-white animate-pulse' : 'hover:bg-white/10 text-gray-400'
                    }`}
                  >
                    <Mic size={18} />
                  </button>
                  <button
                    onClick={() => handleSend()}
                    className="p-1.5 bg-bbq-orange text-white rounded-lg hover:bg-bbq-orange/90 transition-colors"
                  >
                    <Send size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="flex-1 flex flex-col gap-4">
          <div className="glass-panel p-5 relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <Utensils size={80} />
            </div>
            <div className="flex justify-between items-start mb-6">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-2 py-0.5 bg-bbq-orange/20 text-bbq-orange text-[10px] font-bold rounded uppercase tracking-wider">
                    Active Order
                  </span>
                  <h2 className="text-lg font-bold text-white">{currentOrder?.order_id || '等待订单...'}</h2>
                </div>
                <p className="text-xs text-gray-400">创建于: {formatTime(currentOrder?.created_at)}</p>
              </div>

              <div className="text-right">
                <div className="text-xs text-gray-500 mb-1">阶段</div>
                <div className="text-sm font-bold text-bbq-orange">{currentStage || 'PENDING'}</div>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-3 relative z-10">
              <InfoCard label="食材" value={currentOrder?.item_type || '--'} />
              <InfoCard label="数量" value={String(currentOrder?.count ?? 0)} />
              <InfoCard label="状态" value={mapStatusText(currentOrder?.status)} />
              <InfoCard label="轮次" value={String(currentOrder?.execution_round ?? 0)} />
            </div>

            <div className="mt-4 p-3 rounded-xl bg-white/5 border border-white/5">
              <div className="text-[11px] text-gray-500 mb-1">最新回复</div>
              <div className="text-sm text-gray-200">{latestReply || '等待系统回复...'}</div>
            </div>
          </div>

          <div className="glass-panel p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-bold text-white">执行流程</h2>
              <span className="text-xs text-gray-400">{currentStage}</span>
            </div>

            <div className="flex items-center justify-between gap-2">
              {workflowSteps.map((step, idx) => (
                <React.Fragment key={step.key}>
                  <div className="flex flex-col items-center gap-2 min-w-[72px]">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold border transition-all ${
                        step.status === 'done'
                          ? 'bg-green-500/15 border-green-500/40 text-green-400'
                          : step.status === 'running'
                          ? 'bg-bbq-orange/15 border-bbq-orange/40 text-bbq-orange animate-pulse'
                          : 'bg-white/5 border-white/10 text-gray-500'
                      }`}
                    >
                      {step.status === 'done' ? <CheckCircle2 size={18} /> : idx + 1}
                    </div>
                    <span className="text-[11px] text-center text-gray-300">{step.label}</span>
                  </div>
                  {idx < workflowSteps.length - 1 && <Chevron />}
                </React.Fragment>
              ))}
            </div>
          </div>

          <div className="glass-panel p-4 flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="font-bold text-white">A3 烤制计时</h2>
                <p className="text-xs text-gray-500">基于后端真实状态刷新</p>
              </div>
              <div className="text-[10px] text-gray-500 flex items-center gap-3">
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-bbq-orange" /> 进行中
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-green-500" /> 已完成
                </div>
              </div>
            </div>

            <div className="flex-1 grid grid-cols-2 gap-4 overflow-y-auto pr-2 scrollbar-hide">
              <AnimatePresence>
                {timers.length > 0 ? (
                  timers.map((timer) => {
                    const isDone = timer.status === 'done' || timer.remaining_seconds <= 0;
                    const progress =
                      timer.total_seconds > 0
                        ? ((timer.total_seconds - timer.remaining_seconds) / timer.total_seconds) * 100
                        : 0;

                    return (
                      <motion.div
                        key={timer.item_id}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        className={`p-4 rounded-xl border transition-all duration-500 ${
                          isDone
                            ? 'bg-green-500/10 border-green-500/30 status-glow-green'
                            : 'bg-bbq-orange/5 border-bbq-orange/20'
                        }`}
                      >
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <h3 className="font-bold text-white">{timer.item_type}</h3>
                            <p className="text-[10px] text-gray-500">ID: {timer.item_id}</p>
                            <p className="text-[10px] text-gray-500">位点: {timer.slot}</p>
                          </div>
                          {isDone ? (
                            <CheckCircle2 className="text-green-500" size={20} />
                          ) : (
                            <div className="text-xl font-mono font-black text-bbq-orange">
                              {Math.floor(timer.remaining_seconds / 60)}:
                              {(timer.remaining_seconds % 60).toString().padStart(2, '0')}
                            </div>
                          )}
                        </div>

                        <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                          <motion.div
                            initial={{ width: '0%' }}
                            animate={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
                            className={`h-full ${isDone ? 'bg-green-500' : 'bg-bbq-orange'}`}
                          />
                        </div>

                        <div className="mt-3 flex justify-between text-[9px] text-gray-500 font-mono">
                          <span>IN: {formatTime(timer.entered_A3_at)}</span>
                          <span>DONE: {formatTime(timer.expected_done_at)}</span>
                        </div>
                      </motion.div>
                    );
                  })
                ) : (
                  <div className="col-span-2 flex flex-col items-center justify-center h-full text-gray-600 opacity-50">
                    <Clock size={48} strokeWidth={1} className="mb-2" />
                    <p>暂无活跃计时器</p>
                  </div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </section>

        <section className="w-1/4 flex flex-col gap-4">
          <div className="glass-panel p-4">
            <div className="flex items-center gap-2 mb-4">
              <LayoutGrid size={16} className="text-bbq-orange" />
              <h2 className="font-bold text-white">Kitchen State</h2>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {['A1', 'A2', 'A3', 'A4'].map((zone) => (
                <div key={zone} className="space-y-2">
                  <span className="text-[10px] font-bold text-gray-500 ml-1">{zone} 区</span>
                  <div className="space-y-1">
                    {(kitchenState[zone] || []).map((slot) => (
                      <div
                        key={slot.slot}
                        className={`p-2 rounded-lg border text-[10px] flex items-center justify-between ${
                          slot.occupied
                            ? 'bg-bbq-orange/10 border-bbq-orange/30 text-bbq-orange'
                            : 'bg-white/5 border-white/5 text-gray-600'
                        }`}
                      >
                        <span>{slot.slot}</span>
                        <span className="font-bold">{slot.occupied ? slot.item_type || slot.item_id || '占用' : '空闲'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="glass-panel p-4">
            <div className="flex items-center gap-2 mb-3">
              <Terminal size={16} className="text-bbq-orange" />
              <h2 className="font-bold text-white">Current Order Parsing</h2>
            </div>
            <div className="bg-black/40 rounded-lg p-3 font-mono text-[10px] space-y-2 text-green-400/80">
              <div><span className="text-gray-500">raw_text:</span> "{currentOrder?.spoken_text || 'null'}"</div>
              <div><span className="text-gray-500">parsed_item:</span> {currentOrder?.item_type || 'null'}</div>
              <div><span className="text-gray-500">parsed_count:</span> {currentOrder?.count ?? 0}</div>
              <div><span className="text-gray-500">order_id:</span> {currentOrder?.order_id || 'null'}</div>
              <div><span className="text-gray-500">execution_round:</span> {currentOrder?.execution_round ?? 0}</div>
            </div>
          </div>

          <div className="flex-1 glass-panel p-4 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <History size={16} className="text-bbq-orange" />
                <h2 className="font-bold text-white">System Logs</h2>
              </div>
              <button className="text-[10px] text-gray-500 hover:text-white flex items-center gap-1">
                <Download size={10} /> 导出
              </button>
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-[10px] space-y-1.5 scrollbar-hide">
              {logs.map((log, idx) => (
                <div key={`${log.time}-${idx}`} className="flex gap-2 leading-tight">
                  <span className="text-gray-600 shrink-0">[{formatTime(log.time)}]</span>
                  <span
                    className={`shrink-0 font-bold ${
                      log.level === 'error'
                        ? 'text-red-500'
                        : log.level === 'warn'
                        ? 'text-orange-500'
                        : log.level === 'success'
                        ? 'text-green-400'
                        : 'text-gray-400'
                    }`}
                  >
                    {log.level.toUpperCase()}
                  </span>
                  <span className="text-gray-300 break-all">{log.message}</span>
                </div>
              ))}
              {logs.length === 0 && <div className="text-gray-700 italic">等待系统事件...</div>}
            </div>
          </div>
        </section>
      </main>

      <footer className="px-6 py-3 border-t border-white/10 bg-bbq-card/50 backdrop-blur-xl flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Manual Controls</span>
          <div className="h-4 w-px bg-white/10" />
          <div className="flex gap-2">
            <ControlBtn icon={<RefreshCw size={14} />} label="重置系统" onClick={resetSystem} color="red" />
            <ControlBtn icon={<Pause size={14} />} label="异常暂停" onClick={pauseTask} />
            <ControlBtn icon={<Play size={14} />} label="恢复运行" onClick={resumeTask} />
            <ControlBtn icon={<Square size={14} />} label="停止任务" onClick={stopTask} />
          </div>
        </div>

        <div className="flex items-center gap-4 text-[10px] text-gray-500">
          <div className="flex items-center gap-1">
            <Settings size={12} />
            <span>Config: BBQ_ARM_V2</span>
          </div>
          <div className="flex items-center gap-1">
            <Cpu size={12} />
            <span>API: {API_BASE}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function StatusIndicator({
  icon,
  label,
  status,
}: {
  icon: React.ReactNode;
  label: string;
  status: Status;
}) {
  const colorClass =
    status === 'running'
      ? 'text-green-500'
      : status === 'error'
      ? 'text-red-500'
      : status === 'paused'
      ? 'text-orange-500'
      : status === 'offline'
      ? 'text-gray-400'
      : 'text-gray-500';

  const glowClass =
    status === 'running'
      ? 'status-glow-green'
      : status === 'error'
      ? 'status-glow-red'
      : status === 'paused'
      ? 'status-glow-orange'
      : '';

  return (
    <div className="flex items-center gap-2">
      <div className={`p-1.5 rounded-md bg-white/5 border border-white/10 ${colorClass} ${glowClass} transition-all duration-300`}>
        {icon}
      </div>
      <div className="flex flex-col">
        <span className="text-[9px] text-gray-500 font-bold uppercase leading-none mb-0.5">{label}</span>
        <span className={`text-[10px] font-bold leading-none ${colorClass}`}>
          {status.toUpperCase()}
        </span>
      </div>
    </div>
  );
}

function ControlBtn({
  icon,
  label,
  onClick,
  color = 'gray',
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  color?: 'gray' | 'red';
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all border ${
        color === 'red'
          ? 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
          : 'bg-white/5 border-white/10 text-gray-400 hover:bg-white/10 hover:text-white'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/5 border border-white/5 rounded-xl p-3">
      <div className="text-[11px] text-gray-500 mb-1">{label}</div>
      <div className="text-base font-bold text-white">{value}</div>
    </div>
  );
}

function Chevron() {
  return <div className="flex-1 h-px bg-white/10 min-w-[16px]" />;
}