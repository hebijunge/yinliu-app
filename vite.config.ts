import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@modules': path.resolve(__dirname, './src/modules'),
      '@shared': path.resolve(__dirname, './src/shared'),
      '@providers': path.resolve(__dirname, './src/providers'),
      '@core': path.resolve(__dirname, './src/core'),
      '@plugins': path.resolve(__dirname, './src/plugins'),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    rollupOptions: {
      external: ['@capacitor/app'],
    },
  },
});
