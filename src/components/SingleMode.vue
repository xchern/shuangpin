<script setup lang="ts">
import Keyboard from "../components/Keyboard.vue";
import Hanzi from "../components/Hanzi.vue";
import Pinyin from "../components/Pinyin.vue";
import TypeSummary from "../components/TypeSummary.vue";
import MenuList from "../components/MenuList.vue";

import { onActivated, onDeactivated, ref, watchPostEffect } from "vue";
import { matchSpToPinyin } from "../utils/keyboard";
import { playFeedback, speakHanzi, stopAudio } from "../utils/audio";
import { useStore } from "../store";
import { computed } from "vue";
import { getPinyinOf } from "../utils/hanzi";
import { TypingSummary } from "../utils/summary";
import { followKeys, leadKeys } from "../utils/pinyin";
import { randInt, randomChoice } from "../utils/number";

export interface SingleModeProps {
  nextChar?: () => string;
  hanziList?: string[];
  onValidInput?: (result: boolean) => void;
  mode?: "Lead" | "Follow";
}

function nextChar() {
  if (!props.mode) {
    return props.nextChar?.() ?? "";
  }
  return props.hanziList?.[randInt(props.hanziList?.length)] ?? "";
}

const pinyin = ref<string[]>([]);

const store = useStore();
const props = defineProps<SingleModeProps>();
const hanziSeq = ref(new Array(4).fill(0).map(() => nextChar()));
const isValid = ref(false);

const summary = ref(new TypingSummary());

const keys = {
  Lead: leadKeys,
  Follow: followKeys,
  "": [] as string[],
}[props.mode ?? ""];

const progresses = computed(() =>
  keys.map((v) => {
    return {
      key: v,
      progress: store.getProgress(v),
    };
  })
);

const listMenuItems = computed(() => {
  return progresses.value.map(
    (v) =>
      `${v.key.toUpperCase()} ${(store.getAccuracy(v.key) * 100).toFixed(2)}%`
  );
});

const menuIndex = computed(() => {
  if (props.mode === "Lead") {
    return store.currentLeadIndex;
  } else if (props.mode === "Follow") {
    return store.currentFollowIndex;
  }
  return -1;
});

function onMenuChange(i: number) {
  if (props.mode === "Lead") {
    store.currentLeadIndex = i;
  } else if (props.mode === "Follow") {
    store.currentFollowIndex = i;
  }
}

watchPostEffect(() => {
  for (let i = 0; i < 4; ++i) {
    hanziSeq.value.unshift(nextChar());
    hanziSeq.value.pop();
  }
});

function onKeyPressed() {
  summary.value.onKeyPressed();
}

onActivated(() => {
  document.addEventListener("keypress", onKeyPressed);
  speakCurrent();
});

onDeactivated(() => {
  document.removeEventListener("keypress", onKeyPressed);
  clearAdvanceTimer();
  stopAudio();
});

/**
 * 当前目标字的全部去重读音；完整提交时逐一匹配，任一命中即正确。
 */
const answers = computed(() => {
  const pys = getPinyinOf(hanziSeq.value.at(-1) ?? "");
  return [...new Set(pys)];
});

const answer = computed(() => answers.value.at(0) ?? "");

const hints = computed(() => {
  return (store.mode().py2sp.get(answer.value) ?? "").split("");
});

/**
 * 对当前字全部去重读音逐一匹配；任一命中即返回该结果，
 * 全部未命中时返回最后一次匹配结果（用于展示 lead/follow）。
 */
function matchAnswers(lead: string, follow: string) {
  let last: ReturnType<typeof matchSpToPinyin> | null = null;
  for (const py of answers.value) {
    const res = matchSpToPinyin(store.mode(), lead as Char, follow as Char, py);
    if (res.valid) {
      return res;
    }
    last = res;
  }
  return last ?? { valid: false, lead, follow };
}

function onSeq([lead, follow]: [string?, string?]) {
  const fullInput = !!lead && !!follow;

  // CP-11：正确输入后的 100ms 推进窗口内，任何完整提交一律吞掉——
  // return true 让 Keyboard 清空缓冲；不反馈、不统计、不重排推进。
  if (fullInput && advanceTimer !== null) {
    return true;
  }

  // 完整提交按全部读音逐一匹配（任一命中即正确）；单键输入沿用
  // 第一个读音做提示性匹配（与 hints 一致）。
  const res = fullInput
    ? matchAnswers(lead ?? "", follow ?? "")
    : matchSpToPinyin(store.mode(), lead as Char, follow as Char, answer.value);

  if (fullInput) {
    props.onValidInput?.(res.valid);
    store.updateProgressOnValid(res.lead, res.follow, res.valid);
    summary.value.onValid(res.valid);
  }

  pinyin.value = [res.lead, res.follow].filter((v) => !!v) as string[];

  isValid.value = res.valid;

  if (fullInput) {
    if (store.settings.enableSoundFeedback) {
      playFeedback(res.valid ? "correct" : "incorrect");
    }

    if (res.valid) {
      scheduleAdvance();
    }
  }

  return res.valid;
}

/** 尚未执行的推进定时器；停用页面时清除，避免停用后仍切字/朗读。 */
let advanceTimer: ReturnType<typeof setTimeout> | null = null;

function clearAdvanceTimer() {
  if (advanceTimer !== null) {
    clearTimeout(advanceTimer);
    advanceTimer = null;
  }
}

/** 朗读当前目标字（hanziSeq 末尾），不朗读预览队列。 */
function speakCurrent() {
  if (!store.settings.enablePronunciation) {
    return;
  }
  const target = hanziSeq.value.at(-1) ?? "";
  if (target === "") {
    return;
  }
  speakHanzi(target);
}

/** 正确输入后延迟 100ms 推进到新字，并朗读新目标一次。 */
function advance() {
  hanziSeq.value.unshift(nextChar());
  hanziSeq.value.pop();
  pinyin.value = [];
  isValid.value = false;
  speakCurrent();
}

function scheduleAdvance() {
  clearAdvanceTimer();
  advanceTimer = setTimeout(() => {
    advanceTimer = null;
    advance();
  }, 100);
}
</script>

<template>
  <div class="home-page">
    <div class="single-menu">
      <menu-list
        :items="listMenuItems"
        :index="menuIndex"
        @menu-change="onMenuChange"
      />
    </div>

    <div class="input-area">
      <Pinyin :chars="pinyin" />
    </div>

    <div class="hanzi-list">
      <Hanzi :hanzi-seq="[...hanziSeq]" />
    </div>

    <div class="single-keyboard">
      <Keyboard :valid-seq="onSeq" :hints="hints" />
    </div>

    <div class="summary">
      <TypeSummary
        :speed="summary.hanziPerMinutes"
        :accuracy="summary.accuracy"
        :avgpress="summary.pressPerHanzi"
      />
    </div>
  </div>
</template>

<style lang="less">
@import "../styles/color.less";
@import "../styles/var.less";

.home-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;

  .single-menu {
    position: absolute;
    top: 0;
    left: 100px;
  }

  .input-area {
    margin-bottom: 32px;
    height: 160px;
    display: flex;
    align-items: center;

    @media (max-width: 576px) {
      margin-top: 30vh;
    }
  }

  .summary {
    position: absolute;
    right: var(--app-padding);
    bottom: var(--app-padding);

    @media (max-width: 576px) {
      top: 36px;
    }
  }

  .hanzi-list {
    position: absolute;
    top: var(--app-padding);
    right: var(--app-padding);

    @media (max-width: 576px) {
      top: 120px;
    }
  }

  @media (max-width: 576px) {
    .single-keyboard {
      position: absolute;
      bottom: 1em;
    }
  }
}
</style>
