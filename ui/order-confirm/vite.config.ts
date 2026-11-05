import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// iframe 上で一枚の HTML として配信されるので、すべての asset を無条件でインライン化する閾値（~100MB）。
const INLINE_ALL_ASSETS_LIMIT_BYTES = 100_000_000;

// 出力先の dist/order-confirm.html は src/resources/app-resources.ts が読み込むので、パスを揃える。
export default defineConfig({
	root: __dirname,
	plugins: [react(), viteSingleFile()],
	build: {
		outDir: resolve(__dirname, 'dist'),
		emptyOutDir: true,
		rollupOptions: {
			input: resolve(__dirname, 'order-confirm.html'),
		},
		assetsInlineLimit: INLINE_ALL_ASSETS_LIMIT_BYTES,
		cssCodeSplit: false,
		sourcemap: false,
		minify: 'esbuild',
	},
});
