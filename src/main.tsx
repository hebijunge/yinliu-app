import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/query-core';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';
import { initDatabase } from './shared/database';
import { initializeProviders } from './providers/music/registry';
import { prewarmHomeCache } from './core/homeCache';
import { streamCacheEngine } from './core/streaming';

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

async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);

  // 先渲染加载态，避免白屏
  root.render(<LoadingScreen />);

  let dbOk = false;
  try {
    await initDatabase();
    dbOk = true;
  } catch (dbError) {
    console.error('Database initialization failed, falling back to memory mode:', dbError);
  }

  try {
    initializeProviders();
  } catch (providerError) {
    console.error('Provider initialization failed:', providerError);
  }

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
}

bootstrap();
