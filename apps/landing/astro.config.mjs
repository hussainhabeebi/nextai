import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';
export default defineConfig({site:'https://nextaierp.com',integrations:[sitemap()],vite:{plugins:[tailwindcss()],server:{allowedHosts:["terminal.local"]}}});
