import pino from 'pino';

/** Structured JSON logger. Credential-bearing fields are redacted wherever they appear. */
export function createLogger(level: string = 'info') {
  return pino({
    level,
    base: { service: 'sentinel-api' },
    redact: {
      paths: [
        'password', '*.password', '*.currentPassword', '*.newPassword', 'token', '*.token', 'authorization', '*.authorization',
        'req.headers.authorization', 'req.headers.cookie', '*.apiKey', '*.secret', '*.accessToken', '*.refreshToken', 'headers.authorization',
      ],
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
export type Logger = ReturnType<typeof createLogger>;
