import { LogoStacked } from '@/components/brand';

export default function Offline() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
      <LogoStacked />
      <p className="text-muted">You are offline. Captures you take will upload automatically when you are back online.</p>
    </main>
  );
}
