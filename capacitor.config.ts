import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.yinliu.app',
  appName: '音流',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: false,
    allowNavigation: ['*'],
  },
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: true,
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
