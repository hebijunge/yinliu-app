/**
 * 调试日志系统
 * - 仅本地存储，不上传
 * - 条数/体积上限控制，超出滚动丢弃最旧
 * - 支持查看（倒序）、单条删除、按类批量删除、清空、导出
 * - 防抖持久化，避免主线程阻塞
 * - 敏感字段自动脱敏
 */

import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { toast } from '@shared/components/Toast';

const STORAGE_KEY = 'yinliu.debug.logs.v1';
/** 条数上限：超出时淘汰最旧记录 */
const MAX_ENTRIES = 500;
/** 体积上限 1MB：超出时淘汰最旧记录 */
const MAX_SIZE_BYTES = 1 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 500;
const BATCH_FLUSH_THRESHOLD = 10;

const SENSITIVE_KEYS = [
  'body',
  'token',
  'authorization',
  'cookie',
  'password',
  'secret',
  'key',
  'credentials',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'session',
  'phone',
  'email',
  'mobile',
  'passwd',
  'pwd',
  'client_secret',
  'client_id',
  'bearer',
];

export type DebugLogLevel = 'info' | 'warn' | 'error';

export type DebugLogCategory =
  | 'app'
  | 'navigate'
  | 'network'
  | 'player'
  | 'download'
  | 'click'
  | 'init';

export interface DebugLogEntry {
  id: string;
  timestamp: number;
  level: DebugLogLevel;
  category: DebugLogCategory;
  message: string;
  details?: Record<string, unknown>;
}

interface DebugLogPersisted {
  entries: DebugLogEntry[];
}

function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function estimateSize(entry: DebugLogEntry): number {
  return JSON.stringify(entry).length * 2; // rough UTF-16 estimate
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v));
  }
  const obj = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some((sk) => lowerKey.includes(sk))) {
      sanitized[key] = '<redacted>';
    } else {
      sanitized[key] = sanitizeValue(val);
    }
  }
  return sanitized;
}

class DebugLogger {
  private entries: DebugLogEntry[] = [];
  private enabled = false;
  private initialized = false;
  private persistTimer: number | null = null;
  private runningTotalSize = 0;
  private pendingCount = 0;
  private lifecycleListenersRegistered = false;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.ensureInit();
      this.log('info', 'app', '调试模式已开启');
    }
  }

  private ensureInit(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.load();
    this.registerLifecycleListeners();
  }

  /** 同步 flush pending 日志（用于页面/应用生命周期结束） */
  syncFlush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.enforceLimits();
    this.persist();
  }

  private registerLifecycleListeners(): void {
    if (this.lifecycleListenersRegistered) return;
    this.lifecycleListenersRegistered = true;

    window.addEventListener('pagehide', () => this.syncFlush());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.syncFlush();
      }
    });

    // Capacitor 环境：如适用，补充 appStateChange 监听
    if (typeof (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform === 'function') {
      // @ts-ignore @capacitor/app 为可选依赖，仅在 Capacitor 原生环境且插件已安装时生效
      import('@capacitor/app')
        .then((mod: unknown) => {
          const { App } = mod as {
            App: { addListener: (event: string, cb: (state: { isActive: boolean }) => void) => void };
          };
          App.addListener('appStateChange', ({ isActive }: { isActive: boolean }) => {
            if (!isActive) this.syncFlush();
          });
        })
        .catch(() => {
          // @capacitor/app 未安装，跳过
        });
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DebugLogPersisted;
        this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        this.runningTotalSize = this.entries.reduce((sum, e) => sum + estimateSize(e), 0);
      }
    } catch {
      this.entries = [];
      this.runningTotalSize = 0;
    }
  }

  private persist(): void {
    try {
      const data: DebugLogPersisted = { entries: this.entries };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      // 存储失败时降级并输出警告（可能超出 localStorage 配额）
      console.warn('[DebugLogger] persist failed:', err instanceof Error ? err.message : String(err));
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private enforceLimits(): void {
    // 条数限制
    while (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.shift();
      if (removed) {
        this.runningTotalSize -= estimateSize(removed);
      }
    }
    // 体积限制
    while (this.runningTotalSize > MAX_SIZE_BYTES && this.entries.length > 0) {
      const removed = this.entries.shift();
      if (removed) {
        this.runningTotalSize -= estimateSize(removed);
      }
    }
    this.pendingCount = 0;
  }

  log(
    level: DebugLogLevel,
    category: DebugLogCategory,
    message: string,
    details?: Record<string, unknown>
  ): void {
    if (!this.enabled) return;
    this.ensureInit();

    const entry: DebugLogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      level,
      category,
      message,
      details: details ? (sanitizeValue(details) as Record<string, unknown>) : undefined,
    };

    const entrySize = estimateSize(entry);
    this.entries.push(entry);
    this.runningTotalSize += entrySize;
    this.pendingCount++;

    // 达到批量阈值时立即执行限制检查
    if (this.pendingCount >= BATCH_FLUSH_THRESHOLD) {
      this.enforceLimits();
    }

    this.schedulePersist();

    // 同时输出到控制台，方便开发时查看
    const consoleMethod =
      level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleMethod(`[DebugLogger][${category}] ${message}`, entry.details ?? '');
  }

  info(category: DebugLogCategory, message: string, details?: Record<string, unknown>): void {
    this.log('info', category, message, details);
  }

  warn(category: DebugLogCategory, message: string, details?: Record<string, unknown>): void {
    this.log('warn', category, message, details);
  }

  error(category: DebugLogCategory, message: string, details?: Record<string, unknown>): void {
    this.log('error', category, message, details);
  }

  getEntries(): DebugLogEntry[] {
    this.ensureInit();
    // 返回倒序副本
    return [...this.entries].reverse();
  }

  getCount(): number {
    this.ensureInit();
    return this.entries.length;
  }

  clear(): void {
    this.ensureInit();
    this.entries = [];
    this.runningTotalSize = 0;
    this.pendingCount = 0;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }

  /** 删除单条日志 */
  deleteEntry(id: string): boolean {
    this.ensureInit();
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    const removed = this.entries.splice(idx, 1)[0];
    this.runningTotalSize -= estimateSize(removed);
    this.schedulePersist();
    return true;
  }

  /** 按类别批量删除，返回删除条数 */
  deleteByCategory(category: DebugLogCategory): number {
    this.ensureInit();
    let removedCount = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].category === category) {
        const removed = this.entries.splice(i, 1)[0];
        this.runningTotalSize -= estimateSize(removed);
        removedCount++;
      }
    }
    if (removedCount > 0) {
      this.schedulePersist();
    }
    return removedCount;
  }

  exportAsText(): string {
    this.ensureInit();
    const lines: string[] = [];
    lines.push(`音流调试日志导出`);
    lines.push(`生成时间: ${new Date().toLocaleString()}`);
    lines.push(`条目总数: ${this.entries.length}`);
    lines.push(`=`.repeat(60));
    lines.push('');

    for (const entry of this.entries) {
      const time = new Date(entry.timestamp).toLocaleString();
      const levelPad = entry.level.toUpperCase().padEnd(5);
      const catPad = entry.category.padEnd(10);
      lines.push(`[${time}] [${levelPad}] [${catPad}] ${entry.message}`);
      if (entry.details) {
        try {
          const detailStr = JSON.stringify(entry.details, null, 2);
          lines.push('  Details:');
          for (const line of detailStr.split('\n')) {
            lines.push(`    ${line}`);
          }
        } catch {
          lines.push('  Details: <无法序列化>');
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  exportAsMarkdown(): string {
    this.ensureInit();
    const lines: string[] = [];
    lines.push(`# 音流调试日志导出`);
    lines.push('');
    lines.push(`- **生成时间**: ${new Date().toLocaleString()}`);
    lines.push(`- **条目总数**: ${this.entries.length}`);
    lines.push('');

    for (const entry of this.entries) {
      const time = new Date(entry.timestamp).toLocaleString();
      const levelEmoji = entry.level === 'error' ? '🔴' : entry.level === 'warn' ? '🟡' : '🔵';
      lines.push(`## ${levelEmoji} [${entry.category.toUpperCase()}] ${entry.message}`);
      lines.push('');
      lines.push(`- **时间**: ${time}`);
      lines.push(`- **级别**: ${entry.level.toUpperCase()}`);
      lines.push(`- **类别**: ${entry.category}`);
      if (entry.details) {
        lines.push('');
        lines.push('```json');
        try {
          lines.push(JSON.stringify(entry.details, null, 2));
        } catch {
          lines.push('<无法序列化>');
        }
        lines.push('```');
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  private downloadBlob(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Capacitor 原生环境：写入文件系统后唤起分享面板 */
  private async exportNative(content: string, fileName: string, mimeType: string): Promise<string> {
    const dirPath = 'yinliu/logs';
    const filePath = `${dirPath}/${fileName}`;

    // 1. 确保目录存在
    try {
      await Filesystem.mkdir({ path: dirPath, directory: Directory.Documents, recursive: true });
    } catch {
      // 目录可能已存在
    }

    // 2. 写入文件（UTF-8 BOM 避免 Windows 记事本乱码）
    const bomContent = '\ufeff' + content;
    await Filesystem.writeFile({
      path: filePath,
      data: bomContent,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    });

    // 3. 获取文件 URI 用于分享
    const stat = await Filesystem.getUri({
      path: filePath,
      directory: Directory.Documents,
    });

    this.log('info', 'app', `调试日志已导出到: ${stat.uri}`);

    // 4. 唤起原生分享面板（用户取消会 reject，外层 catch 处理）
    await Share.share({
      title: `音流调试日志 - ${fileName}`,
      text: '音流调试日志导出文件',
      url: stat.uri,
      dialogTitle: '分享调试日志',
    });

    return stat.uri;
  }

  /** 导出防重入：连点时第二次直接忽略 */
  private isExporting = false;

  triggerExport(format: 'txt' | 'md' = 'txt'): void {
    if (this.isExporting) {
      toast.info('导出中', '请等待当前导出完成');
      return;
    }
    this.isExporting = true;

    const content = format === 'md' ? this.exportAsMarkdown() : this.exportAsText();
    const mimeType = format === 'md' ? 'text/markdown' : 'text/plain';
    const ext = format;
    const fileName = `yinliu-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${ext}`;

    // Capacitor 原生环境：走文件系统 + 原生分享面板
    if (Capacitor.isNativePlatform()) {
      this.exportNative(content, fileName, mimeType)
        .then((uri) => {
          toast.success('调试日志已导出', `已唤起系统分享面板，可保存到任意位置\n${uri}`);
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.log('error', 'app', `日志导出失败: ${msg}`);
          console.error('[DebugLogger] Native export failed:', err);
          toast.error('日志导出失败', `${msg}\n请尝试 .txt 格式，或反馈给开发者`);
        })
        .finally(() => {
          this.isExporting = false;
        });
      return;
    }

    // 浏览器环境：Blob 下载 / Web Share API
    const blob = new Blob(['\ufeff', content], { type: `${mimeType};charset=utf-8` });

    if (typeof navigator !== 'undefined' && 'share' in navigator && 'canShare' in navigator) {
      const file = new File([blob], fileName, { type: mimeType });
      const shareData: ShareData = { files: [file] };
      if (navigator.canShare?.(shareData)) {
        navigator
          .share(shareData)
          .then(() => {
            this.isExporting = false;
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.log('warn', 'app', `Web Share 失败，回退到下载: ${msg}`);
            this.downloadBlob(blob, fileName);
            this.isExporting = false;
          });
        return;
      }
    }

    this.downloadBlob(blob, fileName);
    this.isExporting = false;
  }
}

export const debugLogger = new DebugLogger();
