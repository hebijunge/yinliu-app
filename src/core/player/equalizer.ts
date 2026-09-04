/**
 * EQ 均衡器（v18）
 *
 * 纯 Web Audio API 实现：MediaElementAudioSourceNode → 5 段滤波链 → destination。
 * 设计约束（不破坏 v14.4 流式播放链路）：
 * - 默认关闭。关闭时完全不创建 AudioContext、不挂接任何 audio 元素，音频走原始直出路径。
 * - 只在 EQ 开启时挂接；且仅挂接同源/同源代理的 src（blob: / 同源 URL）。
 *   file:// 等 WebAudio 会视为跨域的 src 一律不挂接（挂接跨域源会导致静音）。
 * - 挂接前要求 AudioContext 已处于 running 态（先 resume），避免挂接后被自动播放策略
 *   挂起导致整条链路无声。
 * - 开启 EQ 后的流式缓存直读改用同源 blob URL（见 streaming/player.ts），保证 MSE/缓存
 *   两条播放路径都能被均衡器覆盖。
 */

import { create } from 'zustand';
import { debugLogger } from '@shared/utils/debugLogger';

export interface EqBand {
  freq: number;
  label: string;
  type: BiquadFilterType;
  q?: number;
}

/** 5 段频率：60Hz – 12kHz */
export const EQ_BANDS: EqBand[] = [
  { freq: 60, label: '60Hz', type: 'lowshelf' },
  { freq: 230, label: '230Hz', type: 'peaking', q: 0.9 },
  { freq: 910, label: '910Hz', type: 'peaking', q: 0.9 },
  { freq: 3600, label: '3.6kHz', type: 'peaking', q: 0.9 },
  { freq: 12000, label: '12kHz', type: 'highshelf' },
];

export interface EqPreset {
  label: string;
  gains: number[];
}

/** 6 种内置预设（dB，-12 ~ +12） */
export const EQ_PRESETS: Record<string, EqPreset> = {
  flat: { label: '原声', gains: [0, 0, 0, 0, 0] },
  pop: { label: '流行', gains: [-1, 2, 3, 2, -1] },
  rock: { label: '摇滚', gains: [4, 3, 1, 2, 3] },
  classical: { label: '古典', gains: [2, 1, 0, 1, 2] },
  jazz: { label: '爵士', gains: [2, 1, -1, 2, 3] },
  vocal: { label: '人声', gains: [-2, -1, 3, 3, 1] },
};

export const EQ_GAIN_MIN = -12;
export const EQ_GAIN_MAX = 12;

export interface EqCustomPreset {
  name: string;
  gains: number[];
}

interface EqState {
  enabled: boolean;
  /** 内置预设 id 或 custom:<name> */
  presetId: string;
  /** 当前各段增益（dB） */
  gains: number[];
  customPresets: EqCustomPreset[];

  setEnabled: (v: boolean) => void;
  applyPreset: (presetId: string) => void;
  setBandGain: (index: number, gain: number) => void;
  saveCustomPreset: (name: string) => boolean;
  deleteCustomPreset: (name: string) => void;
}

const STORAGE_KEY = 'yinliu.eq.v1';

interface EqPersisted {
  enabled?: boolean;
  presetId?: string;
  gains?: number[];
  customPresets?: EqCustomPreset[];
}

function loadPersisted(): EqPersisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as EqPersisted;
  } catch {
    return {};
  }
}

function clampGain(v: number): number {
  return Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, Math.round(v)));
}

function sanitizeGains(gains: unknown): number[] {
  if (!Array.isArray(gains) || gains.length !== EQ_BANDS.length) return EQ_PRESETS.flat.gains.slice();
  return gains.map((g) => clampGain(Number(g) || 0));
}

function persist(state: EqState): void {
  try {
    const data: EqPersisted = {
      enabled: state.enabled,
      presetId: state.presetId,
      gains: state.gains,
      customPresets: state.customPresets,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // 存储不可用时静默降级
  }
}

const persisted = typeof window !== 'undefined' ? loadPersisted() : {};

/**
 * 均衡器音频服务：负责 Web Audio 图的创建、挂接与增益应用。
 * 状态源是 useEqStore，服务只做音频侧执行。
 */
class EqualizerService {
  private ctx: AudioContext | null = null;
  private filters: BiquadFilterNode[] = [];
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private attachedEl: HTMLAudioElement | null = null;
  /**
   * v29-A3: 已挂接元素的源节点记账。createMediaElementSource 对同一元素二次调用
   * 会抛 InvalidStateError，且部分 WebView 内核在失败后令该元素音频永久静音
   * （EQ 开启 → 流式/本地歌曲来回切复用同一元素时触发）。按元素记账复用，
   * 同一元素绝不二次 create。
   */
  private sourceNodes = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>();
  /** v29-A3: 挂接 in-flight 互斥 —— 防止同一元素并发挂接竞态 */
  private attaching = false;
  /** v29-A3: 互斥期间到达的最新挂接目标，由在途任务收尾时接力处理 */
  private pendingAttach: HTMLAudioElement | null = null;
  /** 由 PlayerEngine 注入：返回当前活跃的 audio 元素（流式或普通） */
  private elementProvider: (() => HTMLAudioElement | null) | null = null;

  /** 某元素当前是否已挂接均衡器 */
  isAttached(el: HTMLAudioElement | null): boolean {
    return el !== null && el === this.attachedEl;
  }

  setElementProvider(provider: () => HTMLAudioElement | null): void {
    this.elementProvider = provider;
  }

  /** src 是否可安全挂接（非跨域：file:// 等会导致 WebAudio 静音，一律不挂） */
  private isAttachable(el: HTMLAudioElement): boolean {
    const src = el.src || '';
    if (!src) return false;
    if (src.startsWith('blob:') || src.startsWith('data:')) return true;
    try {
      return new URL(src).origin === location.origin;
    } catch {
      return false;
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      // 建立 5 段滤波链 → 输出
      this.filters = EQ_BANDS.map((band) => {
        const f = this.ctx!.createBiquadFilter();
        f.type = band.type;
        f.frequency.value = band.freq;
        if (band.q !== undefined) f.Q.value = band.q;
        f.gain.value = 0;
        return f;
      });
      for (let i = 0; i < this.filters.length - 1; i++) {
        this.filters[i].connect(this.filters[i + 1]);
      }
      this.filters[this.filters.length - 1].connect(this.ctx.destination);
      debugLogger.info('player', 'EQ 均衡器音频链路已建立', { bands: EQ_BANDS.map((b) => b.freq) });
      return this.ctx;
    } catch (err) {
      debugLogger.warn('player', 'EQ 音频上下文创建失败，均衡器不可用', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.ctx = null;
      return null;
    }
  }

  /**
   * 把均衡器挂接到 audio 元素（幂等）。仅在 EQ 开启且上下文可运行时挂接。
   * 失败一律静默降级为直出（不挂接），绝不影响播放本身。
   */
  async attachElement(el: HTMLAudioElement | null): Promise<void> {
    const { enabled, gains } = useEqStore.getState();
    if (!el || !enabled) return;
    if (el === this.attachedEl) {
      this.applyGains(gains);
      return;
    }
    if (!this.isAttachable(el)) {
      debugLogger.info('player', 'EQ 跳过挂接：音频源不可安全挂接（跨域/file URI）', {
        srcPrefix: (el.src || '').slice(0, 40),
      });
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx || !this.filters.length) return;

    // 必须等到 running 再挂接：suspended 状态下挂接会让音频整链静音
    try {
      if (ctx.state !== 'running') await ctx.resume();
    } catch {
      // resume 失败按不可挂接处理
    }
    if (ctx.state !== 'running') {
      debugLogger.warn('player', 'EQ 挂接跳过：音频上下文未进入运行态（等待用户手势后重试）', {
        state: ctx.state,
      });
      return;
    }

    // v29-A3: in-flight 互斥 —— 上一次挂接尚未完成时只记录最新目标，
    // 由在途任务收尾后接力挂接，避免并发 createMediaElementSource 竞态
    if (this.attaching) {
      this.pendingAttach = el;
      return;
    }
    this.attaching = true;

    try {
      // 释放旧元素上的源节点（旧元素即将废弃）
      if (this.sourceNode) {
        try {
          this.sourceNode.disconnect();
        } catch {
          // ignore
        }
        this.sourceNode = null;
      }

      // v29-A3: 记账复用 —— 该元素曾挂接过则复用既有源节点，重连到滤波链即可；
      // 绝不二次 createMediaElementSource（二次调用抛 InvalidStateError 并可能
      // 令元素永久静音）
      const existing = this.sourceNodes.get(el);
      let src: MediaElementAudioSourceNode;
      if (existing) {
        src = existing;
        src.connect(this.filters[0]);
      } else {
        src = ctx.createMediaElementSource(el);
        src.connect(this.filters[0]);
        this.sourceNodes.set(el, src);
      }

      this.sourceNode = src;
      this.attachedEl = el;
      this.applyGains(gains);
      debugLogger.info('player', 'EQ 已挂接到当前播放元素', {
        srcPrefix: (el.src || '').slice(0, 40),
        reused: !!existing,
      });
    } catch (err) {
      // 挂接失败：保持直出，不影响播放
      this.sourceNode = null;
      this.attachedEl = null;
      debugLogger.warn('player', 'EQ 挂接失败，音频保持直出', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.attaching = false;
      // v29-A3: 接力处理互斥期间到达的最新挂接请求
      const pending = this.pendingAttach;
      this.pendingAttach = null;
      if (pending && pending !== this.attachedEl) {
        void this.attachElement(pending);
      }
    }
  }

  /** EQ 状态变化时同步当前元素（开启 → 挂接当前；关闭 → 滤链归零=透明直通） */
  syncCurrent(): void {
    const { enabled, gains } = useEqStore.getState();
    if (!enabled) {
      this.applyGains(EQ_PRESETS.flat.gains);
      return;
    }
    const el = this.elementProvider?.() ?? null;
    void this.attachElement(el);
  }

  /** 播放中保活：确保上下文处于运行态（自动播放策略/系统回收后自动恢复） */
  ensureActive(): void {
    const { enabled } = useEqStore.getState();
    if (!enabled || !this.ctx) return;
    if (this.ctx.state !== 'running') {
      void this.ctx.resume().catch(() => {
        // 恢复失败不打断播放；未挂接时直出不受影响，已挂接时等待下次用户手势再恢复
      });
    }
  }

  applyGains(gains: number[]): void {
    if (!this.filters.length) return;
    this.filters.forEach((f, i) => {
      const v = clampGain(gains[i] ?? 0);
      try {
        f.gain.value = v;
      } catch {
        // ignore
      }
    });
  }
}

export const eqService = new EqualizerService();

export const useEqStore = create<EqState>((set, get) => ({
  enabled: persisted.enabled ?? false,
  presetId: persisted.presetId ?? 'flat',
  gains: sanitizeGains(persisted.gains),
  customPresets: Array.isArray(persisted.customPresets) ? persisted.customPresets : [],

  setEnabled: (enabled) => {
    set({ enabled });
    persist(get());
    eqService.syncCurrent();
  },

  applyPreset: (presetId) => {
    let gains: number[];
    if (presetId.startsWith('custom:')) {
      const name = presetId.slice('custom:'.length);
      const found = get().customPresets.find((p) => p.name === name);
      gains = found ? sanitizeGains(found.gains) : EQ_PRESETS.flat.gains.slice();
    } else {
      const preset = EQ_PRESETS[presetId];
      gains = preset ? preset.gains.slice() : EQ_PRESETS.flat.gains.slice();
    }
    set({ presetId, gains });
    persist(get());
    eqService.applyGains(gains);
  },

  setBandGain: (index, gain) => {
    if (index < 0 || index >= EQ_BANDS.length) return;
    const gains = get().gains.slice();
    gains[index] = clampGain(gain);
    set({ gains, presetId: 'custom' });
    persist(get());
    eqService.applyGains(gains);
  },

  saveCustomPreset: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const { gains, customPresets } = get();
    const exists = customPresets.some((p) => p.name === trimmed);
    const customPresetsNext = exists
      ? customPresets.map((p) => (p.name === trimmed ? { name: trimmed, gains: gains.slice() } : p))
      : [...customPresets, { name: trimmed, gains: gains.slice() }];
    set({ customPresets: customPresetsNext, presetId: `custom:${trimmed}` });
    persist(get());
    return true;
  },

  deleteCustomPreset: (name) => {
    const customPresets = get().customPresets.filter((p) => p.name !== name);
    const patch: Partial<EqState> = { customPresets };
    if (get().presetId === `custom:${name}`) {
      patch.presetId = 'flat';
      patch.gains = EQ_PRESETS.flat.gains.slice();
    }
    set(patch as EqState);
    persist(get());
    if (patch.presetId === 'flat') eqService.applyGains(EQ_PRESETS.flat.gains);
  },
}));
