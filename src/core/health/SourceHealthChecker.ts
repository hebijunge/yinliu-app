import { sourceRegistry } from '@providers/music/registry';
import { debugLogger } from '@shared/utils/debugLogger';

/**
 * W2 源健康探活（v25）：
 * 周期对注册表内全部音乐源跑 healthCheck()，维护「unknown → healthy ⇄ unhealthy → circuit_open」状态机；
 * 取链编排（player/download）进链前用 isSourceAvailable() 过滤不可用源，跳过继续走链（不碰链序）。
 *
 * 熔断口径（v25 拍板）：**仅探活结果计数**——连续 3 次探活失败才熔断 10 分钟；
 * 真实取链失败只记日志展示、不计数，避免 VIP 单曲失败误伤整源。
 * 快速回归：真实取链成功（reportSuccess）立即清零计数并标 healthy，
 * 防止「探活端点被墙但取链端点正常」时的误判长期压制可用源。
 */

export type SourceHealthState = 'unknown' | 'healthy' | 'unhealthy' | 'circuit_open';

export interface SourceHealthSnapshot {
  state: SourceHealthState;
  message: string;
  latency?: number;
  consecutiveFailures: number;
  circuitOpenUntil?: number;
  lastCheckedAt?: number;
}

const PROBE_INTERVAL_MS = 5 * 60 * 1000;
/** 各源 healthCheck 自带 5s 超时，此处为整体兜底上限 */
const PROBE_TIMEOUT_MS = 10 * 1000;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 10 * 60 * 1000;

class SourceHealthChecker {
  private snapshots = new Map<string, SourceHealthSnapshot>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private probing = false;

  start(): void {
    if (this.timer) return;
    // 首轮延迟 30s：避开冷启动网络竞争，不影响首帧与首播
    setTimeout(() => void this.probeAll(), 30 * 1000);
    this.timer = setInterval(() => void this.probeAll(), PROBE_INTERVAL_MS);
    debugLogger.info('network', '源健康探活已启动', {
      intervalMs: PROBE_INTERVAL_MS,
      failureThreshold: FAILURE_THRESHOLD,
      circuitOpenMs: CIRCUIT_OPEN_MS,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStatus(id: string): SourceHealthSnapshot {
    return (
      this.snapshots.get(id) || { state: 'unknown', message: '尚未探活', consecutiveFailures: 0 }
    );
  }

  getAllStatuses(): Record<string, SourceHealthSnapshot> {
    const out: Record<string, SourceHealthSnapshot> = {};
    for (const [id, snap] of this.snapshots) out[id] = snap;
    return out;
  }

  /**
   * 该源当前是否可进链。unknown 不干预取链；熔断到期后放行真实流量试一把
   * （下一轮探活成功即回归 healthy，失败则续期熔断）。
   */
  isSourceAvailable(id: string): boolean {
    const snap = this.snapshots.get(id);
    if (!snap) return true; // unknown / 未注册：不干预
    if (snap.state === 'circuit_open') {
      return snap.circuitOpenUntil !== undefined && Date.now() >= snap.circuitOpenUntil;
    }
    return snap.state !== 'unhealthy';
  }

  /**
   * 过滤降级链：剔除当前不健康/熔断中的源，保持原链序不变。
   * 过滤后为空 → 返回原链（全员不健康兜底：整体断网时不把所有源判死导致永久无法播放）。
   */
  filterChain(chain: string[]): string[] {
    const filtered = chain.filter((id) => this.isSourceAvailable(id));
    return filtered.length > 0 ? filtered : chain;
  }

  /** 真实取链成功上报：清零计数并标 healthy（快速回归） */
  reportSuccess(id: string): void {
    const snap = this.snapshots.get(id);
    if (snap && snap.state === 'healthy' && snap.consecutiveFailures === 0) return;
    this.snapshots.set(id, {
      state: 'healthy',
      message: '真实取链成功',
      consecutiveFailures: 0,
      latency: snap?.latency,
      lastCheckedAt: Date.now(),
    });
    if (snap && snap.state !== 'healthy') {
      debugLogger.info('network', `源快速回归: ${id}`, { prevState: snap.state });
    }
  }

  private async probeAll(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const sources = sourceRegistry.getAll();
      await Promise.all(sources.map((s) => this.probeOne(s.id, s.name)));
    } finally {
      this.probing = false;
    }
  }

  private async probeOne(id: string, name: string): Promise<void> {
    const prev = this.getStatus(id);
    const startedAt = Date.now();
    let ok = false;
    let message = '';
    try {
      const source = sourceRegistry.get(id);
      if (!source) return;
      const result = await Promise.race([
        source.healthCheck(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('探活超时')), PROBE_TIMEOUT_MS)
        ),
      ]);
      ok = result.healthy;
      message = result.message;
    } catch (err) {
      ok = false;
      message = err instanceof Error ? err.message : String(err);
    }
    const latency = Date.now() - startedAt;
    const now = Date.now();

    if (ok) {
      // 熔断期恢复探测成功 1 次即回归 healthy
      if (prev.state === 'circuit_open') {
        debugLogger.info('network', `熔断恢复: ${name}(${id})`, { latency });
      }
      this.snapshots.set(id, {
        state: 'healthy',
        message: message || '探活正常',
        latency,
        consecutiveFailures: 0,
        lastCheckedAt: now,
      });
      return;
    }

    const failures = prev.consecutiveFailures + 1;
    if (prev.state === 'circuit_open') {
      // 熔断期恢复探测失败：续期熔断
      const until = now + CIRCUIT_OPEN_MS;
      this.snapshots.set(id, {
        state: 'circuit_open',
        message,
        latency,
        consecutiveFailures: failures,
        circuitOpenUntil: until,
        lastCheckedAt: now,
      });
      debugLogger.warn('network', `熔断续期: ${name}(${id})`, { message, failures });
      return;
    }
    if (failures >= FAILURE_THRESHOLD) {
      this.snapshots.set(id, {
        state: 'circuit_open',
        message,
        latency,
        consecutiveFailures: failures,
        circuitOpenUntil: now + CIRCUIT_OPEN_MS,
        lastCheckedAt: now,
      });
      debugLogger.warn('network', `源熔断: ${name}(${id})`, {
        message,
        failures,
        circuitOpenMs: CIRCUIT_OPEN_MS,
      });
      return;
    }
    this.snapshots.set(id, {
      state: 'unhealthy',
      message,
      latency,
      consecutiveFailures: failures,
      lastCheckedAt: now,
    });
    debugLogger.warn('network', `源探活失败(${failures}/${FAILURE_THRESHOLD}): ${name}(${id})`, {
      message,
      latency,
    });
  }
}

export const sourceHealthChecker = new SourceHealthChecker();
