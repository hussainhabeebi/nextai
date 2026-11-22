/**
 * "Create employee Sona C": add an Employee in the tenant's ERPNext. ERPNext requires first name, gender, date of
 * birth, date of joining and company, so the WhatsApp flow asks for whichever of these is missing first.
 * Nothing is created twice: an active employee with the same name (any letter case) is reported instead.
 */
import type { Tenant } from '@prisma/client';
import type { Container } from '../../container.js';
import { erpContext } from './mappers.js';

export const GENDERS = ['Female', 'Male', 'Other'] as const;
export type Gender = (typeof GENDERS)[number];

/** "f", "female", "lady", "1" → Female; "m", "male", "2" → Male; "3", "other" → Other. */
export function normalizeGender(s: string | undefined): Gender | undefined {
  const v = (s ?? '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!v) return undefined;
  if (/^(1|f|female|woman|lady|girl|she|her)$/.test(v)) return 'Female';
  if (/^(2|m|male|man|boy|gent|he|him)$/.test(v)) return 'Male';
  if (/^(3|o|other|others|prefer not to say)$/.test(v)) return 'Other';
  return undefined;
}

export interface NewEmployee {
  name: string;
  gender: Gender;
  birthDate: string;
  joiningDate: string;
}

export async function createEmployee(c: Container, tenant: Tenant, e: NewEmployee): Promise<{ created: boolean; name: string }> {
  const erp = c.erp(tenant);
  const company = erpContext(tenant).company;
  const same = await erp.list<{ name: string; employee_name?: string; status?: string }>('Employee', {
    filters: [['employee_name', 'like', e.name]],
    fields: ['name', 'employee_name', 'status'],
    limit: 20,
  });
  const existing = same.find((r) => (r.employee_name ?? '').trim().toLowerCase() === e.name.trim().toLowerCase() && r.status !== 'Left');
  if (existing) return { created: false, name: existing.name };
  const [first, ...rest] = e.name.trim().split(/\s+/);
  const created = await erp.create<{ name?: string }>('Employee', {
    first_name: first,
    ...(rest.length ? { last_name: rest.join(' ') } : {}),
    employee_name: e.name.trim(),
    gender: e.gender,
    date_of_birth: e.birthDate,
    date_of_joining: e.joiningDate,
    company,
    status: 'Active',
  });
  return { created: true, name: created.name ?? e.name };
}
