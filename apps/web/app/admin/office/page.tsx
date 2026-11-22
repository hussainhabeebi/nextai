'use client';

import { LIFECYCLE_ROLES } from '@nextai/shared';
import { Maximize2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { H1, Stat, Table } from '@/components/admin/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { adminApi } from '@/lib/api';
import { useApi } from '@/lib/hooks';

type Card = {
  id: string;
  name: string;
  roles: string[];
  presence: 'in' | 'out' | 'busy' | 'leave';
  presenceNote: string | null;
  checkInAt: string | null;
  checkOutAt: string | null;
  late: boolean;
  plan: string | null;
  blockers: string | null;
  done: string | null;
  openSteps: number;
  escalated: number;
  nextMeeting: { code: number; title: string; startsAt: string } | null;
};
type Floor = {
  date: string;
  stats: { total: number; in: number; late: number; onLeave: number; pendingApprovals: number; escalatedSteps: number; blockers: number; atRiskCustomers: number };
  cards: Card[];
  meetings: Array<{ code: number; title: string; startsAt: string; attendees: string[] }>;
  atRisk: Array<{ customer: string; project: string; score: number }>;
  announcements: Array<{ id: string; text: string; createdAt: string; recipients: number; acks: number }>;
};
type Approval = { id: string; code: number; kind: string; title: string; details: string | null; amount: string | null; status: string; requestedBy: string | null; decidedByName: string | null; decisionNote: string | null; createdAt: string };
type Perf = { name: string; roles: string[]; daysPresent: number; workDays: number; late: number; leaveDays: number; stepsDone: number; onTime: number; escalated: number; openNow: number; dealsWon: number; issuesResolved: number; standups: number };
type OfficeSettings = {
  enabled: boolean;
  workDays: number[];
  workStart: string;
  lateAfterMinutes: number;
  endOfDay: string;
  standupEnabled: boolean;
  teamSummaryEnabled: boolean;
  meetingReminderMinutes: number;
  weeklyReport: { enabled: boolean; weekday: number; hourLocal: number };
  attendanceErpSync: boolean;
};

const PRESENCE: Record<Card['presence'], { label: string; dot: string }> = {
  in: { label: 'In', dot: 'bg-green-500' },
  busy: { label: 'Busy', dot: 'bg-amber-500' },
  leave: { label: 'On leave', dot: 'bg-sky-500' },
  out: { label: 'Out', dot: 'bg-line' },
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const time = (s: string | null) => (s ? new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—');
const when = (s: string) => new Date(s).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function FloorView({ tenantId }: { tenantId: string }) {
  const { data, reload } = useApi<Floor>(`/admin/v1/tenants/${tenantId}/office/floor`, adminApi);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setInterval(() => void reload(), 30_000);
    return () => clearInterval(t);
  }, [reload]);
  if (!data) return <div className="h-40 animate-pulse rounded-xl bg-line/60" />;
  const s = data.stats;
  return (
    <div ref={box} className="grid min-w-0 gap-4 bg-bg [&:fullscreen]:overflow-auto [&:fullscreen]:p-8">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">Live · refreshes every 30 s · {data.date}</p>
        <Button variant="ghost" onClick={() => void box.current?.requestFullscreen?.()}>
          <Maximize2 className="h-4 w-4" /> TV mode
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="In the office" value={`${s.in}/${s.total}`} sub={s.late ? `${s.late} late` : 'nobody late'} />
        <Stat label="On leave" value={s.onLeave} />
        <Stat label="Escalated steps" value={s.escalatedSteps} sub={s.blockers ? `${s.blockers} blocker(s) today` : undefined} />
        <Stat label="Pending approvals" value={s.pendingApprovals} sub={s.atRiskCustomers ? `${s.atRiskCustomers} customer(s) at risk` : undefined} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data.cards.map((c) => (
          <article key={c.id} className="min-w-0 rounded-xl border border-line bg-card p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 font-semibold">
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${PRESENCE[c.presence].dot}`} aria-hidden="true" />
                  {c.name}
                </h3>
                <p className="text-xs text-muted">{c.roles.join(', ')}</p>
              </div>
              <Badge tone={c.presence === 'in' ? 'green' : c.presence === 'busy' ? 'amber' : 'neutral'}>{PRESENCE[c.presence].label}</Badge>
            </div>
            {c.presenceNote && <p className="mt-1 text-sm">{c.presenceNote}</p>}
            <p className="mt-2 text-xs text-muted">
              In {time(c.checkInAt)}
              {c.late && <span className="text-red-600"> (late)</span>} · Out {time(c.checkOutAt)}
            </p>
            {c.plan && <p className="mt-2 line-clamp-3 text-sm"><span className="text-muted">Plan: </span>{c.plan}</p>}
            {c.blockers && <p className="mt-1 text-sm text-red-600">🚧 {c.blockers}</p>}
            {c.done && <p className="mt-1 line-clamp-2 text-sm"><span className="text-muted">Done: </span>{c.done}</p>}
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <Badge>{c.openSteps} open</Badge>
              {c.escalated > 0 && <Badge tone="red">{c.escalated} escalated</Badge>}
              {c.nextMeeting && <Badge tone="amber">📅 #{c.nextMeeting.code} {time(c.nextMeeting.startsAt)}</Badge>}
            </div>
          </article>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
        <section>
          <h2 className="mb-2 font-semibold">Meetings (next 24 h)</h2>
          <Table rows={data.meetings} empty="No meetings." cols={[{ h: 'When', c: (m) => when(m.startsAt) }, { h: 'Meeting', c: (m) => `#${m.code} ${m.title}` }, { h: 'Who', c: (m) => m.attendees.join(', ') }]} />
        </section>
        <section>
          <h2 className="mb-2 font-semibold">Customers at risk</h2>
          <Table rows={data.atRisk} empty="None below the health threshold." cols={[{ h: 'Customer', c: (x) => x.customer }, { h: 'Health', c: (x) => <Badge tone="red">{x.score}</Badge> }]} />
        </section>
        <section>
          <h2 className="mb-2 font-semibold">Announcements</h2>
          <Table rows={data.announcements} empty="No announcements." cols={[{ h: 'Message', c: (a) => <span className="line-clamp-2">{a.text}</span> }, { h: 'Seen', c: (a) => `${a.acks}/${a.recipients}` }]} />
        </section>
      </div>
    </div>
  );
}

function AttendanceView({ tenantId }: { tenantId: string }) {
  const { data } = useApi<{ from: string; to: string; rows: Array<{ id: string; staffName: string; date: string; checkInAt: string | null; checkOutAt: string | null; late: boolean; note: string | null }>; leaves: Array<{ id: string; staffName: string; fromDate: string; toDate: string; reason: string | null; status: string }> }>(
    `/admin/v1/tenants/${tenantId}/office/attendance`,
    adminApi,
  );
  const hours = (a: string | null, b: string | null) => (a && b ? `${((Date.parse(b) - Date.parse(a)) / 3_600_000).toFixed(1)} h` : '—');
  return (
    <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
      <p className="text-sm text-muted">{data ? `${data.from} → ${data.to}` : ''}</p>
      <Table
        rows={data?.rows}
        empty="No check-ins yet."
        cols={[
          { h: 'Date', c: (r) => r.date },
          { h: 'Person', c: (r) => r.staffName },
          { h: 'In', c: (r) => <>{time(r.checkInAt)}{r.late && <Badge tone="red" className="ms-1">late</Badge>}</> },
          { h: 'Out', c: (r) => time(r.checkOutAt) },
          { h: 'Hours', c: (r) => hours(r.checkInAt, r.checkOutAt) },
          { h: 'Note', c: (r) => r.note ?? '' },
        ]}
      />
      <h2 className="font-semibold">Leave</h2>
      <Table rows={data?.leaves} empty="No leave in this period." cols={[{ h: 'Person', c: (l) => l.staffName }, { h: 'From', c: (l) => l.fromDate }, { h: 'To', c: (l) => l.toDate }, { h: 'Reason', c: (l) => l.reason ?? '' }, { h: 'Status', c: (l) => l.status }]} />
    </div>
  );
}

function StandupView({ tenantId }: { tenantId: string }) {
  const [date, setDate] = useState('');
  const { data } = useApi<{ date: string; items: Array<{ staffId: string; name: string; plan: string | null; blockers: string | null; done: string | null; handover: string | null; handoverTo: string | null }> }>(
    `/admin/v1/tenants/${tenantId}/office/standups${date ? `?date=${date}` : ''}`,
    adminApi,
  );
  return (
    <div className="grid min-w-0 gap-3">
      <Input type="date" className="w-48" value={date || data?.date || ''} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      {data?.items.map((s) => (
        <article key={s.staffId} className="rounded-xl border border-line bg-card p-4 text-sm">
          <h3 className="font-semibold">{s.name}</h3>
          {!s.plan && !s.done && <p className="text-muted">No stand-up.</p>}
          {s.plan && <p className="mt-1 whitespace-pre-line"><span className="text-muted">Plan: </span>{s.plan}</p>}
          {s.blockers && <p className="mt-1 text-red-600">🚧 {s.blockers}</p>}
          {s.done && <p className="mt-1 whitespace-pre-line"><span className="text-muted">Done: </span>{s.done}</p>}
          {s.handover && <p className="mt-1"><span className="text-muted">Handover → {s.handoverTo}: </span>{s.handover}</p>}
        </article>
      ))}
    </div>
  );
}

function ApprovalsView({ tenantId }: { tenantId: string }) {
  const [status, setStatus] = useState('pending');
  const { data, reload } = useApi<{ items: Approval[] }>(`/admin/v1/tenants/${tenantId}/office/approvals?status=${status}`, adminApi);
  const decide = async (code: number, decision: 'approved' | 'rejected') => {
    const note = decision === 'rejected' ? (prompt('Reason (optional)') ?? undefined) : undefined;
    await adminApi.request(`/admin/v1/tenants/${tenantId}/office/approvals/${code}/decide`, { method: 'POST', json: { decision, note } });
    await reload();
  };
  return (
    <div className="grid min-w-0 gap-3">
      <Select className="w-48" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
        {['pending', 'approved', 'rejected', 'all'].map((s) => <option key={s}>{s}</option>)}
      </Select>
      <Table
        rows={data?.items}
        empty="Nothing here."
        cols={[
          { h: '#', c: (a) => a.code },
          { h: 'Request', c: (a) => <div><p className="font-medium">{a.title}{a.amount && !a.title.includes(a.amount) ? ` (${a.amount})` : ''}</p>{a.details && <p className="whitespace-pre-line text-xs text-muted">{a.details}</p>}</div> },
          { h: 'Kind', c: (a) => a.kind },
          { h: 'From', c: (a) => a.requestedBy ?? '—' },
          {
            h: 'Status',
            c: (a) =>
              a.status === 'pending' ? (
                <span className="flex gap-1">
                  <Button onClick={() => void decide(a.code, 'approved')}>Approve</Button>
                  <Button variant="ghost" onClick={() => void decide(a.code, 'rejected')}>Reject</Button>
                </span>
              ) : (
                <span>{a.status} by {a.decidedByName ?? '—'}{a.decisionNote ? ` — ${a.decisionNote}` : ''}</span>
              ),
          },
        ]}
      />
    </div>
  );
}

function AnnouncementsView({ tenantId }: { tenantId: string }) {
  const { data, reload } = useApi<{ items: Array<{ id: string; text: string; roles: string[]; createdAt: string; from: string; acked: string[]; pending: string[] }> }>(`/admin/v1/tenants/${tenantId}/office/announcements`, adminApi);
  const [text, setText] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const send = async () => {
    await adminApi.request(`/admin/v1/tenants/${tenantId}/office/announcements`, { method: 'POST', json: { text, roles } });
    setText('');
    await reload();
  };
  return (
    <div className="grid min-w-0 gap-4">
      <form className="grid gap-2 rounded-xl border border-line bg-card p-4" onSubmit={(e) => (e.preventDefault(), void send())}>
        <textarea className="min-h-20 rounded-lg border border-line bg-bg p-2 text-sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message to the team (sent on WhatsApp from the staff number)" required aria-label="Message" />
        <div className="flex flex-wrap gap-2 text-sm">
          {LIFECYCLE_ROLES.map((r) => (
            <label key={r} className="flex items-center gap-1">
              <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))} /> {r}
            </label>
          ))}
          <span className="text-muted">(none ticked = everyone)</span>
        </div>
        <Button className="w-fit">Send announcement</Button>
      </form>
      {data?.items.map((a) => (
        <article key={a.id} className="rounded-xl border border-line bg-card p-4 text-sm">
          <p className="text-xs text-muted">{when(a.createdAt)} · {a.from}{a.roles.length ? ` → ${a.roles.join(', ')}` : ' → everyone'}</p>
          <p className="mt-1 whitespace-pre-line">{a.text}</p>
          <p className="mt-2 text-xs"><span className="text-green-700">✓ {a.acked.join(', ') || 'nobody yet'}</span>{a.pending.length > 0 && <span className="text-muted"> · waiting: {a.pending.join(', ')}</span>}</p>
        </article>
      ))}
    </div>
  );
}

function MeetingsView({ tenantId }: { tenantId: string }) {
  const { data } = useApi<{ items: Array<{ id: string; code: number; title: string; startsAt: string; durationMin: number; status: string; organizer: string | null; attendees: string[]; notes: string | null; taskNames: string[] }> }>(`/admin/v1/tenants/${tenantId}/office/meetings`, adminApi);
  return (
    <div className="grid min-w-0 gap-3">
      <p className="text-sm text-muted">Staff schedule meetings on WhatsApp: “meet Esha Akshay tomorrow 3pm onboarding sync”.</p>
      {data?.items.length === 0 && <p className="text-sm text-muted">No meetings in the last 30 days.</p>}
      {data?.items.map((m) => (
        <article key={m.id} className="rounded-xl border border-line bg-card p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">#{m.code} {m.title}</h3>
            <Badge tone={m.status === 'done' ? 'green' : 'neutral'}>{m.status}</Badge>
          </div>
          <p className="text-xs text-muted">{when(m.startsAt)} · {m.durationMin} min · {m.attendees.join(', ')}</p>
          {m.notes && <p className="mt-2 whitespace-pre-line">{m.notes}</p>}
          {m.taskNames.length > 0 && <p className="mt-1 text-xs text-muted">Tasks: {m.taskNames.join(', ')}</p>}
        </article>
      ))}
    </div>
  );
}

function PerformanceView({ tenantId }: { tenantId: string }) {
  const [days, setDays] = useState(7);
  const { data } = useApi<{ items: Perf[] }>(`/admin/v1/tenants/${tenantId}/office/performance?days=${days}`, adminApi);
  return (
    <div className="grid min-w-0 gap-3 [&>*]:min-w-0">
      <Select className="w-40" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
        {[7, 14, 30, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
      </Select>
      <Table
        rows={data?.items}
        cols={[
          { h: 'Person', c: (r) => r.name },
          { h: 'Attendance', c: (r) => `${r.daysPresent}/${r.workDays}${r.leaveDays ? ` (+${r.leaveDays} leave)` : ''}` },
          { h: 'Late', c: (r) => r.late },
          { h: 'Steps done', c: (r) => r.stepsDone },
          { h: 'On time', c: (r) => (r.stepsDone ? `${Math.round((r.onTime / r.stepsDone) * 100)}%` : '—') },
          { h: 'Escalated', c: (r) => r.escalated },
          { h: 'Open now', c: (r) => r.openNow },
          { h: 'Won', c: (r) => r.dealsWon },
          { h: 'Issues fixed', c: (r) => r.issuesResolved },
          { h: 'Stand-ups', c: (r) => r.standups },
        ]}
      />
    </div>
  );
}

function SettingsView({ tenantId }: { tenantId: string }) {
  const { data, reload } = useApi<{ settings: OfficeSettings; staffInboxId: number | null; customerInboxId: number | null; staff: Array<{ id: string; name: string; active: boolean; backupStaffId: string | null; erpEmployee: string | null }> }>(
    `/admin/v1/tenants/${tenantId}/office/settings`,
    adminApi,
  );
  const [f, setF] = useState<OfficeSettings | null>(null);
  const [inbox, setInbox] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (data) {
      setF(data.settings);
      setInbox(data.staffInboxId ? String(data.staffInboxId) : '');
    }
  }, [data]);
  if (!data || !f) return <div className="h-40 animate-pulse rounded-xl bg-line/60" />;
  const save = async () => {
    setMsg('');
    try {
      await adminApi.request(`/admin/v1/tenants/${tenantId}/office/settings`, { method: 'PATCH', json: { settings: f, staffInboxId: inbox ? Number(inbox) : null } });
      setMsg('Saved.');
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const patchStaff = async (id: string, json: Record<string, unknown>) => (await adminApi.request(`/admin/v1/tenants/${tenantId}/office/staff/${id}`, { method: 'PATCH', json }), reload());
  const row = 'flex flex-wrap items-center gap-2';
  return (
    <div className="grid min-w-0 gap-4 text-sm [&>*]:min-w-0">
      <form className="grid gap-3 rounded-xl border border-line bg-card p-4" onSubmit={(e) => (e.preventDefault(), void save())}>
        <h2 className="font-semibold">Staff WhatsApp number</h2>
        <label className={row}>
          Chatwoot inbox id of the team's number
          <Input className="w-36" inputMode="numeric" value={inbox} onChange={(e) => setInbox(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 12" />
          <span className="text-muted">(customer number is inbox {data.customerInboxId ?? '—'})</span>
        </label>
        <h2 className="mt-2 font-semibold">Office hours</h2>
        <label className={row}><input type="checkbox" className="h-5 w-5" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Virtual office on</label>
        <div className={row}>
          Work days
          {DAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input type="checkbox" checked={f.workDays.includes(i)} onChange={(e) => setF({ ...f, workDays: e.target.checked ? [...f.workDays, i].sort() : f.workDays.filter((x) => x !== i) })} /> {d}
            </label>
          ))}
        </div>
        <label className={row}>Start <Input type="time" className="w-32" value={f.workStart} onChange={(e) => setF({ ...f, workStart: e.target.value })} /> late after <Input type="number" className="w-20" value={f.lateAfterMinutes} onChange={(e) => setF({ ...f, lateAfterMinutes: Number(e.target.value) })} /> min</label>
        <label className={row}>End of day <Input type="time" className="w-32" value={f.endOfDay} onChange={(e) => setF({ ...f, endOfDay: e.target.value })} /></label>
        <label className={row}><input type="checkbox" className="h-5 w-5" checked={f.standupEnabled} onChange={(e) => setF({ ...f, standupEnabled: e.target.checked })} /> Ask the stand-up questions at check-in / check-out</label>
        <label className={row}><input type="checkbox" className="h-5 w-5" checked={f.teamSummaryEnabled} onChange={(e) => setF({ ...f, teamSummaryEnabled: e.target.checked })} /> AI team summary to management 1 h after end of day</label>
        <label className={row}>Meeting reminder <Input type="number" className="w-20" value={f.meetingReminderMinutes} onChange={(e) => setF({ ...f, meetingReminderMinutes: Number(e.target.value) })} /> min before</label>
        <label className={row}>
          <input type="checkbox" className="h-5 w-5" checked={f.weeklyReport.enabled} onChange={(e) => setF({ ...f, weeklyReport: { ...f.weeklyReport, enabled: e.target.checked } })} /> Weekly performance report on
          <Select className="w-28" value={f.weeklyReport.weekday} onChange={(e) => setF({ ...f, weeklyReport: { ...f.weeklyReport, weekday: Number(e.target.value) } })} aria-label="Weekday">{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</Select>
          at <Input type="number" min={0} max={23} className="w-20" value={f.weeklyReport.hourLocal} onChange={(e) => setF({ ...f, weeklyReport: { ...f.weeklyReport, hourLocal: Number(e.target.value) } })} aria-label="Hour" />:00
        </label>
        <label className={row}><input type="checkbox" className="h-5 w-5" checked={f.attendanceErpSync} onChange={(e) => setF({ ...f, attendanceErpSync: e.target.checked })} /> Create ERPNext Attendance at check-out (staff with an Employee id)</label>
        <div className="flex items-center gap-3"><Button>Save</Button>{msg && <span className="text-muted">{msg}</span>}</div>
      </form>
      <section>
        <h2 className="mb-2 font-semibold">Backups and ERPNext employees</h2>
        <Table
          rows={data.staff.filter((s) => s.active)}
          cols={[
            { h: 'Person', c: (s) => s.name },
            {
              h: 'Backup while on leave',
              c: (s) => (
                <Select className="w-44" value={s.backupStaffId ?? ''} onChange={(e) => void patchStaff(s.id, { backupStaffId: e.target.value || null })} aria-label={`Backup for ${s.name}`}>
                  <option value="">— rest of the role —</option>
                  {data.staff.filter((x) => x.id !== s.id && x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              ),
            },
            { h: 'ERPNext Employee', c: (s) => <Input className="w-40" defaultValue={s.erpEmployee ?? ''} onBlur={(e) => e.target.value !== (s.erpEmployee ?? '') && void patchStaff(s.id, { erpEmployee: e.target.value || null })} placeholder="HR-EMP-0001" aria-label={`Employee id for ${s.name}`} /> },
          ]}
        />
      </section>
    </div>
  );
}

const TABS = ['floor', 'attendance', 'stand-ups', 'approvals', 'announcements', 'meetings', 'performance', 'settings'] as const;

export default function Office() {
  const { data: tenants } = useApi<{ items: Array<{ id: string; name: string }> }>('/admin/v1/tenants', adminApi);
  const [tenantId, setTenantId] = useState('');
  const [tab, setTab] = useState<(typeof TABS)[number]>('floor');
  useEffect(() => {
    if (!tenantId && tenants?.items[0]) setTenantId(tenants.items[0].id);
  }, [tenants, tenantId]);
  return (
    <div className="min-w-0">
      <H1
        action={
          <Select value={tenantId} onChange={(e) => setTenantId(e.target.value)} aria-label="Tenant">
            {tenants?.items.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        }
      >
        Virtual office
      </H1>
      <p className="mb-4 text-sm text-muted">The team works from WhatsApp on the staff number: check-in, tasks, leave, approvals, meetings. This is the live view.</p>
      <div className="mb-4 flex gap-1 overflow-x-auto">
        {TABS.map((t) => (
          <Button key={t} variant={tab === t ? 'primary' : 'ghost'} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</Button>
        ))}
      </div>
      {tenantId && (
        <div key={`${tenantId}:${tab}`}>
          {tab === 'floor' && <FloorView tenantId={tenantId} />}
          {tab === 'attendance' && <AttendanceView tenantId={tenantId} />}
          {tab === 'stand-ups' && <StandupView tenantId={tenantId} />}
          {tab === 'approvals' && <ApprovalsView tenantId={tenantId} />}
          {tab === 'announcements' && <AnnouncementsView tenantId={tenantId} />}
          {tab === 'meetings' && <MeetingsView tenantId={tenantId} />}
          {tab === 'performance' && <PerformanceView tenantId={tenantId} />}
          {tab === 'settings' && <SettingsView tenantId={tenantId} />}
        </div>
      )}
    </div>
  );
}
