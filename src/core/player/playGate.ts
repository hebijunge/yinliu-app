/**
 * v22.1: 播放闸门 —— 播放请求的去重与串行化原语。
 *
 * 修复 v14.5 去重逻辑的竞态窗口（七源全流程走查阻断项）：
 * - 旧实现去重比较的是「currentTrack 与本次 track」而非挂起 Promise 的真实归属，
 *   loading 窗口内到达的任意请求都会错误复用上一次请求的结果（串曲 / 状态错乱）；
 * - 挂起 Promise 从不清理，失败后残留导致后续播放被完全卡死（锁残留）；
 * - 去重判定位于 abort / 清流等副作用之后，重复点击会先 abort 掉本应等待的取链。
 *
 * 语义：
 * - 同 key（sourceId_sourceSongId_quality）的进行中播放 → 复用同一 Promise，只实际播放一次；
 * - 不同 key → 串行排队：前一次播放管线彻底结束（含收尾）后才开始下一次，状态机不并发突变；
 * - 任务无论成功还是失败，占位都会释放——异常路径锁不残留；
 * - key 在 enter() 中同步占位，同一事件循环 tick 内的并发点击不会双重入队。
 *
 * 注意：闸门只保证互斥与去重，不提供超时。单个任务挂死会阻塞后续队列，
 * 依赖取链层自身的请求超时兜底（与修复前行为一致，不额外改变超时语义）。
 */
export class PlayGate {
  /** 当前占位的 key（从 enter() 调用起、到任务落定止） */
  private activeKey: string | null = null;
  /** 当前占位 key 对应的进行中任务 Promise（供同 key 请求复用） */
  private activePromise: Promise<unknown> | null = null;
  /** 串行链：永不定案为 rejected（错误在链上被吞掉，由任务自身 Promise 传给调用方） */
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * 进入闸门。
   * @param key  去重键（同 key 进行中 → 复用）
   * @param task 实际任务；仅在闸门放行时执行，同一时刻最多一个任务在跑
   * @returns reused=true 表示复用了进行中的同 key 任务；promise 为该次播放的最终结果
   */
  enter<T>(key: string, task: () => Promise<T>): { reused: boolean; promise: Promise<T> } {
    // 1. 同 key 去重：复用进行中的播放，不重复触发取链 / 播放
    if (this.activeKey === key && this.activePromise) {
      return { reused: true, promise: this.activePromise as Promise<T> };
    }

    // 2. 同步占位：防止同一 tick 内的并发点击双重入队
    this.activeKey = key;
    const run = this.chain.then(task) as Promise<T>;
    this.activePromise = run;

    // 3. 串行链上吞错：前一个任务失败不阻塞后续排队任务
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );

    // 4. 任务落定（成功/失败）释放占位；若期间已有新 key 接管则跳过，避免误清新任务的占位
    const release = () => {
      if (this.activeKey === key) {
        this.activeKey = null;
        this.activePromise = null;
      }
    };
    run.then(release, release);

    return { reused: false, promise: run };
  }

  /** 仅用于诊断 / 测试：当前是否有任务占用闸门 */
  isActive(): boolean {
    return this.activeKey !== null;
  }
}
