import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.yinliu.app',
  appName: '音流',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false,
    allowNavigation: [
      'https://*.kuwo.cn', 'https://kuwo.cn',
      'https://*.kugou.com', 'https://kugou.com',
      'https://*.qq.com',
      'https://music.163.com', 'https://*.music.126.net', 'https://163cn.tv',
      'https://*.migu.cn',
      'https://*.qishui.com', 'https://*.douyin.com', 'https://*.douyinpic.com',
      'https://api.bilibili.com', 'https://www.bilibili.com', 'https://passport.bilibili.com',
      'https://api.vkeys.cn', 'https://api.qijieya.cn', 'https://metingapi.nanorocky.top',
      'https://music-api.gdstudio.xyz', 'https://musicapi.haitangw.net', 'https://musicserver.haitangw.cc',
      'https://music.sedet.top', 'https://qishui.lxmapi.icu',
    ],
  },
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: process.env.CAP_WEB_DEBUG === '1',
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#0f172a',
    },
  },
};

export default config;
