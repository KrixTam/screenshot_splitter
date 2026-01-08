import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [react()],
      define: {
        'process.env.API_KEY': JSON.stringify(env.OPENAI_API_KEY || ''),
        'process.env.OPENAI_API_KEY': JSON.stringify(env.OPENAI_API_KEY || ''),
        'process.env.OPENAI_BASE_URL': JSON.stringify(env.OPENAI_BASE_URL || ''),
        'process.env.MODEL': JSON.stringify(env.MODEL || ''),
        'process.env.JSON_SCHEMA': JSON.stringify(env.JSON_SCHEMA || '0'),
        'process.env.LLM_CONCURRENCY': JSON.stringify(env.LLM_CONCURRENCY || '4'),
        'process.env.LLM_BATCH': JSON.stringify(env.LLM_BATCH || '5')
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
