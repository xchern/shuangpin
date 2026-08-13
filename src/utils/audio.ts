/**
 * 音频服务（CP-04：汉字朗读）。
 *
 * 对外公开固定 API：unlockAudio / speakHanzi / stopAudio / playFeedback。
 * 模块加载阶段不访问 window、speechSynthesis 或 SpeechSynthesisUtterance，
 * 浏览器 API 只在调用时惰性读取并在缺失/异常时静默降级，绝不打断输入流程。
 * 不依赖 Vue / Pinia 或其他项目状态。
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

/** 播放反馈音。当前为安全 no-op，留待 CP-06 实现。 */
export function playFeedback(type: FeedbackType): void {
  void type;
}

/** 停止所有音频：清除待朗读内容并取消进行中的朗读。 */
export function stopAudio(): void {
  pendingHanzi = null;
  try {
    globalThis.speechSynthesis?.cancel();
  } catch {
    // API 缺失或异常时静默忽略。
  }
}
