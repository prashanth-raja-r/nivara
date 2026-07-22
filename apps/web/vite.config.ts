import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app and API intentionally share the project-root .env file.
export default defineConfig({
  plugins: [react()],
  envDir: '../../',
});
