import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';
import { initDatabase } from './shared/database';
import { initializeProviders } from './providers/music/registry';

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
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-red-500/10 flex items-center justify-center">
              <svg className="w-8 h-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold mb-2 text-[var(--text-primary)]">应用加载出错</h2>
            <pre className="text-xs text-left text-red-400 bg-red-500/5 rounded-lg p-3 mb-4 whitespace-pre-wrap">
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

/** 品牌 Logo SVG */
function LogoIcon({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#logoGrad)" opacity="0.15" />
      <rect x="4" y="4" width="56" height="56" rx="16" stroke="url(#logoGrad)" strokeWidth="2" opacity="0.5" />
      <path
        d="M22 48V20l24-4v24"
        stroke="url(#logoGrad)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="18" cy="48" r="6" stroke="url(#logoGrad)" strokeWidth="2.5" fill="none" />
      <circle cx="42" cy="44" r="6" stroke="url(#logoGrad)" strokeWidth="2.5" fill="none" />
    </svg>
  );
}

/** 品牌加载页 — Logo + 动效 + 平滑过渡 */
function LoadingScreen() {
  const [fadeOut, setFadeOut] = React.useState(false);

  React.useEffect(() => {
    // 至少展示 1.2s，让品牌感足够
    const timer = setTimeout(() => {
      setFadeOut(true);
    }, 1200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={`fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[var(--bg-primary)] transition-opacity duration-700 ${
        fadeOut ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      {/* Logo with pulse + spin ring */}
      <div className="relative w-24 h-24 mb-6">
        <div className="absolute inset-0 rounded-3xl bg-[var(--accent)]/10 animate-pulse-slow" />
        <div className="absolute -inset-2 rounded-[2rem] border-2 border-[var(--accent)]/20 animate-spin-slow" />
        <div className="absolute inset-0 flex items-center justify-center">
          <LogoIcon className="w-16 h-16" />
        </div>
      </div>

      {/* App name */}
      <h1 className="text-2xl font-bold tracking-wide mb-2 text-[var(--text-primary)]">
        音流
      </h1>
      <p className="text-sm text-[var(--text-tertiary)] tracking-wider">
        多音源聚合音乐播放器
      </p>

      {/* Progress bar */}
      <div className="mt-8 w-48 h-1 rounded-full bg-[var(--bg-tertiary)] overflow-hidden">
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
}

bootstrap();
