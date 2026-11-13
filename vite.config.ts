// 开发服务器和构建的配置。开发服务器只监听本机，不对外开放。
// base 用 './'，页面里的脚本、样式和字体都写成相对路径，部署在子路径下（例如 GitHub Pages 的 /sky-delivery/）也能用。
// 构建入口是根目录下的全部页面（*.html），index.html 是游戏。
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const input: Record<string, string> = Object.fromEntries(
  readdirSync(root)
    .filter((name) => name.endsWith('.html'))
    .sort()
    .map((name) => [name.slice(0, -'.html'.length), fileURLToPath(new URL(name, import.meta.url))]),
);

export default defineConfig({
  base: './',
  clearScreen: false,
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    rollupOptions: { input },
  },
});
