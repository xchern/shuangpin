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

const answer = computed(() => {
  const pys = getPinyinOf(hanziSeq.value.at(-1) ?? "");
  return pys.at(0) ?? "";
});

const hints = computed(() => {
  return (store.mode().py2sp.get(answer.value) ?? "").split("");
});

/**
 * 上一次 onSeq 是否为完整两键提交；配合 lastFullPair 识别
 * Keyboard 重复 send 的同一提交（反馈只播一次，统计仍与 CP-10 一致）。
 */
let lastSendWasFull = false;
/** 上一次完整提交的双键；仅在 lastSendWasFull 为 true 时有意义。 */
let lastFullPair: [string, string] | null = null;

function onSeq([lead, follow]: [string?, string?]) {
  const res = matchSpToPinyin(
    store.mode(),
    lead as Char,
    follow as Char,
    answer.value
  );

  const fullInput = !!lead && !!follow;

  // CP-11：当前目标已处于等待推进状态（正确输入后的 100ms 窗口内）时，
  // 忽略后续完整提交——不反馈、不统计、不推进；不清理也不重排推进定时器。
  if (fullInput && advanceTimer !== null) {
    return res.valid;
  }

  if (fullInput) {
    props.onValidInput?.(res.valid);
    store.updateProgressOnValid(res.lead, res.follow, res.valid);
    summary.value.onValid(res.valid);
  }

  pinyin.value = [res.lead, res.follow].filter((v) => !!v) as string[];

  isValid.value = res.valid;

  if (fullInput) {
    // Keyboard 每次按键释放都会 send；同一完整提交被重复 send 时
    // 不再重复反馈（统计照常，每次完整提交各记一次）。
    const resend =
      lastSendWasFull &&
      lastFullPair !== null &&
      lastFullPair[0] === lead &&
      lastFullPair[1] === follow;
    lastSendWasFull = true;
    lastFullPair = [lead, follow];

    if (store.settings.enableSoundFeedback && !resend) {
      playFeedback(res.valid ? "correct" : "incorrect");
    }

    if (res.valid) {
      scheduleAdvance();
    }
  } else {
    lastSendWasFull = false;
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
