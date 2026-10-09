import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';
import root from '../../vite.config.js';

export default defineConfig({ resolve: root.resolve, plugins: [react()] });
