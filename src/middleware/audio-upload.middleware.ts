import multer from 'multer';

import { AppError } from '@/lib/errors';

const MAX_AUDIO_SIZE = 5 * 1024 * 1024;

const ALLOWED_AUDIO_TYPES = [
  'audio/webm',
  'audio/wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
];

const storage = multer.memoryStorage();

export const audioUpload = multer({
  storage,

  limits: {
    fileSize: MAX_AUDIO_SIZE,
  },

  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_AUDIO_TYPES.includes(file.mimetype)) {
      return cb(
        AppError.badRequest(
          'Unsupported audio format. Allowed: webm, wav, mp3, mpeg, ogg',
        ),
      );
    }

    cb(null, true);
  },
});