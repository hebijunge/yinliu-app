import { create } from 'zustand';

/**
 * 全局 UI 状态（v23）
 * 侧边抽屉开合提升到 store：Android 物理返回键（App.tsx 的 backButton 处理）
 * 需要在路由回退之前优先关闭抽屉，而抽屉状态原来只存在于 Layout 的局部 useState。
 */
interface UiState {
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: false,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
