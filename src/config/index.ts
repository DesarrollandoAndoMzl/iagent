import dotenv from 'dotenv';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export const config = {
  port: parseInt(process.env.PORT ?? '8080', 10),
  geminiApiKey: requireEnv('GEMINI_API_KEY'),
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS ?? '*'),
} as const;
