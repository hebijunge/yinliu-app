export interface ShowOptions {
  text: string;
  title?: string;
  artist?: string;
  /** 是否可拖动，默认 true */
  draggable?: boolean;
  /** 初始 X 位置（屏幕百分比 0-1），默认 0.1 */
  initialX?: number;
  /** 初始 Y 位置（屏幕百分比 0-1），默认 0.15 */
  initialY?: number;
}

export interface UpdateOptions {
  text: string;
  title?: string;
  artist?: string;
}

export interface FloatingLyricsPlugin {
  /**
   * 显示悬浮歌词窗（首次调用）
   * Android 会请求悬浮窗权限，未授权时抛错
   */
  show(options: ShowOptions): Promise<void>;

  /**
   * 更新悬浮歌词窗文字
   */
  update(options: UpdateOptions): Promise<void>;

  /**
   * 关闭并销毁悬浮歌词窗
   */
  hide(): Promise<void>;

  /**
   * 查询当前悬浮窗是否显示中
   */
  isShowing(): Promise<{ showing: boolean }>;
}
