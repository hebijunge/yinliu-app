import { registerPlugin } from '@capacitor/core';
import type { FloatingLyricsPlugin } from './definitions';

const FloatingLyrics = registerPlugin<FloatingLyricsPlugin>('FloatingLyrics', {
  web: () => import('./web').then((m) => new m.FloatingLyricsWeb()),
});

export default FloatingLyrics;
export * from './definitions';
