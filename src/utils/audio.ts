/**
 * 音频服务（CP-04：汉字朗读 + CP-06：正/误反馈音）。
 *
 * 对外公开固定 API：unlockAudio / speakHanzi / stopAudio / playFeedback。
 * 模块加载阶段不访问 window、speechSynthesis、SpeechSynthesisUtterance
 * 或 AudioContext，浏览器 API 只在调用时惰性读取并在缺失/异常时静默降级，
 * 绝不打断输入流程。不依赖 Vue / Pinia 或其他项目状态。
 */

export type FeedbackType = "correct" | "incorrect";

/** 是否已通过用户手势解锁音频。 */
let audioUnlocked = false;

/** 解锁前待朗读的最新非空文本（null 表示无待朗读内容）。 */
let pendingHanzi: string | null = null;

/**
 * 用语音合成朗读指定文本。
 * 先 cancel 旧朗读再 speak；若浏览器 API 缺失或抛错则静默 no-op。
 */
function speakText(text: string): void {
  try {
    const synth = globalThis.speechSynthesis;
    const UtteranceCtor = globalThis.SpeechSynthesisUtterance;
    if (typeof synth === "undefined" || synth == null || typeof UtteranceCtor !== "function") {
      return;
    }

    // 新朗读先取消进行中的旧朗读。
    synth.cancel();

    const utterance = new UtteranceCtor(text);
    utterance.lang = "zh-CN";

    // 可选：优先选用可用的中文 voice（不做任何 voiceschanged 全局监听，
    // 第一版仅依赖 utterance.lang 即可）。
    try {
      const zhVoice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith("zh"));
      if (zhVoice) {
        utterance.voice = zhVoice;
      }
    } catch {
      // getVoices 不可用或抛错时忽略，仍按 lang 播放。
    }

    synth.speak(utterance);
  } catch {
    // 任何异常均静默忽略，保证不影响输入流程。
  }
}

/** 解锁音频（需由用户手势触发）。解锁后立即播放解锁前缓存的待朗读文本。 */
export function unlockAudio(): void {
  audioUnlocked = true;
  const text = pendingHanzi;
  if (text !== null) {
    pendingHanzi = null;
    speakText(text);
  }
}

/** 朗读指定汉字。解锁前只缓存最新非空文本，解锁后直接朗读。 */
export function speakHanzi(hanzi: string): void {
  if (hanzi === "") {
    return; // 空文本不进入待朗读队列，也不朗读
  }
  if (!audioUnlocked) {
    pendingHanzi = hanzi; // 只保留最新一个
    return;
  }
  speakText(hanzi);
}

/**
 * 反馈音配置：correct 为 880Hz 高音/短衰减，incorrect 为 330Hz 低音/长衰减。
 */
const FEEDBACK_TONES: Record<FeedbackType, { frequency: number; duration: number; peak: number }> = {
  correct: { frequency: 880, duration: 0.12, peak: 0.25 },
  incorrect: { frequency: 330, duration: 0.35, peak: 0.2 },
};

/** Web Audio 上下文（惰性创建并复用；null 表示不可用）。 */
let feedbackCtx: AudioContext | null = null;

/** 当前反馈音的活动节点（新反馈/stopAudio 时停止并清理，避免排队与泄漏）。 */
let activeOsc: OscillatorNode | null = null;
let activeGain: GainNode | null = null;

/**
 * 获取（必要时惰性创建）并返回 Web Audio 上下文。
 * 支持 AudioContext 或 webkitAudioContext；两者均缺失或创建抛错时返回 null。
 */
function getFeedbackContext(): AudioContext | null {
  try {
    if (feedbackCtx === null) {
      const w = globalThis as unknown as {
        AudioContext?: new () => AudioContext;
        webkitAudioContext?: new () => AudioContext;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (typeof Ctor !== "function") {
        return null;
      }
      feedbackCtx = new Ctor();
    }
    return feedbackCtx;
  } catch {
    return null;
  }
}

/** 停止并断开当前反馈节点（如有）。任何异常静默忽略。 */
function stopFeedbackNodes(): void {
  try {
    if (activeOsc !== null) {
      activeOsc.stop();
      activeOsc.disconnect();
      activeOsc = null;
    }
    if (activeGain !== null) {
      activeGain.disconnect();
      activeGain = null;
    }
  } catch {
    // 节点停止/断开异常时静默忽略。
  }
}

/**
 * 播放正确/错误反馈音（Web Audio）。
 * 惰性创建并复用 AudioContext；suspended 时先 resume（异常与 Promise 拒绝静默）；
 * 新反馈开始前停止/断开旧节点；API 缺失或任何调用异常均安全 no-op。
 */
export function playFeedback(type: FeedbackType): void {
  try {
    const ctx = getFeedbackContext();
    if (ctx === null) {
      return; // 不支持 Web Audio 时安全 no-op
    }

    // suspended 时先恢复上下文；resume 异常或 Promise 拒绝均静默忽略。
    if (ctx.state === "suspended") {
      try {
        const p = ctx.resume();
        if (p !== undefined && p !== null && typeof (p as Promise<void>).catch === "function") {
          (p as Promise<void>).catch(() => {});
        }
      } catch {
        // resume 异常静默忽略，仍继续尝试播放。
      }
    }

    // 新反馈开始前停止/断开旧反馈节点，避免排队与节点泄漏。
    stopFeedbackNodes();

    const tone = FEEDBACK_TONES[type];
    const startTime = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.setValueAtTime(tone.frequency, startTime);

    // 增益包络：从静音快速爬升到峰值后指数衰减至接近零，避免爆音。
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(tone.peak, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + tone.duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);

    activeOsc = osc;
    activeGain = gain;
  } catch {
    // 任何异常静默忽略，保证不影响输入流程。
  }
}

/** 停止所有音频：清除待朗读内容、取消进行中的朗读并停止当前反馈节点。 */
export function stopAudio(): void {
  pendingHanzi = null;
  stopFeedbackNodes();
  try {
    globalThis.speechSynthesis?.cancel();
  } catch {
    // API 缺失或异常时静默忽略。
  }
}
