import { env } from '@/config/env';
import { AppError } from '@/lib/errors';
import { createLogger } from '@/lib/logger';

const log = createLogger('assemblyai-provider');

interface UploadResponse {
  upload_url: string;
}

interface TranscriptResponse {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text: string | null;
  error?: string | null;
}

const headers = () => {
  if (!env.ASSEMBLYAI_API_KEY) {
    throw AppError.internal('Speech service is not configured');
  }

  return {
    Authorization: env.ASSEMBLYAI_API_KEY,
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const assemblyAiProvider = {
  async transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
    if (!buffer.length) {
      throw AppError.badRequest('Audio file is empty');
    }

    const uploadRes = await fetch(`${env.ASSEMBLYAI_BASE_URL}/v2/upload`, {
      method: 'POST',
      headers: {
        ...headers(),
        'Content-Type': mimeType,
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const error = await uploadRes.text();
      log.error('AssemblyAI upload failed', { status: uploadRes.status, error });
      throw AppError.internal('Speech service upload failed');
    }

    const uploadData = (await uploadRes.json()) as UploadResponse;

    const transcriptRes = await fetch(`${env.ASSEMBLYAI_BASE_URL}/v2/transcript`, {
      method: 'POST',
      headers: {
        ...headers(),
        'Content-Type': 'application/json',
      },
        body: JSON.stringify({
        audio_url: uploadData.upload_url,
        speech_models: ['universal'],
      }),
    });

    if (!transcriptRes.ok) {
      const error = await transcriptRes.text();
      log.error('AssemblyAI transcript creation failed', {
        status: transcriptRes.status,
        error,
      });
      throw AppError.internal('Speech transcription failed');
    }

    const transcript = (await transcriptRes.json()) as TranscriptResponse;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await sleep(1500);

      const pollRes = await fetch(
        `${env.ASSEMBLYAI_BASE_URL}/v2/transcript/${transcript.id}`,
        {
          method: 'GET',
          headers: headers(),
        },
      );

      if (!pollRes.ok) {
        const error = await pollRes.text();
        log.error('AssemblyAI transcript polling failed', {
          status: pollRes.status,
          error,
        });
        throw AppError.internal('Speech transcription polling failed');
      }

      const pollData = (await pollRes.json()) as TranscriptResponse;

      if (pollData.status === 'completed') {
        if (!pollData.text) {
          throw AppError.badRequest('No speech was detected in the audio');
        }

        return pollData.text;
      }

      if (pollData.status === 'error') {
        log.error('AssemblyAI transcription error', {
          error: pollData.error,
        });
        throw AppError.internal('Speech transcription failed');
      }
    }

    throw AppError.internal('Speech transcription timed out');
  },
};