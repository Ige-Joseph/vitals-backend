import winston from 'winston';
import { env } from '../config/env';

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const devFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? `\n${JSON.stringify(meta, null, 2)}` : '';
  return `${timestamp} [${level}]: ${stack || message}${metaStr}`;
});

const productionFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json(),
);

const developmentFormat = combine(
  colorize(),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  devFormat,
);

export const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: env.NODE_ENV === 'production' ? productionFormat : developmentFormat,
  transports: [
    new winston.transports.Console({
      silent: env.NODE_ENV === 'test',
    }),
  ],
});

// Convenience child loggers per module — carries module context in every log line
export const createLogger = (module: string) =>
  logger.child({ module });
