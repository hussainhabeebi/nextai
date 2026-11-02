import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: '#0E7A6B', dark: '#0A5E52', light: '#E6F3F1', amber: '#F29F12' },
        bg: 'rgb(var(--bg) / <alpha-value>)',
        card: 'rgb(var(--card) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
      },
      fontFamily: { sans: ['var(--font-sans)', 'system-ui', 'sans-serif'], brand: ['var(--font-brand)', 'var(--font-sans)', 'sans-serif'] },
      borderRadius: { xl: '1rem', '2xl': '1.25rem' },
    },
  },
  plugins: [],
} satisfies Config;
