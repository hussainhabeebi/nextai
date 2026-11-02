'use client';

import { ExternalLink } from 'lucide-react';
import { H1, Table } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type Q = { name: string; counts: Record<string, number> };

export default function Jobs() {
  const { data, reload } = useApi<{ queues: Q[] }>('/admin/v1/jobs', adminApi);
  const openBoard = async () => {
    const r = await adminApi.post<{ url: string }>('/admin/v1/jobs/board-token');
    window.open(r.url, '_blank', 'noopener');
  };
  return (
    <div>
      <H1 action={<Button variant="secondary" onClick={() => void openBoard()}><ExternalLink className="h-4 w-4" /> Open Bull Board</Button>}>Job monitor</H1>
      <Table
        rows={data?.queues}
        cols={[
          { h: 'Queue', c: (q) => <code>{q.name}</code> },
          ...(['waiting', 'active', 'delayed', 'failed', 'completed'] as const).map((k) => ({ h: k, c: (q: Q) => q.counts[k] ?? 0, className: 'text-end tabular-nums' })),
          { h: '', c: (q) => (q.counts.failed ? <Button variant="ghost" onClick={() => void adminApi.post(`/admin/v1/jobs/${q.name}/retry-failed`).then(reload)}>Retry failed</Button> : null) },
        ]}
      />
    </div>
  );
}
