'use client';

import { Camera, FileUp, Mic, Square, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { enqueueCapture, uploadCapture } from '@/lib/offline-queue';

type Item = { name: string; type: string; data: Blob; preview?: string };

export default function CapturePage() {
  const { t } = useI18n();
  const { session } = useAuth();
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [recorder, setRecorder] = useState<MediaRecorder | null>(null);

  const add = (files: FileList | null) => {
    if (!files) return;
    setItems((prev) => [...prev, ...[...files].map((f) => ({ name: f.name, type: f.type, data: f, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined }))]);
  };

  const startVoice = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(chunks, { type: rec.mimeType.split(';')[0] || 'audio/webm' });
      setItems((prev) => [...prev, { name: `voice-${Date.now()}.webm`, type: blob.type, data: blob }]);
      setRecorder(null);
    };
    rec.start();
    setRecorder(rec);
  };

  const submit = async () => {
    if (!session || items.length === 0) return;
    setBusy(true);
    const files = items.map(({ name, type, data }) => ({ name, type, data }));
    try {
      if (!navigator.onLine) throw new Error('offline');
      await uploadCapture(files);
      setStatus(t('capture.uploaded'));
    } catch {
      await enqueueCapture({ tenantId: session.tenantId, files, createdAt: Date.now() });
      setStatus(t('capture.queued'));
    } finally {
      setItems([]);
      setBusy(false);
    }
  };

  return (
    <Page title={t('capture.title')}>
      <input ref={camera} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => add(e.target.files)} />
      <input ref={gallery} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => add(e.target.files)} />
      <div className="grid gap-3">
        <Button size="lg" onClick={() => camera.current?.click()}>
          <Camera className="h-6 w-6" /> {t('capture.camera')}
        </Button>
        <Button size="lg" variant="secondary" onClick={() => gallery.current?.click()}>
          <FileUp className="h-5 w-5" /> {t('capture.gallery')}
        </Button>
        {recorder ? (
          <Button size="lg" variant="danger" onClick={() => recorder.stop()}>
            <Square className="h-5 w-5" /> Stop recording
          </Button>
        ) : (
          <Button size="lg" variant="secondary" onClick={() => void startVoice()}>
            <Mic className="h-5 w-5" /> {t('capture.voice')}
          </Button>
        )}
      </div>

      {items.length > 0 && (
        <Card className="mt-4">
          <p className="mb-3 text-sm text-muted">{items.length} page(s) — add more pages of the same bill, then upload.</p>
          <ul className="grid grid-cols-3 gap-2">
            {items.map((it, i) => (
              <li key={i} className="relative aspect-[3/4] overflow-hidden rounded-lg border border-line bg-bg">
                {it.preview ? (
                  <img src={it.preview} alt={`Page ${i + 1}`} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center p-2 text-center text-xs">{it.type.startsWith('audio') ? '🎙️ Voice' : '📄 PDF'}</span>
                )}
                <button className="absolute end-1 top-1 rounded-full bg-black/60 p-1.5 text-white" aria-label="Remove" onClick={() => setItems(items.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
          <Button size="lg" className="mt-4" variant="amber" disabled={busy} onClick={() => void submit()}>
            <Upload className="h-5 w-5" /> Upload {items.length}
          </Button>
        </Card>
      )}
      {status && (
        <p role="status" className="mt-4 rounded-xl bg-brand-light p-3 text-sm text-brand-dark dark:bg-brand/20 dark:text-white">
          {status}
        </p>
      )}
    </Page>
  );
}
