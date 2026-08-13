import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import type { FeedbackType } from "../audio";

/**
 * CP-03：汉字朗读行为 RED 单元测试。
 *
 * 针对 src/utils/audio.ts 的固定公开 API（unlockAudio / speakHanzi /
 * stopAudio / playFeedback）验证外部可观察行为。当前生产代码为安全
 * no-op，因此多数行为断言预期失败（RED）；本文件不实现任何生产逻辑。
 *
 * jsdom 不提供 speechSynthesis / SpeechSynthesisUtterance，这里在
 * beforeEach 注入可恢复的 mock，afterEach 恢复全局状态；每个用例通过
 * vi.resetModules() 重新导入被测模块以隔离模块级状态，不依赖执行顺序。
 */

/** 测试用 SpeechSynthesisUtterance 替身（记录 text / lang 等属性）。 */
class MockSpeechSynthesisUtterance {
  text: string;
  lang = "";
  voice: unknown = null;
  volume = 1;
  rate = 1;
  pitch = 1;
  onstart: unknown = null;
  onend: unknown = null;
  onerror: unknown = null;

  constructor(text = "") {
    this.text = text;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return false;
  }
}

interface MockSpeechSynthesis {
  speaking: boolean;
  paused: boolean;
  pending: boolean;
  onvoiceschanged: null | (() => void);
  speak: Mock<[MockSpeechSynthesisUtterance], void>;
  cancel: Mock<[], void>;
  pause: Mock<[], void>;
  resume: Mock<[], void>;
  getVoices: Mock<[], SpeechSynthesisVoice[]>;
}

function createSpeechSynthesisMock(): MockSpeechSynthesis {
  const synth: MockSpeechSynthesis = {
    speaking: false,
    paused: false,
    pending: false,
    onvoiceschanged: null,
    speak: vi.fn((_utterance: MockSpeechSynthesisUtterance) => {
      synth.speaking = true;
      synth.pending = false;
    }),
    cancel: vi.fn(() => {
      synth.speaking = false;
      synth.pending = false;
    }),
    pause: vi.fn(() => {
      synth.paused = true;
    }),
    resume: vi.fn(() => {
      synth.paused = false;
    }),
    getVoices: vi.fn((): SpeechSynthesisVoice[] => []),
  };
  return synth;
}

/** 可恢复地替换全局值；afterEach 会恢复原状（jsdom 中原本不存在）。 */
function installGlobal(name: string, value: unknown): PropertyDescriptor | undefined {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  return original;
}

function restoreGlobal(name: string, original: PropertyDescriptor | undefined): void {
  if (original) {
    Object.defineProperty(globalThis, name, original);
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}

let synth: MockSpeechSynthesis;
let speakHanzi: (hanzi: string) => void;
let unlockAudio: () => void;
let stopAudio: () => void;
let playFeedback: (type: FeedbackType) => void;
const globalBackups = new Map<string, PropertyDescriptor | undefined>();

function stubSpeechGlobals(): void {
  for (const name of ["speechSynthesis", "SpeechSynthesisUtterance"] as const) {
    globalBackups.set(name, installGlobal(name, name === "speechSynthesis" ? synth : MockSpeechSynthesisUtterance));
  }
}

function restoreSpeechGlobals(): void {
  for (const name of Array.from(globalBackups.keys())) {
    restoreGlobal(name, globalBackups.get(name));
  }
  globalBackups.clear();
}

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../audio");
  unlockAudio = mod.unlockAudio;
  speakHanzi = mod.speakHanzi;
  stopAudio = mod.stopAudio;
  playFeedback = mod.playFeedback;

  synth = createSpeechSynthesisMock();
  stubSpeechGlobals();
});

afterEach(() => {
  restoreSpeechGlobals();
});

describe("API 缺失时的容错", () => {
  test("speechSynthesis 缺失时调用不抛错", () => {
    Object.defineProperty(globalThis, "speechSynthesis", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(() => {
      unlockAudio();
      speakHanzi("中");
      playFeedback("correct");
      stopAudio();
    }).not.toThrow();
  });

  test("SpeechSynthesisUtterance 缺失时调用不抛错", () => {
    Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    expect(() => {
      unlockAudio();
      speakHanzi("中");
      playFeedback("incorrect");
      stopAudio();
    }).not.toThrow();
  });
});

describe("speakHanzi 朗读行为", () => {
  test("空字符串不朗读", () => {
    speakHanzi(""); // 解锁前，空串不应进入待朗读队列
    unlockAudio(); // 解锁后也不应播放空串
    expect(synth.speak).not.toHaveBeenCalled();
    speakHanzi("好"); // 对照：非空汉字应正常朗读
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(synth.speak.mock.calls[0][0].text).toBe("好");
  });

  test("有效汉字使用 SpeechSynthesisUtterance，文本正确且 lang 为 zh-CN", () => {
    unlockAudio();
    speakHanzi("中");
    expect(synth.speak).toHaveBeenCalledTimes(1);
    const utterance = synth.speak.mock.calls[0][0];
    expect(utterance).toBeInstanceOf(MockSpeechSynthesisUtterance);
    expect(utterance.text).toBe("中");
    expect(utterance.lang).toBe("zh-CN");
  });

  test("新朗读先 cancel 旧朗读", () => {
    unlockAudio();
    speakHanzi("一");
    speakHanzi("二");
    expect(synth.speak).toHaveBeenCalledTimes(2);
    expect(synth.speak.mock.calls[1][0].text).toBe("二");
    expect(synth.cancel).toHaveBeenCalled();
    const cancelOrder = synth.cancel.mock.invocationCallOrder;
    const speakOrder = synth.speak.mock.invocationCallOrder;
    expect(cancelOrder[cancelOrder.length - 1]).toBeLessThan(speakOrder[1]);
  });
});

describe("unlockAudio 待朗读队列", () => {
  test("unlockAudio 之前只保留最新待朗读汉字，unlockAudio 后只播放最新一个", () => {
    speakHanzi("甲");
    speakHanzi("乙");
    expect(synth.speak).not.toHaveBeenCalled(); // 解锁前不朗读，只保留最新
    unlockAudio();
    expect(synth.speak).toHaveBeenCalledTimes(1); // 只播放最新一个
    expect(synth.speak.mock.calls[0][0].text).toBe("乙");
  });
});

describe("stopAudio", () => {
  test("stopAudio 清除待朗读内容", () => {
    speakHanzi("中"); // 解锁前进入待朗读队列
    stopAudio();
    unlockAudio(); // 若待朗读未被清除，这里会播放“中”
    expect(synth.speak).not.toHaveBeenCalled();
  });

  test("stopAudio 取消进行中的朗读", () => {
    unlockAudio();
    speakHanzi("中");
    expect(synth.speak).toHaveBeenCalledTimes(1);
    stopAudio();
    expect(synth.cancel).toHaveBeenCalled();
    const speakOrder = synth.speak.mock.invocationCallOrder;
    const cancelOrder = synth.cancel.mock.invocationCallOrder;
    expect(cancelOrder[cancelOrder.length - 1]).toBeGreaterThan(speakOrder[0]);
  });
});
