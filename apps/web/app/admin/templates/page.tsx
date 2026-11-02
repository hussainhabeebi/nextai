'use client';

import { useState } from 'react';
import { H1, Table } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type T = { id: string; key: string; name: string; language: string; params: string[]; category: string };

export default function Templates() {
  const { data, reload } = useApi<{ items: T[] }>('/admin/v1/templates', adminApi);
  const [f, setF] = useState({ key: '', name: '', language: 'en', params: '', category: 'UTILITY' });
  const save = async () => {
    await adminApi.request('/admin/v1/templates', { method: 'PUT', json: { ...f, params: f.params.split(',').map((s) => s.trim()).filter(Boolean) } });
    await reload();
  };
  return (
    <div>
      <H1>WhatsApp templates</H1>
      <p className="mb-4 text-sm text-muted">Map NextAi message keys to approved WhatsApp template names and their ordered parameters.</p>
      <form className="mb-4 grid gap-2 sm:grid-cols-6" onSubmit={(e) => (e.preventDefault(), void save())}>
        <Input placeholder="key (e.g. reminder)" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} required />
        <Input placeholder="template name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <Select value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option>en</option><option>ml</option><option>ar</option></Select>
        <Input className="sm:col-span-2" placeholder="params, comma separated" value={f.params} onChange={(e) => setF({ ...f, params: e.target.value })} />
        <Button>Save</Button>
      </form>
      <Table
        rows={data?.items}
        cols={[
          { h: 'Key', c: (x) => x.key },
          { h: 'Language', c: (x) => x.language },
          { h: 'Template', c: (x) => <code>{x.name}</code> },
          { h: 'Params', c: (x) => x.params.join(', ') },
          { h: 'Category', c: (x) => x.category },
          { h: '', c: (x) => <Button variant="ghost" onClick={() => setF({ key: x.key, name: x.name, language: x.language, params: x.params.join(', '), category: x.category })}>Edit</Button> },
        ]}
      />
    </div>
  );
}
