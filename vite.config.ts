/// <reference types="vitest" />

import { defineConfig } from "vite";
import Vue from "@vitejs/plugin-vue";

export default defineConfig(({ mode }) => ({
  base: mode === "production" ? "/shuangpin/" : "/",
  plugins: [Vue()],
  test: {
    globals: true,
    environment: "jsdom",
  },
}));
