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
        <div style={{ padding: 24, color: '#ef4444', fontFamily: 'system-ui' }}>
          <h2>应用加载出错</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
            {this.state.error?.message || 'Unknown error'}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: '8px 16px' }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

/** 加载中占位 */
function LoadingScreen() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: '#0f172a',
      color: '#e2e8f0',
      fontFamily: 'system-ui',
      flexDirection: 'column',
      gap: 16,
    }}>
      <div style={{ fontSize: 24, fontWeight: 600 }}>音流</div>
      <div style={{ fontSize: 14, opacity: 0.6 }}>正在加载...</div>
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
