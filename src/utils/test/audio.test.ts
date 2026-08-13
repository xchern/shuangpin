import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";
import type { FeedbackType } from "../audio";

/**
 * CP-03：汉字朗读行为 + CP-05：正/误反馈音 RED 单元测试。
 *
 * 针对 src/utils/audio.ts 的固定公开 API（unlockAudio / speakHanzi /
 * stopAudio / playFeedback）验证外部可观察行为。当前生产代码为安全
 * no-op（playFeedback 尚未实现），因此反馈音相关断言预期失败（RED）；
 * 本文件不实现任何生产逻辑。
 *
 * jsdom 不提供 speechSynthesis / SpeechSynthesisUtterance / Web Audio
 * （AudioContext 等），这里在 beforeEach 注入可恢复的 mock（朗读与反馈
 * 音分开注入），afterEach 恢复全部全局状态；每个用例通过
 * vi.resetModules() 重新导入被测模块以隔离模块级状态，不依赖执行顺序。
 * 反馈音测试不依赖真实计时器或音频设备，全部通过 oscillator/gain spy 验证。
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

/** Web Audio 替身：AudioParam 记录全部调度（包络）调用，供 spy 断言。 */
class MockAudioParam {
  value: number;
  readonly schedule: Array<{ method: string; args: number[] }> = [];

  constructor(initialValue = 0) {
    this.value = initialValue;
  }

  private record(method: string, ...args: number[]): this {
    this.schedule.push({ method, args });
    return this;
  }

  setValueAtTime(value: number, time: number): this {
    this.value = value;
    return this.record("setValueAtTime", value, time);
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    return this.record("linearRampToValueAtTime", value, time);
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.value = value;
    return this.record("exponentialRampToValueAtTime", value, time);
  }

  cancelScheduledValues(time: number): this {
    return this.record("cancelScheduledValues", time);
  }
}

/** connect 目标占位节点；生产代码不会调用其方法。 */
class MockDestinationNode {
  // 仅作为 gain.connect(ctx.destination) 的目标，无需任何方法。
}

/** Web Audio 替身：OscillatorNode，方法全部为可断言的 spy。 */
class MockOscillatorNode {
  readonly frequency = new MockAudioParam(0);
  type: OscillatorType = "sine";
  readonly connect: Mock<[MockAudioNode], MockOscillatorNode> = vi.fn(
    (_dest: MockAudioNode) => this,
  );
  readonly disconnect: Mock<[], void> = vi.fn(() => {});
  readonly start: Mock<[], void> = vi.fn(() => {});
  readonly stop: Mock<[], void> = vi.fn(() => {});
}

/** Web Audio 替身：GainNode，方法全部为可断言的 spy。 */
class MockGainNode {
  readonly gain = new MockAudioParam(1);
  readonly connect: Mock<[MockAudioNode], MockGainNode> = vi.fn(
    (_dest: MockAudioNode) => this,
  );
  readonly disconnect: Mock<[], void> = vi.fn(() => {});
}

type MockAudioNode = MockOscillatorNode | MockGainNode | MockDestinationNode;

/**
 * Web Audio 替身：AudioContext。
 *
 * createOscillator / createGain 每次调用都会把新节点记入 created* 数组，
 * 方便测试断言“每次反馈恰好新建一个节点”。resume 模拟真实行为：
 * 调用后 state 变为 "running"。
 */
class MockAudioContext {
  readonly currentTime = 0;
  state: AudioContextState;
  readonly destination = new MockDestinationNode();
  readonly createdOscillators: MockOscillatorNode[] = [];
  readonly createdGains: MockGainNode[] = [];
  readonly resume: Mock<[], Promise<void>>;
  readonly createOscillator: Mock<[], MockOscillatorNode>;
  readonly createGain: Mock<[], MockGainNode>;

  constructor(state: AudioContextState = "running") {
    this.state = state;
    this.resume = vi.fn(() => {
      this.state = "running";
      return Promise.resolve();
    });
    this.createOscillator = vi.fn(() => {
      const osc = new MockOscillatorNode();
      this.createdOscillators.push(osc);
      return osc;
    });
    this.createGain = vi.fn(() => {
      const gain = new MockGainNode();
      this.createdGains.push(gain);
      return gain;
    });
  }
}

let synth: MockSpeechSynthesis;
let speakHanzi: (hanzi: string) => void;
let unlockAudio: () => void;
let stopAudio: () => void;
let playFeedback: (type: FeedbackType) => void;
const globalBackups = new Map<string, PropertyDescriptor | undefined>();

/** Web Audio 相关全局替身：每次测试重建，保证顺序无关。 */
let audioCtxCtor: Mock<[], MockAudioContext>;
let createdContexts: MockAudioContext[];
let nextContextState: AudioContextState = "running";

function stubSpeechGlobals(): void {
  for (const name of ["speechSynthesis", "SpeechSynthesisUtterance"] as const) {
    globalBackups.set(name, installGlobal(name, name === "speechSynthesis" ? synth : MockSpeechSynthesisUtterance));
  }
}

/** 注入 Web Audio 全局；webkitAudioContext 显式置为 undefined 以保证确定性。 */
function stubWebAudioGlobals(): void {
  nextContextState = "running";
  createdContexts = [];
  audioCtxCtor = vi.fn(() => {
    const ctx = new MockAudioContext(nextContextState);
    createdContexts.push(ctx);
    return ctx;
  });
  globalBackups.set("AudioContext", installGlobal("AudioContext", audioCtxCtor));
  globalBackups.set("webkitAudioContext", installGlobal("webkitAudioContext", undefined));
}

function restoreGlobals(): void {
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
  stubWebAudioGlobals();
});

afterEach(() => {
  restoreGlobals();
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

  test("AudioContext 与 webkitAudioContext 均缺失时 playFeedback 不抛错", () => {
    for (const name of ["AudioContext", "webkitAudioContext"] as const) {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }
    expect(() => {
      playFeedback("correct");
      playFeedback("incorrect");
      stopAudio();
    }).not.toThrow();
    expect(audioCtxCtor).not.toHaveBeenCalled(); // 缺失时不应尝试创建
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

describe("playFeedback 反馈音（Web Audio）", () => {
  test("第一次 playFeedback 惰性创建 AudioContext，后续复用同一实例", () => {
    expect(audioCtxCtor).not.toHaveBeenCalled(); // 调用前不创建
    playFeedback("correct");
    playFeedback("incorrect");
    // RED：no-op 时 audioCtxCtor 一次也不会被调用
    expect(audioCtxCtor).toHaveBeenCalledTimes(1);
    expect(createdContexts).toHaveLength(1); // 后续反馈复用同一个实例
  });

  test("context.state 为 suspended 时先 resume 再播放，running 后不重复 resume", () => {
    nextContextState = "suspended";
    playFeedback("correct");
    expect(createdContexts).toHaveLength(1); // RED：no-op 时不创建 context
    const ctx = createdContexts[0];
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    expect(ctx.state).toBe("running"); // resume 后应为 running
    // 同一 context 已 running，后续反馈不应再次 resume
    playFeedback("incorrect");
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  test("correct 与 incorrect 使用可观察到的不同频率与包络参数", () => {
    // 约定值（供 CP-06 参考）：correct 880Hz / 短衰减，incorrect 330Hz / 长衰减。
    playFeedback("correct");
    playFeedback("incorrect");
    expect(createdContexts).toHaveLength(1); // RED：no-op 时不创建 context
    const ctx = createdContexts[0];
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
    expect(ctx.createGain).toHaveBeenCalledTimes(2);
    const [correctOsc, incorrectOsc] = ctx.createdOscillators;
    const [correctGain, incorrectGain] = ctx.createdGains;
    // 频率：正/误反馈音高不同且为正
    expect(correctOsc.frequency.value).toBeGreaterThan(0);
    expect(incorrectOsc.frequency.value).toBeGreaterThan(0);
    expect(correctOsc.frequency.value).not.toBe(incorrectOsc.frequency.value);
    // 包络：各有峰值与衰减调度，且两种反馈的调度序列可观察地不同
    expect(correctGain.gain.schedule.length).toBeGreaterThanOrEqual(2);
    expect(incorrectGain.gain.schedule.length).toBeGreaterThanOrEqual(2);
    expect(correctGain.gain.schedule).not.toEqual(incorrectGain.gain.schedule);
  });

  test("单次 playFeedback 只创建并启动一个 oscillator", () => {
    playFeedback("correct");
    expect(createdContexts).toHaveLength(1); // RED：no-op 时不创建 context
    const ctx = createdContexts[0];
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    expect(ctx.createGain).toHaveBeenCalledTimes(1);
    expect(ctx.createdOscillators[0].start).toHaveBeenCalledTimes(1);
  });

  test("快速连续反馈会停止并断开前一个反馈，不形成长队列", () => {
    playFeedback("correct");
    playFeedback("incorrect");
    playFeedback("correct");
    expect(createdContexts).toHaveLength(1); // RED：no-op 时不创建 context
    const ctx = createdContexts[0];
    // 每次反馈恰好新建一个 oscillator（共 3 个，没有累积排队）
    expect(ctx.createOscillator).toHaveBeenCalledTimes(3);
    const [first, second, third] = ctx.createdOscillators;
    expect(first.start).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(third.start).toHaveBeenCalledTimes(1);
    // 前两个反馈已被停止并断开；只有最新一个保持活动
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(first.disconnect).toHaveBeenCalledTimes(1);
    expect(third.stop).not.toHaveBeenCalled();
    // 停止旧反馈发生在启动新反馈之前
    expect(first.stop.mock.invocationCallOrder[0]).toBeLessThan(
      third.start.mock.invocationCallOrder[0],
    );
  });

  test("stopAudio 停止当前反馈节点", () => {
    playFeedback("correct");
    expect(createdContexts).toHaveLength(1); // RED：no-op 时不创建 context
    const ctx = createdContexts[0];
    const osc = ctx.createdOscillators[0];
    stopAudio();
    expect(osc.stop).toHaveBeenCalledTimes(1);
    expect(osc.disconnect).toHaveBeenCalledTimes(1);
    // 未播放反馈时 stopAudio 也不抛错
    expect(() => stopAudio()).not.toThrow();
  });
});
