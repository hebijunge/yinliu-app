/**
 * 音频工具模块导出
 */
export {
  decryptH5v24Response,
  extractZ3dKey,
  decryptZ3dChunk,
  decryptZ3d,
  decryptCencMp4,
  createCencDecryptStream,
  fetchDecryptedAudioStream,
  verifyWavHeader,
  type DecryptedAudio,
} from './crypto';
