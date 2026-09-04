# 音流 (Audio Stream) - 多音源聚合音乐播放器

> MVP 版本 v0.1.0 | 技术栈: Tauri + Capacitor + React/TypeScript + SQLite

## 项目概述

「音流」是一款多音源聚合音乐播放器，支持同时搜索14个音乐平台的内容，提供统一的播放、歌单管理和下载体验。同时集成电子书阅读功能，打造音乐+阅读综合娱乐平台。

## 技术架构

```
┌─────────────────────────────────────────────┐
│  UI 层: React 18 + TypeScript + Tailwind CSS │
├─────────────────────────────────────────────┤
│  状态管理: Zustand + TanStack Query          │
├─────────────────────────────────────────────┤
│  业务逻辑: Music/Reading/Audio/DJ 四大模块   │
├─────────────────────────────────────────────┤
│  数据访问: Drizzle ORM + SQLite (sql.js)     │
├─────────────────────────────────────────────┤
│  音源层: MusicSource接口 + 45个Provider      │
├─────────────────────────────────────────────┤
│  平台抽象: PlatformAPI (Tauri/Capacitor)     │
├─────────────────────────────────────────────┤
│  运行平台: Tauri(桌面) / Capacitor(移动端)   │
└─────────────────────────────────────────────┘
```

## 已实现功能 (MVP)

### 音乐模块
- [x] **聚合搜索框架**: 多音源并发搜索架构，支持结果去重聚合
- [x] **音源Provider接口**: MusicSource统一接口 + BaseHttpSource抽象基类
- [x] **播放器核心**: Web Audio API封装，支持播放/暂停/进度/音量控制
- [x] **播放器UI**: 底部播放栏 + 全屏播放器 + 迷你模式
- [x] **歌单管理**: 创建/编辑/删除歌单，本地歌单列表
- [x] **主题系统**: 深色/浅色/跟随系统，CSS变量驱动
- [x] **LinkRace取链**: 音源内部并发竞速取链机制
- [x] **酷我兜底**: 主音源失败时自动切换酷我兜底

### 阅读模块
- [x] **书架管理**: 书架列表展示、阅读进度显示
- [x] **阅读器核心**: 仿真翻页/字体调节/主题切换
- [x] **阅读设置**: 字号/行距/背景主题调节

### 移动端适配
- [x] **响应式布局**: 桌面端(侧边栏) / 移动端(底部Tab) 自适应
- [x] **Capacitor配置**: 移动端构建目标配置
- [x] **手势交互**: 播放器展开/收起、列表滑动

## 待实现功能 (后续迭代)

### Phase 2: 核心音乐功能增强
- [ ] 5个P0音源完整接入（网易云/QQ/酷我/酷狗/咪咕）
- [ ] 聚合搜索结果真实去重排序
- [ ] 音质切换面板（标准/高品/无损/Hi-Res）
- [ ] 多平台歌单URL导入解析
- [ ] 本地音乐文件扫描与ID3标签读取
- [ ] 下载管理（队列/暂停/继续/多档音质）
- [ ] 歌词获取与展示

### Phase 3: 阅读模块完善
- [ ] 番茄小说书源Provider接入
- [ ] 书籍搜索与详情页
- [ ] 章节目录与快速跳转
- [ ] 阅读进度持久化同步
- [ ] 书签添加/删除/列表

### Phase 4: 有声 + DJ板块
- [ ] 系统TTS朗读引擎
- [ ] DJ舞曲聚合搜索
- [ ] DJ分类浏览（风格/BPM/时长）

### Phase 5: 多端优化
- [ ] Capacitor iOS/Android构建
- [ ] 系统媒体通知控制
- [ ] 音频后台播放
- [ ] 本地文件系统访问封装
- [ ] 性能优化（虚拟滚动/图片懒加载）

## 项目结构

```
src/
├── modules/           # 业务模块
│   ├── music/         # 音乐模块
│   ├── reading/       # 阅读模块
│   ├── audio/         # 有声/TTS模块
│   └── dj/            # DJ舞曲模块
├── shared/            # 共享基础设施
│   ├── platform/      # PlatformAPI抽象
│   ├── database/      # SQLite + Drizzle ORM
│   ├── store/         # Zustand状态管理
│   ├── theme/         # 主题系统
│   ├── network/       # HTTP客户端
│   └── utils/         # 通用工具
├── providers/         # 源适配器
│   ├── music/         # 音源Provider (45个)
│   ├── reading/       # 书源Provider
│   ├── audio/         # 有声书源Provider
│   └── dj/            # DJ源Provider
├── core/              # 核心引擎
│   ├── player/        # 统一播放器内核
│   ├── search/        # 聚合搜索引擎
│   ├── download/      # 下载管理引擎
│   └── linkrace/      # 并发竞速取链引擎
├── components/        # React组件
│   ├── layout/        # 布局组件
│   ├── player/        # 播放器组件
│   ├── search/        # 搜索组件
│   ├── playlist/      # 歌单组件
│   └── reading/       # 阅读组件
└── pages/             # 页面组件
```

## 开发环境

### 前置要求
- Node.js >= 18
- Android Studio (Android构建)
- Xcode (iOS构建，macOS only)

### 安装依赖
```bash
npm install
```

### 桌面端支持说明

**当前版本暂不支持桌面端（Windows / macOS / Linux）。** 桌面端曾基于 Tauri（`src-tauri/`）构建，
因引用了未安装的 Tauri HTTP 插件权限（`http:default`）导致构建失败，且 Web/Capacitor 版本
已覆盖全部核心功能，本周期已将 `src-tauri/` 目录从仓库摘除，并同步移除 `package.json` 中的
`tauri` 系列脚本与 `@tauri-apps/cli` 依赖。CSP 由 `index.html` 的 meta 标签统一管理
（已包含 `media-src blob:` 等流式播放所需指令），不受本次摘除影响。如后续恢复桌面端，
建议基于 Capacitor Electron 或重新评估 Tauri 方案后再引入。

### 移动端开发
```bash
# 添加移动端平台
npx cap add android
npx cap add ios

# 同步前端构建到原生项目
npm run cap:sync

# 打开Android Studio / Xcode
npm run cap:open:android
npm run cap:open:ios
```

### Android APK 自动构建 (GitHub Actions)

项目已配置 GitHub Actions 自动构建流水线，支持推送代码后自动构建 Debug APK。

**触发条件：**
- 推送到 `main` / `master` / `develop` 分支
- 手动触发（通过 GitHub 仓库的 Actions 页面）

**构建步骤：**
1. 检出代码
2. 安装 Node.js 20 并缓存 npm 依赖
3. 执行 `npm ci` 安装依赖
4. 执行 `npm run build` 构建前端
5. 安装 Java 17 (Temurin)
6. 安装 Android SDK
7. 执行 `npx cap add android` 添加 Android 平台
8. 执行 `npx cap sync` 同步前端构建产物
9. 执行 `./gradlew assembleDebug` 构建 Debug APK
10. 上传 `app-debug.apk` 作为构建产物

**获取构建产物：**
构建完成后，在 GitHub Actions 运行详情页面的 Artifacts 区域下载 `yinliu-debug-apk`。

**本地手动构建 APK：**
```bash
# 1. 确保前置条件满足
#    - Node.js >= 18
#    - Java 17 (推荐 Temurin)
#    - Android SDK (含 build-tools, platform-tools)

# 2. 安装依赖并构建前端
npm install
npm run build

# 3. 添加 Android 平台（首次）
npx cap add android

# 4. 同步前端构建产物
npx cap sync

# 5. 构建 Debug APK
cd android
./gradlew assembleDebug

# 6. APK 输出路径
# android/app/build/outputs/apk/debug/app-debug.apk
```

### 纯Web开发
```bash
npm run dev
```

## 数据库

使用 SQLite (sql.js WASM版) 在浏览器环境中运行，无需服务端。

- 音乐表: songs, playlists, playlist_songs, downloads, play_history, source_configs
- 阅读表: books, chapters, reading_progress, book_bookmarks, book_search_history
- 全局表: settings, app_cache

## 音源架构

```typescript
// 统一音源接口
interface MusicSource {
  readonly id: string;
  readonly name: string;
  readonly maxQuality: Quality;
  
  search(params: SearchParams): Promise<SearchResult[]>;
  getPlayUrl(songId: string, quality: Quality): Promise<PlayUrlResult>;
  getSongDetail(songId: string): Promise<SongDetail>;
  healthCheck(): Promise<HealthStatus>;
}
```

### P0音源 (已接入框架)
| 平台 | ID | 最高音质 |
|------|-----|---------|
| 网易云音乐 | netease | Hi-Res |
| QQ音乐 | qq | Hi-Fi |
| 酷我音乐 | kuwo | Hi-Fi |
| 酷狗音乐 | kugou | Hi-Res |
| 咪咕音乐 | migu | Hi-Res |

## 架构决策

1. **一套代码，多端适配**: Tauri + Capacitor 共享 React/TypeScript 代码库
2. **Provider驱动扩展**: 新增音源不改动核心逻辑
3. **并发竞速取链**: 音源内部多个endpoint并行请求，首个匹配采用
4. **酷我兜底**: 主音源全部失败时的最终防线
5. **数据库**: SQLite单文件，sql.js在浏览器内零配置运行

## 许可证

MIT License

## 致谢

- 产品需求文档: 飞书文档
- 技术方案设计: 架构师团队
- 音源技术分析: 45音源全量技术目录
