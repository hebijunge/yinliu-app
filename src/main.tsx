import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/query-core';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';
import { streamCacheEngine } from './core/streaming';
import { initDatabase } from './shared/database';
import { initializeProviders } from './providers/music/registry';
import { sourceRegistry } from './providers/music/registry';
import { useSettingsStore } from './shared/store/settingsStore';
import { prewarmHomeCache } from './core/homeCache';
import { sourceHealthChecker } from './core/health/SourceHealthChecker';
import { runKugouLegacyIdMigration } from './modules/music/kugouLegacyIdMigrator';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  },
});

/** 错误边界组件，防止任何异常导致白屏 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-[var(--bg-primary)]">
          <div className="yinliu-card max-w-md w-full text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-3xl bg-red-500/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold mb-2 text-[var(--text-primary)]">应用加载出错</h2>
            <pre className="text-xs text-left text-red-400 bg-red-500/5 rounded-2xl p-3 mb-4 whitespace-pre-wrap">
              {this.state.error?.message || 'Unknown error'}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="yinliu-btn"
            >
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** 品牌 Logo SVG — C Style 极简 */
function LogoIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="6" y="6" width="52" height="52" rx="18" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <path
        d="M24 46V22l20-4v20"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="20" cy="46" r="5" stroke="currentColor" strokeWidth="2" fill="none" />
      <circle cx="40" cy="42" r="5" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

/** C Style 品牌加载页 — 极简留白 */
function LoadingScreen() {
  const [fadeOut, setFadeOut] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setFadeOut(true);
    }, 1400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[var(--bg-primary)] transition-opacity duration-700 ${
        fadeOut ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      {/* Clean Logo */}
      <div className="relative w-20 h-20 mb-8">
        <div className="absolute inset-0 flex items-center justify-center text-[var(--accent)]">
          <LogoIcon className="w-14 h-14" />
        </div>
      </div>

      {/* App name */}
      <h1 className="text-3xl font-light tracking-[0.2em] mb-3 text-[var(--text-primary)]">
        音流
      </h1>
      <p className="text-sm text-[var(--text-tertiary)] tracking-widest font-light">
        多音源聚合音乐播放器
      </p>

      {/* Minimal progress line */}
      <div className="mt-10 w-32 h-[2px] rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
        <div className="h-full rounded-full bg-[var(--accent)] animate-loading-bar" />
      </div>
    </div>
  );
}

/**
 * C10: 音源启用真值源收敛——settingsStore.enabledSources 是唯一真值源，
 * 启动时与变更时同步到 sourceRegistry 各源的 enabled 位，
 * 使聚合搜索 / 榜单 / 歌单分类等走 getEnabled() 的链路即时生效。
 */
function syncSourceEnabled(): void {
  const apply = (enabledSources: Record<string, boolean>) => {
    for (const source of sourceRegistry.getAll()) {
      source.enabled = enabledSources[source.id] !== false;
    }
  };
  apply(useSettingsStore.getState().enabledSources);
  useSettingsStore.subscribe((state, prev) => {
    if (state.enabledSources !== prev.enabledSources) apply(state.enabledSources);
  });
}

async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);

  // v23 修复走查 #7：去掉冷启动人为等待（旧 LoadingScreen 固定 1400ms）。
  // 立即渲染主界面，数据库初始化由 App 内部完成；加载遮罩在数据库就绪后立即淡出（见 App.tsx BootOverlay）。
  // P1 冷启动并行化：initializeProviders 与 initDatabase 用 Promise.allSettled 并行推进，
  // 二者互不阻塞、也不阻塞首帧渲染（initDatabase 幂等且并发去重，App 内 await 的是同一 promise）。
  const providerInit = Promise.resolve().then(() => initializeProviders());
  // C10: providers 注册完成后，把持久化的音源启用状态同步进 registry（并订阅后续变更）
  providerInit.then(() => syncSourceEnabled());
  const dbInit = initDatabase();
  void Promise.allSettled([providerInit, dbInit]).then(([providersResult, dbResult]) => {
    if (providersResult.status === 'rejected') {
      console.error('Provider initialization failed:', providersResult.reason);
    }
    if (dbResult.status === 'rejected') {
      console.error('Database initialization failed (bootstrap side):', dbResult.reason);
    }
    // v22 B5: 酷狗存量 legacy id（kg_N → kg_hash）一次性映射迁移（后台、幂等、只跑一次）
    void runKugouLegacyIdMigration().catch((err) =>
      console.error('Kugou legacy id migration failed:', err)
    );
  });

  // v22-lru-fix: App 启动时初始化流缓存引擎——加载元数据、执行启动 LRU 清理并启动定期清理
  try {
    await streamCacheEngine.init();
  } catch (cacheError) {
    console.error('Stream cache initialization failed:', cacheError);
  }

  // 无论数据库是否成功，都渲染主界面
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <HashRouter>
            <App />
          </HashRouter>
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );

  // 启动预热：后台检查首页缓存是否过期，过期提前拉取（fire-and-forget，失败静默）
  prewarmHomeCache();

  // W2: 源健康探活 —— provider 注册完成后拉起周期探活（fire-and-forget；unknown 状态不干预取链，失败静默）
  void providerInit
    .then(() => sourceHealthChecker.start())
    .catch((err) => console.error('Source health checker failed to start:', err));
}

bootstrap();
