'use client';

import { useState } from 'react';
import { H1, Table } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type U = { id: string; name: string; email: string; role: string; status: string; totp: boolean; lastLoginAt: string | null };

export default function AdminUsers() {
  const { data, reload } = useApi<{ items: U[] }>('/admin/v1/users', adminApi);
  const [f, setF] = useState({ name: '', email: '', role: 'reviewer' });
  const [temp, setTemp] = useState('');
  const create = async () => {
    const r = await adminApi.post<{ tempPassword: string }>('/admin/v1/users', f);
    setTemp(`Temporary password for ${f.email}: ${r.tempPassword} (shown once; 2FA enrolment required on first login)`);
    setF({ name: '', email: '', role: 'reviewer' });
    await reload();
  };
  const patch = async (id: string, body: object) => {
    await adminApi.patch(`/admin/v1/users/${id}`, body);
    await reload();
  };
  return (
    <div>
      <H1>Admin users</H1>
      <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_160px_auto]" onSubmit={(e) => (e.preventDefault(), void create())}>
        <Input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <Input placeholder="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
        <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="reviewer">Reviewer</option>
          <option value="support">Support</option>
          <option value="super_admin">Super admin</option>
        </Select>
        <Button>Add</Button>
      </form>
      {temp && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{temp}</p>}
      <Table
        rows={data?.items}
        cols={[
          { h: 'Name', c: (u) => u.name },
          { h: 'Email', c: (u) => u.email },
          { h: 'Role', c: (u) => u.role },
          { h: '2FA', c: (u) => (u.totp ? '✅' : '—') },
          { h: 'Status', c: (u) => <Badge tone={u.status === 'active' ? 'green' : 'red'}>{u.status}</Badge> },
          { h: 'Last login', c: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—') },
          {
            h: '',
            c: (u) => (
              <div className="flex gap-1">
                <Button variant="ghost" onClick={() => void patch(u.id, { status: u.status === 'active' ? 'disabled' : 'active' })}>{u.status === 'active' ? 'Disable' : 'Enable'}</Button>
                <Button variant="ghost" onClick={() => void patch(u.id, { resetTotp: true })}>Reset 2FA</Button>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
