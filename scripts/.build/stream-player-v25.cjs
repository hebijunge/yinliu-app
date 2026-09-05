var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// <stdin>
var stdin_exports = {};
__export(stdin_exports, {
  streamingAudioPlayer: () => streamingAudioPlayer
});
module.exports = __toCommonJS(stdin_exports);

// stub:stub:@shared/utils/platformFetch
var g = globalThis.__streamTest = globalThis.__streamTest || {};
var net = g.net = g.net || { headDelayMs: 20, chunkDelaysMs: [30, 30], fileSize: 768 * 1024, log: [] };
function resp(status, headers, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
    arrayBuffer: async () => body
  };
}
async function platformFetch(url, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (method === "HEAD") {
    await new Promise((r) => setTimeout(r, net.headDelayMs));
    net.log.push({ method: "HEAD", t: Date.now() });
    return resp(200, { "content-length": String(net.fileSize), "accept-ranges": "bytes" }, new ArrayBuffer(0));
  }
  const range = options.headers && options.headers.Range || "bytes=0-";
  const m = /bytes=(\d+)-(\d+)/.exec(range);
  const start = m ? parseInt(m[1], 10) : 0;
  const endReq = m ? parseInt(m[2], 10) : net.fileSize - 1;
  const end = Math.min(endReq, net.fileSize - 1);
  const idx = net.log.filter((l) => l.method === "GET").length;
  const delay = net.chunkDelaysMs[Math.min(idx, net.chunkDelaysMs.length - 1)] ?? 30;
  await new Promise((r) => setTimeout(r, delay));
  net.log.push({ method: "GET", range, t: Date.now() });
  const len = end - start + 1;
  return resp(206, { "content-length": String(len) }, new ArrayBuffer(len));
}

// stub:stub:@shared/utils/debugLogger
var verbose = !!process.env.V25_DEBUG;
var mk = (tag) => (...args) => {
  if (verbose)
    console.log("[" + tag + "]", ...args.map((a) => typeof a === "object" ? JSON.stringify(a) : String(a)));
};
var debugLogger = { info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug") };

// src/core/streaming/fetcher.ts
var FIRST_CHUNK_SIZE = 256 * 1024;
var CHUNK_SIZE = 512 * 1024;
var StreamFetcher = class {
  url = "";
  headers = {};
  totalSize = 0;
  state = "idle";
  abortController = null;
  currentChunkIndex = 0;
  currentByteOffset = 0;
  overallReceived = 0;
  callbacks = {};
  // v29-A1: 会话代际 —— 每次 start()/reset() 递增。在途的 HEAD 预检完成后
  // 只有代际仍等于当前值才允许写 totalSize，防止上一首歌的陈旧 HEAD
  // 覆盖新会话刚学到的 totalSize（跨歌残留的另一个来源）
  session = 0;
  // v25: 并行 HEAD 预检 —— start() 不再串行等待，downloadLoop 在需要 totalSize
  // （首块之后的边界钳制）时才 await 该 Promise
  headPromise = null;
  // v25: 本轮 start() 是否真正需要 HEAD（skipHead 或 totalSize 已知时为 false）
  headPending = false;
  // seek 目标（用于中断后重新定位）
  seekTargetByte = -1;
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  getState() {
    return this.state;
  }
  getTotalSize() {
    return this.totalSize;
  }
  /**
   * 启动流式下载（非阻塞，后台执行）
   * @param url 音频文件 URL
   * @param headers 请求头（可能包含鉴权信息）
   * @param startByte 起始字节位置（默认 0）
   * @param options.skipHead 已知 totalSize 时跳过 HEAD 预检（seek 重启下载时省一次往返）
   */
  async start(url, headers = {}, startByte = 0, options = {}) {
    if (this.state === "fetching") {
      await this.stop();
    }
    const session = ++this.session;
    const keepTotalSize = options.skipHead && this.totalSize > 0 ? this.totalSize : 0;
    this.url = url;
    this.headers = headers;
    this.totalSize = keepTotalSize;
    this.currentByteOffset = startByte;
    this.currentChunkIndex = 0;
    this.overallReceived = 0;
    this.seekTargetByte = -1;
    this.headPromise = null;
    this.headPending = false;
    if (!keepTotalSize) {
      this.headPending = true;
      this.headPromise = this.probeHead(session);
    }
    this.state = "fetching";
    debugLogger.info("streaming", "StreamFetcher started", {
      url: url.slice(0, 80),
      startByte,
      totalSize: this.totalSize,
      headParallel: this.headPending
    });
    void this.downloadLoop();
  }
  /** v25: HEAD 预检（并行执行，失败静默——由响应学习 totalSize 兜底） */
  async probeHead(session) {
    try {
      const headResp = await platformFetch(this.url, {
        method: "HEAD",
        headers: this.headers,
        signal: AbortSignal.timeout(6e3)
      });
      if (session !== this.session)
        return;
      const contentLength = headResp.headers.get("content-length");
      if (contentLength) {
        this.totalSize = parseInt(contentLength, 10);
      }
      const acceptRanges = headResp.headers.get("accept-ranges");
      if (acceptRanges !== "bytes") {
        debugLogger.warn("streaming", "Server may not support Range requests", {
          acceptRanges,
          url: this.url.slice(0, 80)
        });
      }
    } catch (err) {
      debugLogger.warn("streaming", "HEAD request failed, proceeding without total size", {
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      if (session === this.session)
        this.headPending = false;
    }
  }
  /** 当前下载的 URL（seek 重启下载时复用） */
  getUrl() {
    return this.url;
  }
  /** 当前下载的请求头（seek 重启下载时复用） */
  getHeaders() {
    return this.headers;
  }
  /**
   * Seek 到指定字节位置
   * 会中断当前下载，从新的位置重新开始
   */
  async seek(bytePosition) {
    if (this.state !== "fetching")
      return;
    debugLogger.info("streaming", "StreamFetcher seek", {
      from: this.currentByteOffset,
      to: bytePosition
    });
    this.seekTargetByte = bytePosition;
    this.abortController?.abort();
  }
  /**
   * 暂停下载
   */
  pause() {
    if (this.state === "fetching") {
      this.state = "paused";
      this.abortController?.abort();
    }
  }
  /**
   * 恢复下载
   */
  async resume() {
    if (this.state === "paused") {
      this.state = "fetching";
      await this.downloadLoop();
    }
  }
  /**
   * 停止下载
   */
  async stop() {
    this.state = "idle";
    this.abortController?.abort();
    await new Promise((r) => setTimeout(r, 50));
  }
  /**
   * v29-A1: 彻底重置 —— 切歌/停止播放时调用。区别于 stop()（仅停下载循环、
   * 保留 url/headers/totalSize 供 seek 复用）：本方法清空全部会话状态并递增
   * 会话代际（作废在途 HEAD 的写入资格），确保上一首歌的元数据
   * （尤其 totalSize 与陈旧 HEAD）不会泄漏到下一首歌。
   */
  reset() {
    this.session++;
    this.state = "idle";
    this.abortController?.abort();
    this.abortController = null;
    this.url = "";
    this.headers = {};
    this.totalSize = 0;
    this.currentByteOffset = 0;
    this.currentChunkIndex = 0;
    this.overallReceived = 0;
    this.seekTargetByte = -1;
    this.headPromise = null;
    this.headPending = false;
  }
  // === 内部分块下载循环 ===
  async downloadLoop() {
    while (this.state === "fetching") {
      if (this.seekTargetByte >= 0) {
        this.currentByteOffset = this.seekTargetByte;
        this.seekTargetByte = -1;
        if (this.currentByteOffset < FIRST_CHUNK_SIZE) {
          this.currentChunkIndex = 0;
        } else {
          this.currentChunkIndex = 1 + Math.floor((this.currentByteOffset - FIRST_CHUNK_SIZE) / CHUNK_SIZE);
        }
      }
      if (this.headPending && this.currentChunkIndex > 0) {
        await this.headPromise;
      }
      const chunk = this.calcChunk(this.currentChunkIndex, this.currentByteOffset);
      try {
        await this.downloadChunk(chunk);
        this.currentChunkIndex++;
        this.currentByteOffset = chunk.end + 1;
        if (this.totalSize > 0 && this.currentByteOffset >= this.totalSize) {
          this.state = "completed";
          this.callbacks.onComplete?.();
          break;
        }
      } catch (err) {
        if (this.state === "fetching" && this.seekTargetByte < 0) {
          this.state = "error";
          const error = err instanceof Error ? err : new Error(String(err));
          debugLogger.error("streaming", "Download chunk failed", {
            chunk: chunk.index,
            error: error.message
          });
          this.callbacks.onError?.(error);
        }
        break;
      }
    }
  }
  calcChunk(index, preferredStart = -1) {
    let start;
    let size;
    if (index === 0) {
      start = preferredStart >= 0 ? preferredStart : 0;
      size = FIRST_CHUNK_SIZE;
    } else {
      start = preferredStart >= 0 ? preferredStart : FIRST_CHUNK_SIZE + (index - 1) * CHUNK_SIZE;
      size = CHUNK_SIZE;
    }
    let end = start + size - 1;
    if (this.totalSize > 0) {
      end = Math.min(end, this.totalSize - 1);
    }
    return {
      index,
      start,
      end,
      size: end - start + 1
    };
  }
  async downloadChunk(chunk) {
    this.abortController = new AbortController();
    const rangeHeader = `bytes=${chunk.start}-${chunk.end}`;
    debugLogger.info("streaming", `Downloading chunk ${chunk.index}: ${rangeHeader}`);
    this.callbacks.onChunkStart?.(chunk);
    const response = await platformFetch(this.url, {
      method: "GET",
      headers: {
        ...this.headers,
        Range: rangeHeader
      },
      signal: this.abortController.signal,
      responseType: "arraybuffer"
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    if (response.status === 206 && data.length < chunk.size) {
      this.totalSize = chunk.start + data.length;
      debugLogger.info("streaming", "Learned totalSize from short 206 response (tail)", {
        totalSize: this.totalSize
      });
    } else if (response.status === 200 && this.totalSize === 0) {
      this.totalSize = chunk.start + data.length;
      debugLogger.info("streaming", "Learned totalSize from full 200 response", {
        totalSize: this.totalSize
      });
    }
    let effectiveData = data;
    if (response.status === 200 && data.length > chunk.size) {
      effectiveData = data.subarray(chunk.start, chunk.end + 1);
    }
    this.overallReceived += effectiveData.length;
    this.callbacks.onChunkComplete?.(chunk, effectiveData);
    this.callbacks.onProgress?.({
      chunkIndex: chunk.index,
      bytesReceived: effectiveData.length,
      chunkTotal: chunk.size,
      overallBytesReceived: this.overallReceived,
      overallTotalBytes: this.totalSize
    });
  }
};
var streamFetcher = new StreamFetcher();

// stub:stub:./cache
var g2 = globalThis.__streamTest = globalThis.__streamTest || {};
var st = g2.cache = g2.cache || {
  data: /* @__PURE__ */ new Map(),
  calls: { appendData: 0, writeData: 0, readAsBlobUrl: 0, getOrCreateEntry: 0, markActive: 0, markInactive: 0 }
};
function entry(key, format) {
  if (!st.data.has(key)) {
    st.data.set(key, { key, format, filePath: key + "." + (format || "mp3"), totalSize: 0, downloadedRanges: [], expectedTotalSize: 0 });
  }
  return st.data.get(key);
}
var streamCacheEngine = {
  async init() {
  },
  async getOrCreateEntry(key, format) {
    st.calls.getOrCreateEntry++;
    return entry(key, format);
  },
  getEntry(key) {
    return st.data.get(key) || null;
  },
  markActive() {
    st.calls.markActive++;
  },
  markInactive() {
    st.calls.markInactive++;
  },
  isRangeDownloaded(key, s, e) {
    const en = st.data.get(key);
    if (!en)
      return false;
    return en.downloadedRanges.some((r) => r.start <= s && r.end >= e);
  },
  async appendData(key, data, offset) {
    st.calls.appendData++;
    const en = entry(key, "mp3");
    en.downloadedRanges.push({ start: offset, end: offset + data.length - 1 });
    en.totalSize = Math.max(en.totalSize, offset + data.length);
  },
  async writeData(key, data) {
    st.calls.writeData++;
    const en = entry(key, "mp3");
    en.totalSize = data.length;
    en.downloadedRanges = [{ start: 0, end: data.length - 1 }];
  },
  async readAsBlobUrl(key) {
    st.calls.readAsBlobUrl++;
    const en = st.data.get(key);
    if (!en || en.totalSize === 0)
      throw new Error("empty cache");
    return "blob:mock-" + key;
  },
  async readAsFileUrl(key) {
    return "file://mock-" + key;
  },
  async setExpectedTotalSize(key, size) {
    entry(key, "mp3").expectedTotalSize = size;
  }
};

// stub:stub:./mseDetector
function detectMSECapability() {
  return { isUsable: false, preferredMimeType: "" };
}

// stub:stub:@providers/music/QishuiCencDecryptor
var QishuiCencDecryptor = class {
};

// stub:stub:@shared/audio/crypto
async function fetchZ3dKey() {
  throw new Error("not used");
}
function createZ3dDecryptStream() {
  throw new Error("not used");
}

// stub:stub:@shared/utils/networkMonitor
function subscribeNetwork() {
  return () => {
  };
}
function isOnline() {
  return true;
}

// src/core/streaming/player.ts
var PRELOAD_THRESHOLD = 0.5;
var BUFFER_THRESHOLD = 0.85;
var MIN_CHUNKS_BEFORE_REFRESH = 2;
var BLOB_REFRESH_SIZE_THRESHOLD = 256 * 1024;
var StreamingAudioPlayer = class _StreamingAudioPlayer {
  audio = null;
  fetcher = new StreamFetcher();
  state = "idle";
  callbacks = {};
  // 数据缓冲
  chunks = [];
  totalDownloaded = 0;
  // v29-A2: 用户设定音量基准 —— 新建 audio 元素时统一应用，避免重建后音量跳变
  volume = 1;
  totalSize = 0;
  mimeType = "audio/mpeg";
  // 播放控制
  pendingSeekTime = -1;
  /** v23-fix: seek 前是否处于播放态（seek 数据到位后据此恢复播放/暂停） */
  seekResumePlay = false;
  lastReportedTime = 0;
  progressTimer = null;
  blobUrl = null;
  // MSE 相关
  mediaSource = null;
  sourceBuffer = null;
  useMSE = false;
  mseQueue = [];
  mseUpdating = false;
  // v28-fix: MSE 实际传给 addSourceBuffer 的 MIME（MP4 流需带 codecs 串）；
  // 空串表示本流不支持 MSE
  mseMimeType = "";
  // v28-fix: MSE 模式下 audio.duration 是已缓冲段时长（随 append 增长），
  // 用 totalSize/已下载数据估算全时长供进度条与 seek 换算；完成时由
  // endOfStream 校正后回落真实值
  mseEstimatedDuration = 0;
  // 缓存
  cacheKey = "";
  cacheEntry = null;
  /** v22-lru-fix: 本次播放会话标记为活跃的缓存 key（reset 时释放） */
  lastActiveCacheKey = "";
  // F7(v27 P2-2 + 外部报告 F3)：播放错误去重锁——同一播放错误从 play() 拦截路径
  // 与 audio error 事件路径重复上报时，同 key 短窗口内只报一次
  lastErrorReport = null;
  static ERROR_DEDUP_WINDOW_MS = 3e3;
  // 预取下一首
  prefetchFetcher = null;
  prefetchCallbacks;
  /** v22-lru-fix: 当前预取写入的缓存 key（预取结束/停止时释放活跃标记） */
  prefetchCacheKey = "";
  // Blob 刷新追踪
  lastRefreshDownloaded = 0;
  // P3 内存修复：chunks 是否被清空过。清空后内存合并数据必然不完整（有洞），
  // 后续刷新必须走缓存读路径，禁止用 0 填洞的内存数据覆盖缓存
  chunksCleared = false;
  // v18 EQ：audio 元素创建监听（均衡器挂接新元素用）
  audioElementListener = null;
  // v21.3: 加密流状态
  isEncryptedStream = false;
  encryptedStreamAbortController = null;
  // E5: 断网守卫 —— 断网暂停、恢复自动续播（进度保留）
  networkUnsubscribe = null;
  networkPaused = false;
  // v25: 起播抑制标记 —— 用户在首块下载完成前点了暂停时，由引擎调 suppressAutoStart()
  // 置位；首块就绪后不再自动起播（否则会覆盖用户暂停意图：音乐自己开始响，
  // 而 UI 停留在"播放"图标 → 状态与实际脱节）。显式调用 play() 时复位。
  startSuppressed = false;
  // === 公共接口 ===
  setCallbacks(callbacks) {
    this.callbacks = callbacks;
  }
  /**
   * v25: 抑制本次加载的自动起播（用户在首块就绪前点了暂停）。
   * 只影响"数据就绪后自动 play"这一次行为；显式 play()（用户恢复播放）会复位。
   */
  suppressAutoStart() {
    this.startSuppressed = true;
  }
  /** v18 EQ：监听 audio 元素创建/销毁（均衡器据此挂接） */
  setAudioElementListener(l) {
    this.audioElementListener = l;
  }
  /**
   * E5: 安装断网/恢复守卫（幂等，首次 load 时挂上）
   * ① 播放中断网 → 暂停并提示；② 恢复网络 → 保留进度自动续播；
   * ③ 自动续播失败 → 错误态（进度保留，由上层提供重试入口）。
   */
  ensureNetworkGuard() {
    if (this.networkUnsubscribe)
      return;
    this.networkUnsubscribe = subscribeNetwork((online) => {
      if (online) {
        void this.handleNetworkRestore();
      } else {
        this.handleNetworkLost();
      }
    });
  }
  /** E5: 断网 → 暂停并提示（仅播放/缓冲态介入，错误态与空闲态不动） */
  handleNetworkLost() {
    if (this.state !== "playing" && this.state !== "buffering")
      return;
    this.networkPaused = true;
    this.audio?.pause();
    this.setState("paused");
    this.stopProgressTracking();
    debugLogger.warn("streaming", "E5 network lost, playback paused", {
      at: this.audio?.currentTime ?? 0
    });
    this.callbacks.onError?.("\u7F51\u7EDC\u4E2D\u65AD\uFF0C\u5DF2\u6682\u505C\u64AD\u653E\uFF0C\u6062\u590D\u7F51\u7EDC\u540E\u5C06\u81EA\u52A8\u7EED\u64AD");
  }
  /** E5: 网络恢复 → 保留进度自动续播；失败则进入错误态并提示重试 */
  async handleNetworkRestore() {
    if (!this.networkPaused)
      return;
    this.networkPaused = false;
    const at = this.audio?.currentTime ?? 0;
    try {
      await this.audio?.play();
      this.setState("playing");
      this.startProgressTracking();
      debugLogger.info("streaming", "E5 network restored, auto-resumed", { at });
    } catch (err) {
      debugLogger.error("streaming", "E5 auto-resume failed", { at, err: String(err) });
      this.pendingSeekTime = at;
      this.setState("error");
      this.callbacks.onError?.("\u7F51\u7EDC\u6062\u590D\u540E\u91CD\u8FDE\u5931\u8D25\uFF0C\u64AD\u653E\u8FDB\u5EA6\u5DF2\u4FDD\u7559\uFF0C\u8BF7\u70B9\u51FB\u91CD\u8BD5");
    }
  }
  getAudioElement() {
    return this.audio;
  }
  getState() {
    return this.state;
  }
  getCurrentTime() {
    return this.audio?.currentTime ?? 0;
  }
  getDuration() {
    if (this.useMSE && this.mseEstimatedDuration > 0) {
      return this.mseEstimatedDuration;
    }
    return this.audio?.duration ?? 0;
  }
  /**
   * 加载并开始流式播放
   */
  async load(options) {
    await this.reset();
    this.ensureNetworkGuard();
    this.startSuppressed = options.autoStart === false;
    this.cacheKey = options.cacheKey;
    this.mimeType = this.inferMimeType(options.format);
    streamCacheEngine.markActive(this.cacheKey);
    this.lastActiveCacheKey = this.cacheKey;
    if (options.isEncrypted && options.decryptKey) {
      this.isEncryptedStream = true;
      this.useMSE = false;
      debugLogger.info("streaming", "StreamingAudioPlayer.load (encrypted)", {
        cacheKey: options.cacheKey,
        mimeType: this.mimeType
      });
      await streamCacheEngine.init();
      this.cacheEntry = await streamCacheEngine.getOrCreateEntry(
        options.cacheKey,
        options.format || "mp4"
      );
      if (this.cacheEntry.totalSize > 0 && this.isCacheComplete()) {
        debugLogger.info("streaming", "Playing encrypted stream from complete cache");
        await this.playFromCache();
        return;
      }
      await this.loadEncryptedStream(options);
      return;
    }
    if (options.z3dDecryptInfo) {
      this.isEncryptedStream = true;
      this.useMSE = false;
      debugLogger.info("streaming", "StreamingAudioPlayer.load (Z3D)", {
        cacheKey: options.cacheKey,
        mimeType: this.mimeType
      });
      await streamCacheEngine.init();
      this.cacheEntry = await streamCacheEngine.getOrCreateEntry(
        options.cacheKey,
        options.format || "wav"
      );
      if (this.cacheEntry.totalSize > 0 && this.isCacheComplete()) {
        debugLogger.info("streaming", "Playing Z3D stream from complete cache");
        await this.playFromCache();
        return;
      }
      await this.loadZ3dStream(options);
      return;
    }
    const mseCap = detectMSECapability();
    this.mseMimeType = "";
    if (mseCap.isUsable) {
      if (this.mimeType === "audio/mpeg" && mseCap.mp3Supported) {
        this.mseMimeType = "audio/mpeg";
      } else if (this.mimeType === "audio/mp4" && mseCap.mp4Supported && mseCap.preferredMimeType) {
        this.mseMimeType = mseCap.preferredMimeType;
      }
    }
    this.useMSE = this.mseMimeType !== "";
    debugLogger.info("streaming", "StreamingAudioPlayer.load", {
      cacheKey: options.cacheKey,
      useMSE: this.useMSE,
      mimeType: this.mimeType,
      mseMimeType: this.mseMimeType || null,
      mseCap: {
        mp3Supported: mseCap.mp3Supported,
        mp4Supported: mseCap.mp4Supported,
        preferred: mseCap.preferredMimeType
      }
    });
    await streamCacheEngine.init();
    this.cacheEntry = await streamCacheEngine.getOrCreateEntry(
      options.cacheKey,
      options.format || "mp3"
    );
    if (this.cacheEntry.totalSize > 0 && this.isCacheComplete()) {
      debugLogger.info("streaming", "Playing from complete cache");
      await this.playFromCache();
      return;
    }
    this.fetcher.setCallbacks(this.buildFetcherCallbacks());
    const resumeOffset = this.getResumeOffset();
    if (this.useMSE && resumeOffset > 0) {
      const prefixOk = await this.loadResumePrefixIntoMSE(resumeOffset);
      if (!prefixOk) {
        this.useMSE = false;
        this.mseMimeType = "";
        this.chunks = [];
        debugLogger.info("streaming", "MSE unavailable after prefix load failure, blob fallback", {
          cacheKey: options.cacheKey,
          resumeOffset
        });
        this.totalDownloaded += resumeOffset;
      }
    } else if (resumeOffset > 0) {
      this.totalDownloaded += resumeOffset;
    }
    this.setState("loading");
    if (!options.url) {
      throw new Error("StreamingAudioPlayer.load: url is required for fetch-based playback");
    }
    await this.fetcher.start(options.url, options.headers, resumeOffset);
  }
  /**
   * 加载已解密的完整音频数据并直接播放（用于 CENC 解密后场景）。
   * 不经过 fetcher，直接将数据写入缓存后播放。
   */
  async loadDecryptedData(data, options) {
    await this.reset();
    this.startSuppressed = options.autoStart === false;
    this.cacheKey = options.cacheKey;
    this.mimeType = this.inferMimeType(options.format);
    this.totalSize = data.length;
    this.totalDownloaded = data.length;
    streamCacheEngine.markActive(this.cacheKey);
    this.lastActiveCacheKey = this.cacheKey;
    await streamCacheEngine.init();
    this.cacheEntry = await streamCacheEngine.getOrCreateEntry(
      options.cacheKey,
      options.format || "mp3"
    );
    await streamCacheEngine.writeData(options.cacheKey, data);
    this.cacheEntry = streamCacheEngine.getEntry(options.cacheKey);
    this.setState("loading");
    await this.playFromCache();
  }
  /**
   * 播放（在 load 后调用，或从暂停恢复）
   */
  async play() {
    this.startSuppressed = false;
    this.networkPaused = false;
    if (!this.audio)
      return;
    try {
      await this.audio.play();
      this.setState("playing");
      this.startProgressTracking();
    } catch (err) {
      this.setState("paused");
      this.reportError("\u64AD\u653E\u5931\u8D25\uFF0C\u8BF7\u70B9\u51FB\u64AD\u653E\u6309\u94AE\u91CD\u8BD5");
    }
  }
  /**
   * F7(v27 P2-2 + 外部报告 F3)：播放错误去重上报。
   * 同一播放错误（同 cacheKey + 同文案）在短窗口内只向 callbacks.onError 报一次，
   * 拦截 play() catch 与 audio error 事件双路径的重复上报。
   */
  reportError(message) {
    const key = `${this.cacheKey}|${message}`;
    const now = Date.now();
    if (this.lastErrorReport && this.lastErrorReport.key === key && now - this.lastErrorReport.at < _StreamingAudioPlayer.ERROR_DEDUP_WINDOW_MS) {
      debugLogger.info("streaming", "\u91CD\u590D\u64AD\u653E\u9519\u8BEF\u5DF2\u53BB\u91CD\u62E6\u622A\uFF08\u77ED\u7A97\u53E3\u5185\u53EA\u62A5\u4E00\u6B21\uFF09", { key });
      return;
    }
    this.lastErrorReport = { key, at: now };
    this.callbacks.onError?.(message);
  }
  /**
   * 暂停
   */
  pause() {
    this.audio?.pause();
    this.setState("paused");
    this.stopProgressTracking();
  }
  /**
   * v21.3: 加载 CENC 加密流（fetch + decryptStream + Blob 刷新）
   */
  async loadEncryptedStream(options) {
    if (!options.decryptKey) {
      throw new Error("decryptKey is required for encrypted stream");
    }
    this.encryptedStreamAbortController = new AbortController();
    const response = await fetch(options.url, {
      method: "GET",
      headers: options.headers,
      signal: this.encryptedStreamAbortController.signal
    });
    if (!response.ok) {
      throw new Error(`Encrypted stream fetch failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error("Encrypted stream response has no body");
    }
    const decryptor = new QishuiCencDecryptor(options.decryptKey);
    const decryptedStream = await decryptor.decryptStream(response.body);
    const reader = decryptedStream.getReader();
    this.setState("loading");
    let resolveFirstChunk;
    let rejectFirstChunk;
    let firstChunkSettled = false;
    const firstChunkReady = new Promise((resolve, reject) => {
      resolveFirstChunk = () => {
        if (!firstChunkSettled) {
          firstChunkSettled = true;
          resolve();
        }
      };
      rejectFirstChunk = (err) => {
        if (!firstChunkSettled) {
          firstChunkSettled = true;
          reject(err);
        }
      };
    });
    const MIN_START_SIZE = 256 * 1024;
    void (async () => {
      let totalReceived = 0;
      let chunkIndex = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done)
            break;
          const start = totalReceived;
          const end = start + value.length - 1;
          this.chunks.push({ data: value, start, end });
          totalReceived += value.length;
          this.totalDownloaded = totalReceived;
          await streamCacheEngine.appendData(this.cacheKey, value, start);
          if (this.state === "loading" && totalReceived >= MIN_START_SIZE) {
            debugLogger.info("streaming", "Encrypted stream first chunk ready", {
              cacheKey: this.cacheKey,
              received: totalReceived
            });
            await this.onFirstChunkReady();
            resolveFirstChunk();
          }
          if (chunkIndex > 0 && !this.useMSE) {
            const shouldRefreshBySize = this.totalDownloaded - this.lastRefreshDownloaded >= BLOB_REFRESH_SIZE_THRESHOLD;
            if (shouldRefreshBySize) {
              await this.setupBlobPlayback();
              this.lastRefreshDownloaded = this.totalDownloaded;
            }
          }
          chunkIndex++;
        }
        if (this.state === "loading") {
          await this.onFirstChunkReady();
          resolveFirstChunk();
        } else if (!this.useMSE && (this.chunks.length > 0 || this.chunksCleared)) {
          debugLogger.info("streaming", "Encrypted stream completed, final blob refresh");
          await this.setupBlobPlayback();
        }
        this.totalSize = totalReceived;
        if (this.cacheKey && this.totalSize > 0) {
          await streamCacheEngine.setExpectedTotalSize(this.cacheKey, this.totalSize);
        }
      } catch (err) {
        if (this.encryptedStreamAbortController?.signal.aborted) {
          resolveFirstChunk();
          return;
        }
        this.setState("error");
        this.callbacks.onError?.(err instanceof Error ? err.message : "Encrypted stream failed");
        rejectFirstChunk(err instanceof Error ? err : new Error(String(err)));
      } finally {
        reader.releaseLock();
        this.encryptedStreamAbortController = null;
      }
    })();
    await firstChunkReady;
  }
  /**
   * v21.4: 加载咪咕 Z3D 加密流（fetch + Z3D decryptStream + Blob 刷新）
   * P2: 大文件内存控制——起播后定期清空内存 chunks，数据已落地缓存
   */
  async loadZ3dStream(options) {
    if (!options.z3dDecryptInfo) {
      throw new Error("z3dDecryptInfo is required for Z3D stream");
    }
    this.encryptedStreamAbortController = new AbortController();
    debugLogger.info("streaming", "Z3D: extracting key via known-plaintext attack");
    let key;
    try {
      key = await fetchZ3dKey(
        options.z3dDecryptInfo.z3dUrl,
        options.z3dDecryptInfo.p3dUrl,
        options.headers
      );
      debugLogger.info("streaming", "Z3D: key extracted successfully");
    } catch (keyErr) {
      this.setState("error");
      this.callbacks.onError?.(
        `Z3D \u5BC6\u94A5\u63D0\u53D6\u5931\u8D25: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`
      );
      throw keyErr;
    }
    const decryptStream = createZ3dDecryptStream(key);
    const response = await fetch(options.z3dDecryptInfo.z3dUrl, {
      method: "GET",
      headers: options.headers,
      signal: this.encryptedStreamAbortController.signal
    });
    if (!response.ok) {
      throw new Error(`Z3D stream fetch failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
      throw new Error("Z3D stream response has no body");
    }
    const decryptedStream = response.body.pipeThrough(decryptStream);
    const reader = decryptedStream.getReader();
    this.setState("loading");
    let resolveFirstChunk;
    let rejectFirstChunk;
    let firstChunkSettled = false;
    const firstChunkReady = new Promise((resolve, reject) => {
      resolveFirstChunk = () => {
        if (!firstChunkSettled) {
          firstChunkSettled = true;
          resolve();
        }
      };
      rejectFirstChunk = (err) => {
        if (!firstChunkSettled) {
          firstChunkSettled = true;
          reject(err);
        }
      };
    });
    const MIN_START_SIZE = 256 * 1024;
    void (async () => {
      let totalReceived = 0;
      let chunkIndex = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done)
            break;
          const start = totalReceived;
          const end = start + value.length - 1;
          this.chunks.push({ data: value, start, end });
          totalReceived += value.length;
          this.totalDownloaded = totalReceived;
          await streamCacheEngine.appendData(this.cacheKey, value, start);
          if (this.state === "loading" && totalReceived >= MIN_START_SIZE) {
            debugLogger.info("streaming", "Z3D stream first chunk ready", {
              cacheKey: this.cacheKey,
              received: totalReceived
            });
            await this.onFirstChunkReady();
            resolveFirstChunk();
            this.chunks = [];
            debugLogger.info("streaming", "Z3D: cleared in-memory chunks after first playback", {
              cacheKey: this.cacheKey
            });
          }
          if (chunkIndex > 0 && !this.useMSE) {
            const shouldRefreshBySize = this.totalDownloaded - this.lastRefreshDownloaded >= BLOB_REFRESH_SIZE_THRESHOLD;
            if (shouldRefreshBySize) {
              await this.setupBlobPlayback();
              this.lastRefreshDownloaded = this.totalDownloaded;
              this.chunks = [];
              debugLogger.info("streaming", "Z3D: cleared in-memory chunks after blob refresh", {
                cacheKey: this.cacheKey,
                totalDownloaded: this.totalDownloaded
              });
            }
          }
          chunkIndex++;
        }
        if (this.state === "loading") {
          await this.onFirstChunkReady();
          resolveFirstChunk();
          this.chunks = [];
        } else if (!this.useMSE && (this.chunks.length > 0 || this.chunksCleared)) {
          debugLogger.info("streaming", "Z3D stream completed, final blob refresh");
          await this.setupBlobPlayback();
          this.chunks = [];
        }
        this.totalSize = totalReceived;
        if (this.cacheKey && this.totalSize > 0) {
          await streamCacheEngine.setExpectedTotalSize(this.cacheKey, this.totalSize);
        }
      } catch (err) {
        if (this.encryptedStreamAbortController?.signal.aborted) {
          resolveFirstChunk();
          return;
        }
        this.setState("error");
        this.callbacks.onError?.(err instanceof Error ? err.message : "Z3D stream failed");
        rejectFirstChunk(err instanceof Error ? err : new Error(String(err)));
      } finally {
        reader.releaseLock();
        this.encryptedStreamAbortController = null;
      }
    })();
    await firstChunkReady;
  }
  /**
   * Seek 到指定时间（秒）
   * v23-fix: 修复 seek 到未缓存位置不生效的回弹问题：
   * 1. 元数据缺失（totalSize/duration 未知）时直接交给浏览器 seek，不再静默 return
   * 2. 未缓存位置重启下载后，由 onChunkComplete 消费 pendingSeekTime 回填播放位置
   */
  async seek(time) {
    if (!this.audio)
      return;
    const duration = this.useMSE && this.mseEstimatedDuration > 0 ? this.mseEstimatedDuration : this.audio.duration || 0;
    const clampedTime = duration > 0 ? Math.max(0, Math.min(time, duration)) : Math.max(0, time);
    if (this.isEncryptedStream) {
      this.audio.currentTime = clampedTime;
      return;
    }
    if (this.totalSize === 0 || duration <= 0) {
      try {
        this.audio.currentTime = clampedTime;
      } catch {
      }
      return;
    }
    const bytePosition = Math.floor(clampedTime / duration * this.totalSize);
    debugLogger.info("streaming", "Seek requested", {
      time: clampedTime,
      bytePosition,
      totalSize: this.totalSize
    });
    if (streamCacheEngine.isRangeDownloaded(this.cacheKey, bytePosition, bytePosition + 1)) {
      this.audio.currentTime = clampedTime;
      return;
    }
    if (this.useMSE && !this.sourceBuffer) {
      debugLogger.info("streaming", "Seek while MSE session not ready, defer to browser", {
        cacheKey: this.cacheKey,
        time: clampedTime,
        bytePosition
      });
      try {
        this.audio.currentTime = clampedTime;
      } catch {
      }
      return;
    }
    const wasPlaying = this.state === "playing";
    this.setState("seeking");
    this.pendingSeekTime = clampedTime;
    this.seekResumePlay = wasPlaying;
    await this.fetcher.stop();
    this.chunks = [];
    this.chunksCleared = true;
    const url = this.fetcher.getUrl();
    const headers = this.fetcher.getHeaders();
    await this.fetcher.start(url, headers, bytePosition, { skipHead: true });
  }
  /**
   * 设置音量
   * v29-A2: 持久化音量基准 —— 新建的 audio 元素（首块起播 / blob 刷新重建）
   * 统一应用最近一次用户设定音量；旧实现只写当前 audio，元素重建后音量
   * 回落到默认 1.0，表现为切歌/刷新瞬间音量跳变
   */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.audio) {
      this.audio.volume = this.volume;
    }
  }
  /**
   * 预取下一首的首块数据
   */
  async prefetchNext(options) {
    if (this.prefetchFetcher) {
      await this.prefetchFetcher.stop();
      this.prefetchFetcher = null;
      if (this.prefetchCacheKey) {
        streamCacheEngine.markInactive(this.prefetchCacheKey);
        this.prefetchCacheKey = "";
      }
    }
    this.prefetchFetcher = new StreamFetcher();
    let chunkReceived = false;
    this.prefetchFetcher.setCallbacks({
      onChunkComplete: async (chunk, data) => {
        if (chunk.index === 0 && !chunkReceived) {
          chunkReceived = true;
          await streamCacheEngine.appendData(options.cacheKey, data, chunk.start);
          debugLogger.info("streaming", "Prefetched next track first chunk", {
            cacheKey: options.cacheKey,
            size: data.length
          });
          await this.prefetchFetcher?.stop();
          streamCacheEngine.markInactive(options.cacheKey);
          if (this.prefetchCacheKey === options.cacheKey) {
            this.prefetchCacheKey = "";
          }
        }
      }
    });
    if (!options.url) {
      debugLogger.warn("streaming", "prefetchNext: url is required");
      return;
    }
    this.prefetchCacheKey = options.cacheKey;
    streamCacheEngine.markActive(options.cacheKey);
    try {
      await this.prefetchFetcher.start(options.url, options.headers, 0);
    } catch (err) {
      streamCacheEngine.markInactive(options.cacheKey);
      if (this.prefetchCacheKey === options.cacheKey) {
        this.prefetchCacheKey = "";
      }
      throw err;
    }
  }
  /**
   * 停止并清理所有资源
   */
  async reset() {
    this.stopProgressTracking();
    this.networkPaused = false;
    await this.fetcher.stop();
    this.fetcher.reset();
    if (this.encryptedStreamAbortController) {
      this.encryptedStreamAbortController.abort();
      this.encryptedStreamAbortController = null;
    }
    if (this.prefetchFetcher) {
      await this.prefetchFetcher.stop();
      this.prefetchFetcher = null;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      try {
        this.audio.load();
      } catch {
      }
      this.audio = null;
    }
    this.audioElementListener?.(null);
    if (this.mediaSource) {
      const ms = this.mediaSource;
      try {
        if (ms.readyState === "open") {
          if (this.sourceBuffer) {
            try {
              this.sourceBuffer.abort();
            } catch {
            }
            try {
              ms.removeSourceBuffer(this.sourceBuffer);
            } catch {
            }
          }
          ms.endOfStream();
        }
      } catch {
      }
      this.sourceBuffer = null;
      this.mediaSource = null;
    }
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    this.chunks = [];
    this.totalDownloaded = 0;
    this.totalSize = 0;
    this.pendingSeekTime = -1;
    this.seekResumePlay = false;
    this.mseQueue = [];
    this.mseUpdating = false;
    this.mseMimeType = "";
    this.mseEstimatedDuration = 0;
    if (this.lastActiveCacheKey) {
      streamCacheEngine.markInactive(this.lastActiveCacheKey);
      this.lastActiveCacheKey = "";
    }
    if (this.prefetchCacheKey) {
      streamCacheEngine.markInactive(this.prefetchCacheKey);
      this.prefetchCacheKey = "";
    }
    this.cacheKey = "";
    this.cacheEntry = null;
    this.lastRefreshDownloaded = 0;
    this.chunksCleared = false;
    this.isEncryptedStream = false;
    this.encryptedStreamAbortController = null;
    this.startSuppressed = false;
    this.setState("idle");
  }
  // === 内部播放逻辑 ===
  /**
   * 从完整缓存直接播放
   * v21.2 修复：增加缓存完整性校验，防止播放不完整/损坏的缓存文件
   */
  async playFromCache() {
    let url;
    let blobSize = 0;
    try {
      url = await streamCacheEngine.readAsBlobUrl(this.cacheKey);
      const entry2 = streamCacheEngine.getEntry(this.cacheKey);
      if (entry2?.expectedTotalSize && entry2.expectedTotalSize > 0) {
        blobSize = entry2.totalSize;
        if (blobSize !== entry2.expectedTotalSize) {
          throw new Error(
            `Cache size mismatch: actual=${blobSize}, expected=${entry2.expectedTotalSize}`
          );
        }
      }
      debugLogger.info("streaming", "Playing from complete cache (blob URL)", {
        cacheKey: this.cacheKey,
        blobSize,
        expectedSize: entry2?.expectedTotalSize
      });
    } catch (err) {
      debugLogger.warn("streaming", "Blob URL cache failed, trying file URL fallback", {
        cacheKey: this.cacheKey,
        error: err instanceof Error ? err.message : String(err)
      });
      url = await streamCacheEngine.readAsFileUrl(this.cacheKey);
      debugLogger.info("streaming", "Playing from complete cache (file URL fallback)", {
        cacheKey: this.cacheKey
      });
    }
    if (this.blobUrl && this.blobUrl !== url) {
      URL.revokeObjectURL(this.blobUrl);
    }
    this.blobUrl = url;
    await this.setupAudioWithReadyWait(url);
    if (this.audio?.error) {
      const errCode = this.audio.error.code;
      const errMsg = this.audio.error.message || "unknown";
      throw new Error(`Audio element entered error state during cache playback: code=${errCode}, msg=${errMsg}`);
    }
    if (this.startSuppressed) {
      debugLogger.info("streaming", "Cache playback ready but start suppressed (user paused)", {
        cacheKey: this.cacheKey
      });
      this.setState("paused");
      return;
    }
    this.setState("ready");
    await this.play();
  }
  /**
   * 首块下载完成，开始播放
   */
  async onFirstChunkReady() {
    if (this.useMSE) {
      await this.setupMSE();
    } else {
      await this.setupBlobPlayback();
    }
    if (this.startSuppressed) {
      debugLogger.info("streaming", "First chunk ready but start suppressed (user paused)", {
        cacheKey: this.cacheKey
      });
      this.setState("paused");
      return;
    }
    this.setState("ready");
    this.callbacks.onCanPlay?.();
    await this.play();
  }
  /**
   * Blob 刷新模式：创建/刷新 audio.src
   * v14.5 修复：增加就绪等待 + 本地文件 URI 优先，解决首块竞态问题
   * v21.2 修复：size mismatch 时用实际 mergeChunks 数据建 blob，避免 totalSize 截断
   */
  async setupBlobPlayback() {
    const shouldResume = this.state === "playing" || this.state === "buffering" || this.pendingSeekTime >= 0 && this.seekResumePlay;
    const allData = this.mergeChunks();
    if (this.chunksCleared || !allData || allData.length === 0) {
      try {
        const newUrl2 = await streamCacheEngine.readAsBlobUrl(this.cacheKey);
        const currentTime2 = this.pendingSeekTime >= 0 ? this.pendingSeekTime : this.audio?.currentTime ?? 0;
        if (this.pendingSeekTime >= 0) {
          this.pendingSeekTime = -1;
        }
        if (this.blobUrl) {
          URL.revokeObjectURL(this.blobUrl);
        }
        this.blobUrl = newUrl2;
        if (!this.audio) {
          await this.setupAudioWithReadyWait(newUrl2);
        } else {
          this.audio.src = newUrl2;
          if (currentTime2 > 0) {
            this.audio.currentTime = currentTime2;
          }
          if (shouldResume) {
            try {
              await this.audio.play();
            } catch {
            }
          }
        }
        debugLogger.info("streaming", "Blob refresh from cache (chunks cleared)", {
          cacheKey: this.cacheKey
        });
        this.chunks = [];
        this.chunksCleared = true;
        return;
      } catch (cacheErr) {
        debugLogger.warn("streaming", "setupBlobPlayback: chunks empty and cache read failed", {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr)
        });
        return;
      }
    }
    const hasSizeMismatch = this.totalSize > 0 && allData.length > this.totalSize;
    if (hasSizeMismatch) {
      debugLogger.warn("streaming", "setupBlobPlayback: size mismatch", {
        mergedSize: allData.length,
        expectedSize: this.totalSize
      });
    }
    const cacheEntry = streamCacheEngine.getEntry(this.cacheKey);
    const cacheAlreadyMatches = !!cacheEntry && cacheEntry.totalSize === allData.length;
    if (!cacheAlreadyMatches) {
      await streamCacheEngine.writeData(this.cacheKey, allData);
      const entry2 = streamCacheEngine.getEntry(this.cacheKey);
      if (!entry2 || entry2.totalSize !== allData.length) {
        debugLogger.error("streaming", "setupBlobPlayback: cache write verification failed", {
          cacheTotalSize: entry2?.totalSize,
          mergedSize: allData.length
        });
      }
    }
    let newUrl;
    if (hasSizeMismatch) {
      const blob = new Blob([allData], { type: this.mimeType });
      newUrl = URL.createObjectURL(blob);
      debugLogger.info("streaming", "Using memory blob (size mismatch)", {
        cacheKey: this.cacheKey,
        mergedSize: allData.length,
        expectedSize: this.totalSize
      });
    } else {
      try {
        newUrl = await streamCacheEngine.readAsBlobUrl(this.cacheKey);
        debugLogger.info("streaming", "Using blob URL for playback", {
          cacheKey: this.cacheKey
        });
      } catch {
        try {
          newUrl = await streamCacheEngine.readAsFileUrl(this.cacheKey);
          debugLogger.info("streaming", "Using file URL for playback (blob fallback)", {
            cacheKey: this.cacheKey
          });
        } catch {
          const blob = new Blob([allData], { type: this.mimeType });
          newUrl = URL.createObjectURL(blob);
          debugLogger.info("streaming", "Using blob URL for playback (cache read unavailable)", {
            cacheKey: this.cacheKey
          });
        }
      }
    }
    const currentTime = this.pendingSeekTime >= 0 ? this.pendingSeekTime : this.audio?.currentTime ?? 0;
    const hadPendingSeek = this.pendingSeekTime >= 0;
    if (hadPendingSeek) {
      this.pendingSeekTime = -1;
    }
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
    }
    this.blobUrl = newUrl;
    if (!this.audio) {
      debugLogger.info("streaming", "First chunk: waiting for audio ready");
      await this.setupAudioWithReadyWait(newUrl);
      debugLogger.info("streaming", "First chunk: audio ready");
    } else {
      this.audio.src = newUrl;
      if (currentTime > 0) {
        this.audio.currentTime = currentTime;
      }
      if (shouldResume) {
        try {
          await this.audio.play();
        } catch {
        }
      }
    }
    this.chunks = [];
    this.chunksCleared = true;
  }
  /**
   * v28-fix: MSE 断点续播——把缓存前缀（0..resumeOffset-1）读入 SourceBuffer 预挂载队列。
   * 原生平台 readAsBlobUrl 返回 zero-copy file URL，用 fetch 读回字节后整体作为一个
   * chunk 暂存，由 setupMSE 的 sourceopen 回调统一 append。任何失败返回 false，
   * 由调用方降级 Blob 模式。
   */
  async loadResumePrefixIntoMSE(resumeOffset) {
    try {
      const MAX_MSE_PREFIX_BYTES = 32 * 1024 * 1024;
      if (resumeOffset > MAX_MSE_PREFIX_BYTES) {
        debugLogger.info("streaming", "MSE resume: prefix too large, blob fallback", {
          cacheKey: this.cacheKey,
          resumeOffset
        });
        return false;
      }
      const url = await streamCacheEngine.readAsBlobUrl(this.cacheKey);
      const resp2 = await fetch(url);
      if (!resp2.ok) {
        throw new Error(`prefix fetch failed: ${resp2.status}`);
      }
      const buf = new Uint8Array(await resp2.arrayBuffer());
      if (buf.length < resumeOffset) {
        throw new Error(`prefix short: file=${buf.length}, expected=${resumeOffset}`);
      }
      const prefix = buf.length === resumeOffset ? buf : buf.subarray(0, resumeOffset);
      this.chunks.push({ data: prefix, start: 0, end: resumeOffset - 1 });
      this.totalDownloaded += resumeOffset;
      debugLogger.info("streaming", "MSE resume: cached prefix staged for SourceBuffer", {
        cacheKey: this.cacheKey,
        bytes: resumeOffset
      });
      return true;
    } catch (err) {
      debugLogger.warn("streaming", "MSE resume: cached prefix load failed", {
        cacheKey: this.cacheKey,
        resumeOffset,
        error: err instanceof Error ? err.message : String(err)
      });
      return false;
    }
  }
  /**
   * v28-fix: 估算 MSE 全时长。
   * SourceBuffer 模式下 audio.duration 是已缓冲段时长（随 append 增长），
   * 用 totalSize / 已下载体量 比例外推全时长，仅供进度条与 seek 字节换算；
   * 下载完成 endOfStream 后由 getDuration 回落真实 duration。
   * 必须在 SourceBuffer 空闲时设置（updateend 回调内调用）。
   */
  applyMSEDurationEstimate() {
    if (!this.useMSE || !this.mediaSource || this.mediaSource.readyState !== "open")
      return;
    if (this.mseEstimatedDuration > 0 || this.totalSize <= 0)
      return;
    if (this.mseUpdating || this.sourceBuffer && this.sourceBuffer.updating)
      return;
    const bufferedDur = this.audio?.duration ?? 0;
    if (!(bufferedDur > 0) || this.totalDownloaded <= 0)
      return;
    const estimated = bufferedDur * (this.totalSize / this.totalDownloaded);
    if (estimated > bufferedDur) {
      try {
        this.mediaSource.duration = estimated;
        this.mseEstimatedDuration = estimated;
        debugLogger.info("streaming", "MSE duration estimated", {
          bufferedDur,
          downloaded: this.totalDownloaded,
          totalSize: this.totalSize,
          estimated
        });
      } catch {
      }
    }
  }
  /**
   * MSE 模式：设置 MediaSource
   */
  async setupMSE() {
    return new Promise((resolve, reject) => {
      try {
        this.mediaSource = new MediaSource();
        const url = URL.createObjectURL(this.mediaSource);
        this.blobUrl = url;
        this.mediaSource.addEventListener("sourceopen", () => {
          if (!this.mediaSource)
            return;
          try {
            this.sourceBuffer = this.mediaSource.addSourceBuffer(this.mseMimeType || this.mimeType);
            this.sourceBuffer.mode = "segments";
            this.sourceBuffer.addEventListener("updateend", () => {
              this.mseUpdating = false;
              this.flushMSEQueue();
              this.applyMSEDurationEstimate();
            });
            this.sourceBuffer.addEventListener("error", (e) => {
              debugLogger.error("streaming", "SourceBuffer error", { error: String(e) });
            });
            for (const chunk of this.chunks) {
              this.appendToMSE(chunk.data);
            }
            this.setupAudio(url);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
        this.mediaSource.addEventListener("error", (e) => {
          reject(new Error(`MediaSource error: ${String(e)}`));
        });
        setTimeout(() => {
          if (!this.sourceBuffer) {
            reject(new Error("MediaSource sourceopen timeout"));
          }
        }, 5e3);
      } catch (err) {
        reject(err);
      }
    });
  }
  /**
   * 追加数据到 MSE SourceBuffer
   */
  appendToMSE(data) {
    if (!this.sourceBuffer || !this.mediaSource)
      return;
    if (this.mseUpdating) {
      this.mseQueue.push(data);
      return;
    }
    try {
      this.mseUpdating = true;
      this.sourceBuffer.appendBuffer(data);
    } catch (err) {
      this.mseUpdating = false;
      debugLogger.error("streaming", "appendBuffer failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  flushMSEQueue() {
    if (this.mseQueue.length > 0 && !this.mseUpdating) {
      const data = this.mseQueue.shift();
      this.appendToMSE(data);
    }
  }
  /**
   * 设置 HTMLAudioElement（带就绪等待）
   * v14.5 修复：首块播放时等待 canplay/loadedmetadata 事件，避免 Blob/文件竞态
   */
  setupAudioWithReadyWait(url) {
    return new Promise((resolve) => {
      if (this.audio) {
        this.audio.pause();
        this.audio.src = "";
      }
      this.audio = new Audio(url);
      this.audio.crossOrigin = "anonymous";
      this.audio.volume = this.volume;
      this.audioElementListener?.(this.audio);
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          debugLogger.warn("streaming", "Audio ready wait timeout (3s), proceeding anyway", {
            src: url.slice(0, 80)
          });
          doResolve();
        }
      }, 3e3);
      const doResolve = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          resolve();
        }
      };
      const onReady = () => {
        debugLogger.info("streaming", "Audio ready event fired", {
          event: "canplay/loadedmetadata",
          src: url.slice(0, 80)
        });
        doResolve();
      };
      this.audio.addEventListener("canplay", onReady, { once: true });
      this.audio.addEventListener("loadedmetadata", onReady, { once: true });
      this.audio.addEventListener("canplay", () => {
        if (this.state === "loading" || this.state === "buffering") {
          this.setState("playing");
        }
      });
      this.audio.addEventListener("ended", () => {
        if (this.totalSize > 0 && this.totalDownloaded < this.totalSize && this.state !== "idle") {
          debugLogger.warn("streaming", "Reached buffered end while still downloading", {
            cacheKey: this.cacheKey,
            currentTime: this.audio?.currentTime ?? 0,
            downloaded: this.totalDownloaded,
            totalSize: this.totalSize
          });
          this.setState("buffering");
          return;
        }
        this.stopProgressTracking();
        this.setState("completed");
        this.callbacks.onEnded?.();
      });
      this.audio.addEventListener("error", (e) => {
        const errCode = this.audio?.error?.code;
        const errMsg = this.audio?.error?.message || String(e);
        debugLogger.error("streaming", "Audio element error", {
          code: errCode,
          message: errMsg,
          src: url.slice(0, 80),
          state: this.state
        });
        this.stopProgressTracking();
        if (!isOnline() && (this.state === "playing" || this.state === "buffering")) {
          this.handleNetworkLost();
          doResolve();
          return;
        }
        this.setState("error");
        this.reportError("\u97F3\u9891\u64AD\u653E\u5931\u8D25");
        doResolve();
      });
      this.audio.addEventListener("waiting", () => {
        if (this.state === "playing") {
          this.setState("buffering");
        }
      });
      this.audio.addEventListener("playing", () => {
        if (this.state === "buffering" || this.state === "loading") {
          this.setState("playing");
        }
      });
      this.audio.addEventListener("pause", () => {
        if (this.state === "playing") {
          this.setState("paused");
        }
      });
    });
  }
  /**
   * 设置 HTMLAudioElement（不带就绪等待，用于刷新src时）
   */
  setupAudio(url) {
    if (this.audio) {
      this.audio.pause();
      this.audio.src = "";
    }
    this.audio = new Audio(url);
    this.audio.crossOrigin = "anonymous";
    this.audio.volume = this.volume;
    this.audioElementListener?.(this.audio);
    this.audio.addEventListener("canplay", () => {
      if (this.state === "loading" || this.state === "buffering") {
        this.setState("playing");
      }
    });
    this.audio.addEventListener("ended", () => {
      if (this.totalSize > 0 && this.totalDownloaded < this.totalSize && this.state !== "idle") {
        debugLogger.warn("streaming", "Reached buffered end while still downloading (refresh)", {
          cacheKey: this.cacheKey,
          currentTime: this.audio?.currentTime ?? 0,
          downloaded: this.totalDownloaded,
          totalSize: this.totalSize
        });
        this.setState("buffering");
        return;
      }
      this.stopProgressTracking();
      this.setState("completed");
      this.callbacks.onEnded?.();
    });
    this.audio.addEventListener("error", (e) => {
      const errCode = this.audio?.error?.code;
      const errMsg = this.audio?.error?.message || String(e);
      debugLogger.error("streaming", "Audio element error (refresh path)", {
        code: errCode,
        message: errMsg,
        src: url.slice(0, 80)
      });
      this.stopProgressTracking();
      if (!isOnline() && (this.state === "playing" || this.state === "buffering")) {
        this.handleNetworkLost();
        return;
      }
      this.setState("error");
      this.reportError("\u97F3\u9891\u64AD\u653E\u5931\u8D25");
    });
    this.audio.addEventListener("waiting", () => {
      if (this.state === "playing") {
        this.setState("buffering");
      }
    });
    this.audio.addEventListener("playing", () => {
      if (this.state === "buffering" || this.state === "loading") {
        this.setState("playing");
      }
    });
    this.audio.addEventListener("pause", () => {
      if (this.state === "playing") {
        this.setState("paused");
      }
    });
  }
  // === Fetcher 回调构建 ===
  buildFetcherCallbacks() {
    return {
      onChunkComplete: async (chunk, data) => {
        const mseActive = this.useMSE && !!this.sourceBuffer;
        if (!mseActive) {
          this.chunks.push({ data, start: chunk.start, end: chunk.end });
        }
        this.totalDownloaded += data.length;
        if (chunk.end + 1 > this.totalSize) {
          this.totalSize = chunk.end + 1;
        }
        await streamCacheEngine.appendData(this.cacheKey, data, chunk.start);
        if (this.state === "seeking" && this.pendingSeekTime >= 0) {
          if (mseActive) {
            const seekTarget = this.pendingSeekTime;
            this.pendingSeekTime = -1;
            this.appendToMSE(data);
            try {
              this.audio.currentTime = seekTarget;
            } catch {
            }
            if (this.seekResumePlay) {
              this.setState("playing");
              void this.audio?.play().catch(() => {
              });
            } else {
              this.setState("paused");
            }
            return;
          }
          debugLogger.info("streaming", "Seek target data ready, applying pending seek", {
            pendingSeekTime: this.pendingSeekTime,
            chunkStart: chunk.start
          });
          await this.setupBlobPlayback();
          if (this.pendingSeekTime >= 0) {
            try {
              this.audio.currentTime = this.pendingSeekTime;
            } catch {
            }
            this.pendingSeekTime = -1;
          }
          if (this.seekResumePlay) {
            this.setState("playing");
            void this.audio?.play().catch(() => {
            });
          } else {
            this.setState("paused");
          }
          return;
        }
        if (chunk.index === 0 && this.state === "loading") {
          debugLogger.info("streaming", "First chunk ready, starting playback", {
            size: data.length
          });
          await this.onFirstChunkReady();
          return;
        }
        if (this.useMSE && this.sourceBuffer) {
          this.appendToMSE(data);
          if (this.state === "buffering" && this.audio?.paused) {
            this.audio.play().catch(() => {
            });
          }
          return;
        }
        if (!this.useMSE && chunk.index > 0) {
          const nearBufferedEnd = this.shouldRefreshBlob();
          const shouldRefreshByInterval = chunk.index % MIN_CHUNKS_BEFORE_REFRESH === 0;
          const shouldRefreshBySize = this.totalDownloaded - this.lastRefreshDownloaded >= BLOB_REFRESH_SIZE_THRESHOLD;
          if (nearBufferedEnd && (shouldRefreshByInterval || shouldRefreshBySize)) {
            await this.setupBlobPlayback();
            this.lastRefreshDownloaded = this.totalDownloaded;
          }
        }
      },
      onProgress: (progress) => {
        if (progress.overallTotalBytes > this.totalSize) {
          this.totalSize = progress.overallTotalBytes;
          if (this.cacheKey && this.totalSize > 0) {
            streamCacheEngine.setExpectedTotalSize(this.cacheKey, this.totalSize).catch(() => {
            });
          }
        }
      },
      onError: (error) => {
        if (!isOnline() && (this.state === "playing" || this.state === "buffering")) {
          this.handleNetworkLost();
          return;
        }
        this.setState("error");
        this.callbacks.onError?.(error.message);
      },
      onComplete: async () => {
        debugLogger.info("streaming", "All chunks downloaded");
        if (this.useMSE && this.mediaSource?.readyState === "open") {
          try {
            this.mediaSource.endOfStream();
          } catch {
          }
          this.mseEstimatedDuration = 0;
        } else if (!this.useMSE && (this.chunks.length > 0 || this.chunksCleared)) {
          debugLogger.info("streaming", "Blob mode: rebuilding blob from all chunks");
          await this.setupBlobPlayback();
          this.lastRefreshDownloaded = this.totalDownloaded;
        }
      }
    };
  }
  // === 辅助方法 ===
  /**
   * 判断是否需要刷新 blob URL（播放接近已缓存末尾）
   */
  shouldRefreshBlob() {
    if (!this.audio)
      return false;
    const buffered = this.audio.buffered;
    if (buffered.length === 0)
      return false;
    const bufferedEnd = buffered.end(buffered.length - 1);
    if (!(bufferedEnd > 0))
      return false;
    return this.audio.currentTime / bufferedEnd > BUFFER_THRESHOLD;
  }
  /**
   * 检查缓存是否完整
   */
  isCacheComplete() {
    if (!this.cacheEntry || this.cacheEntry.totalSize === 0)
      return false;
    if (this.cacheEntry.expectedTotalSize && this.cacheEntry.expectedTotalSize > 0 && this.cacheEntry.totalSize < this.cacheEntry.expectedTotalSize) {
      return false;
    }
    return streamCacheEngine.isRangeDownloaded(
      this.cacheKey,
      0,
      this.cacheEntry.totalSize - 1
    );
  }
  /**
   * 获取恢复下载的偏移量
   * v29-A1: 连续前缀末尾 —— 旧实现取已下载区间的最大端（maxEnd+1），
   * Range 请求失败/超时产生的中间空洞永远不会再被回填（fetcher 永远从
   * 最远端续传），seek/续播时表现为「进度条可拖、拖到空洞区间无声」。
   * 现改为从 0 开始扫描排序后的区间，取首个空洞前的连续前缀长度；
   * 空洞之后的数据不浪费（仍在缓存元数据里），由后续按需请求覆盖。
   */
  getResumeOffset() {
    const entry2 = streamCacheEngine.getEntry(this.cacheKey);
    if (!entry2 || entry2.downloadedRanges.length === 0)
      return 0;
    const sorted = [...entry2.downloadedRanges].sort((a, b) => a.start - b.start);
    let end = -1;
    for (const range of sorted) {
      if (range.start > end + 1)
        break;
      if (range.end > end)
        end = range.end;
    }
    return end + 1;
  }
  /**
   * 合并所有 chunks 为单个 Uint8Array
   * P3 内存修复：区间不连续（早前 chunks 已清空 / seek 造成空洞）时返回 null。
   * 调用方必须改走缓存读路径，禁止用 0 填洞的合并结果覆盖缓存文件
   */
  mergeChunks() {
    if (this.chunks.length === 0)
      return new Uint8Array(0);
    const sorted = [...this.chunks].sort((a, b) => a.start - b.start);
    if (sorted[0].start > 0)
      return null;
    const last = sorted[sorted.length - 1];
    const totalSize = last.end + 1;
    const merged = new Uint8Array(totalSize);
    for (const chunk of sorted) {
      merged.set(chunk.data, chunk.start);
    }
    return merged;
  }
  /**
   * 推断 MIME 类型
   */
  inferMimeType(format) {
    const map = {
      mp3: "audio/mpeg",
      flac: "audio/flac",
      wav: "audio/wav",
      m4a: "audio/mp4",
      ogg: "audio/ogg",
      aac: "audio/aac"
    };
    return map[format || ""] || "audio/mpeg";
  }
  /**
   * 设置状态并触发回调
   */
  setState(state) {
    if (this.state === state)
      return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }
  /**
   * 启动进度追踪
   */
  startProgressTracking() {
    this.stopProgressTracking();
    this.progressTimer = window.setInterval(() => {
      if (this.audio) {
        const currentTime = this.audio.currentTime;
        const duration = this.audio.duration || 1;
        this.lastReportedTime = currentTime;
        this.callbacks.onProgress?.(currentTime, duration);
        if (duration > 0 && currentTime / duration > PRELOAD_THRESHOLD) {
        }
      }
    }, 250);
  }
  stopProgressTracking() {
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }
};
var streamingAudioPlayer = new StreamingAudioPlayer();
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  streamingAudioPlayer
});
