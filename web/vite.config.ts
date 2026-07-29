import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from other devices on the network
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3391',
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
          vendor: ['react', 'react-dom', 'react-router-dom', 'motion', 'jszip'],
        },
      },
    },
  },
});
