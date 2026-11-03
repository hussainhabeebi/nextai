import { defineConfig } from 'astro/config';

// Static build for Cloudflare Pages (output: dist/).
export default defineConfig({ site: 'https://nextaierp.com', output: 'static', compressHTML: true });
