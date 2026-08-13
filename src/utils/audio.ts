/**
 * 音频服务（CP-02：空壳阶段）。
 *
 * 当前阶段所有函数均为安全 no-op，仅为后续实现提供稳定 API。
 * 模块加载时不访问 window、speechSynthesis 或 AudioContext，
 * 不依赖 Vue / Pinia 或其他项目状态。
 */

export type FeedbackType = "correct" | "incorrect";

/** 解锁音频（需由用户手势触发）。当前为 no-op。 */
export function unlockAudio(): void {
  void unlockAudio;
}

/** 朗读指定汉字。当前为 no-op。 */
export function speakHanzi(hanzi: string): void {
  void hanzi;
}

/** 播放反馈音。当前为 no-op。 */
export function playFeedback(type: FeedbackType): void {
  void type;
}

/** 停止所有音频。当前为 no-op。 */
export function stopAudio(): void {
  void stopAudio;
}
