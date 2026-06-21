import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function manualChunks(id) {
  const normalizedId = id.replaceAll('\\\\', '/');

  if (!normalizedId.includes('/node_modules/')) {
    return undefined;
  }

  if (
    normalizedId.includes('/node_modules/react/') ||
    normalizedId.includes('/node_modules/react-dom/') ||
    normalizedId.includes('/node_modules/react-router/') ||
    normalizedId.includes('/node_modules/react-router-dom/') ||
    normalizedId.includes('/node_modules/scheduler/')
  ) {
    return 'react-vendor';
  }

  if (normalizedId.includes('/node_modules/@radix-ui/')) {
    return 'radix-vendor';
  }

  if (
    normalizedId.includes('/node_modules/framer-motion/') ||
    normalizedId.includes('/node_modules/motion-dom/') ||
    normalizedId.includes('/node_modules/motion-utils/')
  ) {
    return 'motion-vendor';
  }

  if (
    normalizedId.includes('/node_modules/react-markdown/') ||
    normalizedId.includes('/node_modules/unified/') ||
    normalizedId.includes('/node_modules/remark-') ||
    normalizedId.includes('/node_modules/rehype-') ||
    normalizedId.includes('/node_modules/micromark') ||
    normalizedId.includes('/node_modules/mdast-') ||
    normalizedId.includes('/node_modules/hast-') ||
    normalizedId.includes('/node_modules/vfile')
  ) {
    return 'markdown-vendor';
  }

  if (normalizedId.includes('/node_modules/lucide-react/')) {
    return 'icons-vendor';
  }

  return undefined;
}

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks,
        onlyExplicitManualChunks: true,
      },
    },
  },
});
