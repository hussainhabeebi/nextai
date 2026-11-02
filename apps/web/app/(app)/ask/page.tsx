'use client';

import { Send } from 'lucide-react';
import { useState } from 'react';
import { Page } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '@/lib/api';

export default function Ask() {
  const [q, setQ] = useState('');
  const [chat, setChat] = useState<Array<{ who: 'me' | 'ai'; text: string }>>([]);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    setChat((c) => [...c, { who: 'me', text: question }]);
    setQ('');
    setBusy(true);
    try {
      const r = await api.post<{ answer: string }>('/v1/ask', { question });
      setChat((c) => [...c, { who: 'ai', text: r.answer }]);
    } catch (e) {
      setChat((c) => [...c, { who: 'ai', text: (e as ApiError).message }]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Ask your books" back="/more">
      <div className="space-y-3 pb-20">
        {chat.length === 0 && <Card className="text-sm text-muted">Try: “How much do customers owe me?” or “What did I spend on fuel this month?”</Card>}
        {chat.map((m, i) => (
          <div key={i} className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm ${m.who === 'me' ? 'ms-auto bg-brand text-white' : 'bg-card'}`}>{m.text}</div>
        ))}
        {busy && <div className="w-16 animate-pulse rounded-2xl bg-card px-4 py-2">…</div>}
      </div>
      <form className="fixed inset-x-0 bottom-14 z-20 border-t border-line bg-bg p-3" onSubmit={(e) => (e.preventDefault(), void ask())}>
        <div className="mx-auto flex max-w-[640px] gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask a question" />
          <Button size="icon" className="h-12 w-12 shrink-0" aria-label="Send" disabled={busy}>
            <Send className="h-5 w-5 rtl:rotate-180" />
          </Button>
        </div>
      </form>
    </Page>
  );
}
