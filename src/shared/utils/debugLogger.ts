/**
 * 调试日志系统
 * - 仅本地存储，不上传
 * - 条数/体积上限控制，超出滚动丢弃最旧
 * - 支持查看（倒序）、清空、导出
 */

const STORAGE_KEY = 'yinliu.debug.logs.v1';
const MAX_ENTRIES = 500;
const MAX_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

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

class DebugLogger {
  private entries: DebugLogEntry[] = [];
  private enabled = false;
  private initialized = false;

  constructor() {
    this.load();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.log('info', 'app', '调试模式已开启');
    }
  }

  private load(): void {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DebugLogPersisted;
        this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      }
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    try {
      const data: DebugLogPersisted = { entries: this.entries };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // 存储失败时静默降级（可能超出 localStorage 配额）
    }
  }

  private enforceLimits(): void {
    // 条数限制
    while (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    // 体积限制
    let totalSize = this.entries.reduce((sum, e) => sum + estimateSize(e), 0);
    while (totalSize > MAX_SIZE_BYTES && this.entries.length > 0) {
      const removed = this.entries.shift();
      if (removed) {
        totalSize -= estimateSize(removed);
      }
    }
  }

  log(
    level: DebugLogLevel,
    category: DebugLogCategory,
    message: string,
    details?: Record<string, unknown>
  ): void {
    if (!this.enabled) return;

    const entry: DebugLogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      level,
      category,
      message,
      details,
    };

    this.entries.push(entry);
    this.enforceLimits();
    this.persist();

    // 同时输出到控制台，方便开发时查看
    const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    consoleMethod(`[DebugLogger][${category}] ${message}`, details ?? '');
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
    // 返回倒序副本
    return [...this.entries].reverse();
  }

  getCount(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  exportAsText(): string {
    const lines: string[] = [];
    lines.push(`音流调试日志导出`);
    lines.push(`生成时间: ${new Date().toLocaleString()}`);
    lines.push(`条目总数: ${this.entries.length}`);
    lines.push(`=` .repeat(60));
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

  triggerExport(): void {
    const text = this.exportAsText();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yinliu-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

export const debugLogger = new DebugLogger();
