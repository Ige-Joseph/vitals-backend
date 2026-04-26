import { env } from '@/config/env';
import { createLogger } from '@/lib/logger';
import { AppError } from '@/lib/errors';
import { Prisma } from '@prisma/client';

const log = createLogger('gemini-provider');

const GEMINI_TEXT_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const GEMINI_VISION_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

interface GeminiTextResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> };
  }>;
}

export const geminiProvider = {
  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    if (!env.GEMINI_API_KEY) {
      throw AppError.internal('AI service is not configured');
    }

    const body: Prisma.InputJsonValue = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(systemInstruction
        ? {
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
          }
        : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response: Response;
    try {
      response = await fetch(`${GEMINI_TEXT_URL}?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        log.error('Gemini text request timed out');
        throw AppError.internal('AI service timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const error = await response.text();
      log.error('Gemini text API error', { status: response.status, error });
      throw AppError.internal('AI service returned an error');
    }

    const data = (await response.json()) as GeminiTextResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      log.error('Gemini returned empty response', { data });
      throw AppError.internal('AI service returned an empty response');
    }

    return text;
  },

  async analyzeImage(base64Image: string, mimeType: string, prompt: string): Promise<string> {
    if (!env.GEMINI_API_KEY) {
      throw AppError.internal('AI service is not configured');
    }

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType, data: base64Image } }, { text: prompt }],
        },
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response: Response;
    try {
      response = await fetch(`${GEMINI_VISION_URL}?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        log.error('Gemini vision request timed out');
        throw AppError.internal('AI service timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const error = await response.text();
      log.error('Gemini vision API error', { status: response.status, error });
      throw AppError.internal('AI service returned an error');
    }

    const data = (await response.json()) as GeminiTextResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) throw AppError.internal('AI service returned an empty response');

    return text;
  },

  parseJson<T>(text: string): T {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      return JSON.parse(clean) as T;
    } catch {
      log.error('Failed to parse Gemini JSON response', { text: clean.slice(0, 200) });
      throw AppError.internal('AI returned an unreadable response');
    }
  },

  parseJsonSafe<T>(text: string): T | null {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    try {
      return JSON.parse(clean) as T;
    } catch {
      log.warn('Gemini JSON parse failed — caller will use fallback', {
        text: clean.slice(0, 200),
      });
      return null;
    }
  },
};