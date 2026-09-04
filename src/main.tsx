import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/query-core';
import { QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';
import { initializeProviders } from './providers/music/registry';
import { prewarmHomeCache } from './core/homeCache';
import { scheduleIdle } from './shared/utils/idleSchedule';

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

async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);

  // v23 修复走查 #7：去掉冷启动人为等待（旧 LoadingScreen 固定 1400ms）。
  // 立即渲染主界面，数据库初始化由 App 内部完成；加载遮罩在数据库就绪后立即淡出（见 App.tsx BootOverlay）。
  try {
    initializeProviders();
  } catch (providerError) {
    console.error('Provider initialization failed:', providerError);
  }

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

  // 启动预热：推迟到首帧之后的空闲期执行（fire-and-forget，失败静默）——P1 非关键路径不与首屏争抢主线程
  scheduleIdle(() => prewarmHomeCache());
}

bootstrap();
