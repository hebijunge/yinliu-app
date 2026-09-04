/**
 * 流式播放模块 v14.4
 * 边下边播（流式）核心出口
 */

export { detectMSECapability, isMSEAvailable, getPreferredMimeType } from './mseDetector';
export { streamCacheEngine, type CacheEntry } from './cache';
export {
  streamingAudioPlayer,
  type StreamingState,
  type StreamingCallbacks,
} from './player';
