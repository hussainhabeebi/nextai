import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seed } from '../prisma/seed.js';
import { parseDate, ruleClassify } from '../src/ai/rules.js';
import { buildApp } from '../src/app.js';
import { tenantDb } from '../src/lib/db.js';
import { cleanPartyName, resolveParty } from '../src/modules/parties/resolve.js';
import type { DraftPayload } from '@nextai/shared';
import { closeShared, createTenant, drain, testContainer } from './helpers.js';
import { cwMessage, postCw } from './webhook-helpers.js';

const c = testContainer();
let app: FastifyInstance;
let T: Awaited<ReturnType<typeof createTenant>>;
let conv = 12000;

const cw = () => c.cws.get(T.tenant.id)!;
const docs = (d: string) => [...(c.erps.get(T.tenant.id)!.docs.get(d)?.values() ?? [])];
const say = (text: string, conversationId: number) =>
  postCw(app, cwMessage({ inboxId: T.tenant.cwInboxId!, phone: T.owner.phone!, content: text, conversationId }));
const lastDraft = async () =>
  (await tenantDb(c.prisma, T.tenant.id).draft.findFirstOrThrow({ where: { tenantId: T.tenant.id }, orderBy: { createdAt: 'desc' } })).payload as DraftPayload;

beforeAll(async () => {
  await seed(c.prisma);
  T = await createTenant(c.prisma, { settings: { companyAbbr: 'OTC' } });
  c.chatwoot(T.tenant);
  const erp = c.erp(T.tenant);
  // Customers already in ERPNext: two "Orbit" ones, one named by a naming series, one disabled.
  await erp.create('Customer', { name: 'Orbit Travels', customer_name: 'Orbit Travels' });
  await erp.create('Customer', { name: 'Orbit Tours & Travels', customer_name: 'Orbit Tours & Travels' });
  await erp.create('Customer', { name: 'CUST-0007', customer_name: 'Lulu Hypermarket' });
  await erp.create('Customer', { name: 'Old Orbit Agency', customer_name: 'Old Orbit Agency', disabled: 1 });
  await erp.create('Supplier', { name: 'AM Motors', supplier_name: 'AM Motors' });
  app = await buildApp(c);
});
afterAll(async () => {
  await app.close();
  await closeShared();
});

describe('dates written in words', () => {
  it('reads "nov 18", "18 Nov", "18th november 2026" and keeps them out of the name', () => {
    const now = new Date('2026-11-21T09:00:00Z');
    expect(parseDate('nov 18', now)).toBe('2026-11-18');
    expect(parseDate('18 Nov', now)).toBe('2026-11-18');
    expect(parseDate('18th November 2026', now)).toBe('2026-11-18');
    expect(parseDate('Nov 18, 2025', now)).toBe('2025-11-18');
    expect(parseDate('dec 20', new Date('2026-01-05T00:00:00Z'))).toBe('2025-12-20'); // last December, not next
    expect(parseDate('feb 30', now)).toBeUndefined();
    const r = ruleClassify('Received 1060 from Orbit Travels on nov 18');
    expect(r).toMatchObject({ intent: 'payment_in', entities: { amount: 1060, party: 'Orbit Travels' } });
    expect(r!.entities.date).toMatch(/^\d{4}-11-18$/);
    expect(cleanPartyName('Orbit Travels on nov 18')).toBe('Orbit Travels');
    expect(cleanPartyName('Orbit Travels 18/11')).toBe('Orbit Travels');
  });
});

describe('customer names come from the ERPNext customer list', () => {
  it('resolves exact, fuzzy, ambiguous and unknown names', async () => {
    expect(await resolveParty(c, T.tenant, 'Customer', 'orbit travels')).toMatchObject({ status: 'matched', name: 'Orbit Travels' });
    expect(await resolveParty(c, T.tenant, 'Customer', 'Orbit Travels on nov 18')).toMatchObject({ status: 'matched', name: 'Orbit Travels' });
    expect(await resolveParty(c, T.tenant, 'Customer', 'lulu hypermarket')).toMatchObject({ status: 'matched', name: 'CUST-0007' });
    const orbit = await resolveParty(c, T.tenant, 'Customer', 'Orbit');
    expect(orbit.status).toBe('ambiguous');
    expect(orbit.status === 'ambiguous' && orbit.candidates.map((x) => x.name)).toEqual(expect.arrayContaining(['Orbit Travels', 'Orbit Tours & Travels']));
    expect(orbit.status === 'ambiguous' && orbit.candidates.map((x) => x.name)).not.toContain('Old Orbit Agency'); // disabled
    expect(await resolveParty(c, T.tenant, 'Customer', 'Kochi Bakers')).toMatchObject({ status: 'not_found', candidates: [] });
    expect(await resolveParty(c, T.tenant, 'Supplier', 'AM Motor')).toMatchObject({ status: 'matched', name: 'AM Motors' });
  });

  it('the screenshot message: picks the real customer and the date that was written', async () => {
    const id = ++conv;
    await say('Received 1060 from Orbit Travels on nov 18', id);
    expect(cw().lastText(id)).toMatch(/Payment received[\s\S]*Customer: Orbit Travels\n/);
    const p = await lastDraft();
    expect(p).toMatchObject({ partyName: 'Orbit Travels', total: 1060 });
    expect(p.date).toMatch(/-11-18$/);
  });

  it('an unclear name is asked about, and the chosen customer is used', async () => {
    const id = ++conv;
    await say('received 500 from orbit', id);
    const q = cw().lastText(id)!;
    expect(q).toMatch(/Which customer did you mean by "orbit"\?/i);
    expect(q).toMatch(/\d\. Orbit Tours & Travels/);
    expect(q).toMatch(/Add "orbit" as new customer/i);
    const n = q.match(/(\d)\. Orbit Tours & Travels/)![1]!;
    await say(n, id);
    expect(cw().lastText(id)).toMatch(/Payment received[\s\S]*Customer: Orbit Tours & Travels[\s\S]*500/);
    await say('1', id);
    await drain(c);
    expect(docs('Payment Entry').at(-1)).toMatchObject({ party_type: 'Customer', party: 'Orbit Tours & Travels', paid_amount: 500 });
    expect(docs('Customer')).toHaveLength(4); // nothing new was created
  });

  it('typing another name instead of a number looks it up again', async () => {
    const id = ++conv;
    await say('sold 2000 to orbit', id);
    expect(cw().lastText(id)).toMatch(/Which customer did you mean/);
    await say('Orbit Travels', id);
    expect(cw().lastText(id)).toMatch(/Sales invoice[\s\S]*Customer: Orbit Travels[\s\S]*2,000/);
  });

  it('a name not in ERPNext is only added when the user says so', async () => {
    const id = ++conv;
    await say('received 700 from Kochi Bakers', id);
    expect(cw().lastText(id)).toMatch(/"Kochi Bakers" is not in your customer list[\s\S]*1\. ➕ Add "Kochi Bakers" as new customer/);
    await say('1', id);
    expect(cw().lastText(id)).toMatch(/Payment received[\s\S]*Customer: Kochi Bakers/);
    await say('1', id);
    await drain(c);
    expect(docs('Customer').map((d) => d.name)).toContain('Kochi Bakers');
  });

  it('changing the customer on a draft also checks the list', async () => {
    const id = ++conv;
    await say('received 900 from Orbit Travels', id);
    await say('customer orbit', id);
    expect(cw().lastText(id)).toMatch(/Which customer did you mean by "orbit"/i);
    await say('Orbit Tours', id); // start of a listed name
    expect(cw().lastText(id)).toMatch(/Payment received[\s\S]*Customer: Orbit Tours & Travels[\s\S]*900/);
    await say('customer Lulu Hypermarket', id);
    expect(cw().lastText(id)).toMatch(/Customer: CUST-0007/);
  });
});

describe('employees', () => {
  it('"Create Employee Sona C" asks for what ERPNext needs, then adds the employee', async () => {
    const id = ++conv;
    await say('Create Employee Sona C', id);
    expect(cw().lastText(id)).toMatch(/Adding employee Sona C[\s\S]*1\. Female/);
    await say('1', id);
    expect(cw().lastText(id)).toMatch(/date of birth/);
    await say('31/02/1995', id);
    expect(cw().lastText(id)).toMatch(/send the date like/);
    await say('15/03/1995', id);
    expect(cw().lastText(id)).toMatch(/When did Sona C join/);
    await say('today', id);
    expect(cw().lastText(id)).toMatch(/✅ Employee "Sona C" added/);
    const emp = docs('Employee').at(-1)!;
    expect(emp).toMatchObject({ first_name: 'Sona', last_name: 'C', gender: 'Female', date_of_birth: '1995-03-15', status: 'Active' });
    expect(emp.date_of_joining).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(emp.company).toBeTruthy();

    const id2 = ++conv;
    await say('add employee Sona C, female, dob 15/03/1995, joined 01/11/2026', id2);
    expect(cw().lastText(id2)).toMatch(/already in your employee list/);
    expect(docs('Employee')).toHaveLength(1);
  });
});
