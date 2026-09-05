/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  /**
   * B4: 网易云内置 VIP Cookie（非登录态共享账号，MUSIC_U=...）。
   * 构建时通过 .env.local / CI 环境变量注入，不再硬编码进源码。
   * 未注入或失效时：官方取链匿名请求，失败自动降级到第三方代理通道。
   */
  readonly VITE_NETEASE_VIP_COOKIE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
