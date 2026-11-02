import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'NextAi — accounting on WhatsApp',
    short_name: 'NextAi',
    description: 'Bills, invoices, reminders and your books — on WhatsApp and in your pocket.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#F6F8F7',
    theme_color: '#0E7A6B',
    categories: ['business', 'finance', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Capture a bill', url: '/capture', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Approvals', url: '/approvals', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
