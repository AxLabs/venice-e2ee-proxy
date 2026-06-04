import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    root: './',
    // Provided before any module import so ConfigModule validation passes.
    env: {
      VENICE_API_KEY: 'test-key',
      VERIFY_ATTESTATION: 'false',
    },
  },
  plugins: [
    // SWC transform so NestJS decorators / metadata work under Vitest.
    swc.vite({
      module: { type: 'es6' },
    }),
  ],
});
