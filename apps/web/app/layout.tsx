import type { Metadata, Viewport } from 'next';
import { Inter, Nunito } from 'next/font/google';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/lib/i18n';
import { ServiceWorker } from '@/components/service-worker';
import './globals.css';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const brand = Nunito({ subsets: ['latin'], weight: ['800'], variable: '--font-brand', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'NextAi', template: '%s · NextAi' },
  description: 'Your accountant on WhatsApp — bills, invoices, reminders and books, done for you.',
  applicationName: 'NextAi',
  appleWebApp: { capable: true, title: 'NextAi', statusBarStyle: 'default' },
  icons: { icon: '/brand/app-icon.svg', apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0E7A6B' },
    { media: '(prefers-color-scheme: dark)', color: '#0A0F0E' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${brand.variable}`} suppressHydrationWarning>
      <body className="min-h-dvh font-sans antialiased">
        <I18nProvider>{children}</I18nProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
