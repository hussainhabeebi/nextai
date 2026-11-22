import type { LifecycleRole, ReminderAudience } from '@prisma/client';

/**
 * Default lead-to-customer playbook (stages 1–19). Installed per tenant from the admin console and then
 * edited there: every rule and every level can be switched off, re-timed, re-targeted or reworded.
 * Installing again only adds missing rules/levels — it never overwrites admin edits.
 *
 * offsetMinutes is relative to the timer's anchor (negative = before it):
 *   lead.*            Lead created               demo.reminder   Event start
 *   demo.outcome      Event marked Completed     proposal.send   Opportunity reached the proposal stage
 *   proposal.followup Quotation submitted        deal.won        Sales Order submitted
 *   invoice.due / collection.overdue  invoice due date
 *   handover.project / kickoff.data   first payment (Project created from the Onboarding Template)
 *   task.due          Task expected end date     golive / review.*  Project moved to Live
 *   bot.monthly_update  1st of the month         support.*       Issue opened / resolved
 *   renewal           Subscription end date
 */

export interface DefaultLevel {
  level: number;
  offsetMinutes: number;
  audience: ReminderAudience;
  templateKey?: string;
  message: string;
}
export interface DefaultRule {
  key: string;
  stage: number;
  name: string;
  description: string;
  ownerRole: LifecycleRole;
  escalationRole?: LifecycleRole;
  levels: DefaultLevel[];
}

const H = 60;
const D = 24 * H;

export const DEFAULT_PLAYBOOK: DefaultRule[] = [
  {
    key: 'lead.assign',
    stage: 1,
    name: 'Lead captured',
    description: 'Lead from Meta ads / WhatsApp / website (via Leadvyne) is created in ERPNext and assigned.',
    ownerRole: 'sales',
    levels: [{ level: 1, offsetMinutes: 0, audience: 'owner', message: 'New lead {{lead_name}} ({{source}}) is assigned to you. Call within 1 hour: {{phone}}' }],
  },
  {
    key: 'lead.first_call',
    stage: 2,
    name: 'Lead qualified — call within 1 hour',
    description: 'Done when the Lead is contacted or converted to an Opportunity.',
    ownerRole: 'sales',
    levels: [
      { level: 1, offsetMinutes: 45, audience: 'owner', message: '15 minutes left to call {{lead_name}} ({{phone}}).' },
      { level: 2, offsetMinutes: 60, audience: 'owner', message: 'Overdue: {{lead_name}} has not been called within 1 hour.' },
      { level: 3, offsetMinutes: 90, audience: 'escalation', message: 'Escalation: {{owner_name}} has not called lead {{lead_name}} after 90 minutes.' },
    ],
  },
  {
    key: 'demo.reminder',
    stage: 3,
    name: 'Demo scheduled',
    description: 'Event linked to the Opportunity. Reminders to the customer and the salesperson.',
    ownerRole: 'sales',
    levels: [
      { level: 1, offsetMinutes: -1 * D, audience: 'customer', templateKey: 'demo_reminder', message: 'Hi {{customer_name}}, reminder: your NextAi demo is tomorrow at {{start_time}}.' },
      { level: 2, offsetMinutes: -1 * D, audience: 'owner', message: 'Demo with {{customer_name}} tomorrow at {{start_time}}.' },
      { level: 3, offsetMinutes: -1 * H, audience: 'customer', templateKey: 'demo_reminder', message: 'Hi {{customer_name}}, your NextAi demo starts in 1 hour ({{start_time}}).' },
      { level: 4, offsetMinutes: -1 * H, audience: 'owner', message: 'Demo with {{customer_name}} starts in 1 hour.' },
    ],
  },
  {
    key: 'demo.outcome',
    stage: 4,
    name: 'Demo done — record outcome within 2 hours',
    description: 'Done when the Opportunity demo outcome is filled in.',
    ownerRole: 'sales',
    levels: [
      { level: 1, offsetMinutes: 90, audience: 'owner', message: 'Please record the demo outcome for {{customer_name}} ({{name}}). 30 minutes left.' },
      { level: 2, offsetMinutes: 2 * H, audience: 'owner', message: 'Overdue: demo outcome for {{customer_name}} is not recorded.' },
      { level: 3, offsetMinutes: 3 * H, audience: 'escalation', message: 'Escalation: demo outcome for {{customer_name}} not recorded by {{owner_name}}.' },
    ],
  },
  {
    key: 'proposal.send',
    stage: 5,
    name: 'Proposal sent within 24 hours',
    description: 'Done when a Quotation for the Opportunity is submitted.',
    ownerRole: 'accountant',
    escalationRole: 'management',
    levels: [
      { level: 1, offsetMinutes: 0, audience: 'owner', message: 'Prepare and send the proposal to {{customer_name}} within 24 hours ({{name}}).' },
      { level: 2, offsetMinutes: 20 * H, audience: 'owner', message: '4 hours left to send the proposal to {{customer_name}}.' },
      { level: 3, offsetMinutes: 26 * H, audience: 'escalation', message: 'Escalation: proposal to {{customer_name}} not sent within 24 hours.' },
    ],
  },
  {
    key: 'proposal.followup',
    stage: 6,
    name: 'Follow-up and negotiation (days 2, 5, 10)',
    description: 'Done when the Quotation is ordered (Sales Order) or lost.',
    ownerRole: 'accountant',
    escalationRole: 'management',
    levels: [
      { level: 1, offsetMinutes: 2 * D, audience: 'owner', message: 'Day 2 follow-up: call {{customer_name}} about quotation {{name}}.' },
      { level: 2, offsetMinutes: 2 * D, audience: 'customer', templateKey: 'proposal_followup', message: 'Hi {{customer_name}}, did you get a chance to review our proposal? Happy to answer any questions.' },
      { level: 3, offsetMinutes: 5 * D, audience: 'owner', message: 'Day 5 follow-up: {{customer_name}}, quotation {{name}}.' },
      { level: 4, offsetMinutes: 10 * D, audience: 'owner', message: 'Day 10 final follow-up: {{customer_name}}, quotation {{name}}. Update the Opportunity stage.' },
      { level: 5, offsetMinutes: 11 * D, audience: 'escalation', message: 'Quotation {{name}} for {{customer_name}} still open after 10 days.' },
    ],
  },
  {
    key: 'deal.won',
    stage: 7,
    name: 'Deal won',
    description: 'Sales Order submitted: create the Customer and agreement.',
    ownerRole: 'accountant',
    levels: [
      { level: 1, offsetMinutes: 0, audience: 'owner', message: 'Deal won: {{customer_name}} ({{name}}). Send the agreement and the invoice.' },
      { level: 2, offsetMinutes: 0, audience: 'management', message: '🎉 Deal won: {{customer_name}}, {{amount}}.' },
    ],
  },
  {
    key: 'invoice.due',
    stage: 8,
    name: 'Invoice and payment',
    description: 'Sales Invoice sent; reminders before the due date. Done when paid.',
    ownerRole: 'accountant',
    levels: [
      { level: 1, offsetMinutes: -2 * D, audience: 'customer', templateKey: 'payment_reminder', message: 'Hi {{customer_name}}, invoice {{name}} for {{amount}} is due on {{due_date}}.' },
      { level: 2, offsetMinutes: 0, audience: 'customer', templateKey: 'payment_reminder', message: 'Hi {{customer_name}}, invoice {{name}} for {{amount}} is due today.' },
    ],
  },
  {
    key: 'handover.project',
    stage: 9,
    name: 'Handover — project created after first payment',
    description: 'Project created from the Onboarding Template when the first payment is received.',
    ownerRole: 'onboarding',
    levels: [
      { level: 1, offsetMinutes: 0, audience: 'owner', message: 'Payment received from {{customer_name}}. Project {{project}} is created and assigned to you.' },
      { level: 2, offsetMinutes: 0, audience: 'customer', templateKey: 'onboarding_welcome', message: 'Welcome to NextAi, {{customer_name}}! {{owner_name}} will guide your setup.' },
    ],
  },
  {
    key: 'kickoff.data',
    stage: 10,
    name: 'Kickoff and data collection',
    description: 'The customer is chased for missing data. Done when the Project leaves the Data stage.',
    ownerRole: 'onboarding',
    levels: [
      { level: 1, offsetMinutes: 1 * D, audience: 'customer', templateKey: 'data_request', message: 'Hi {{customer_name}}, to build your bot please send your product list, prices, FAQs and logo.' },
      { level: 2, offsetMinutes: 3 * D, audience: 'customer', templateKey: 'data_request', message: 'Hi {{customer_name}}, a gentle reminder: we are still waiting for your details to start setup.' },
      { level: 3, offsetMinutes: 5 * D, audience: 'owner', message: '{{customer_name}} has not sent the onboarding data after 5 days. Please call.' },
      { level: 4, offsetMinutes: 7 * D, audience: 'escalation', message: 'Onboarding data for {{customer_name}} still missing after 7 days.' },
    ],
  },
  {
    key: 'task.due',
    stage: 11,
    name: 'Project tasks (setup, bot build, QA, testing, training)',
    description: 'Every Task with an expected end date; owner = assignee. Done when the Task is completed.',
    ownerRole: 'onboarding',
    levels: [
      { level: 1, offsetMinutes: -1 * D, audience: 'owner', message: 'Task "{{subject}}" ({{project}}) is due tomorrow.' },
      { level: 2, offsetMinutes: 0, audience: 'owner', message: 'Task "{{subject}}" ({{project}}) is due today.' },
      { level: 3, offsetMinutes: 1 * D, audience: 'escalation', message: 'Task "{{subject}}" for {{customer_name}} is 1 day overdue ({{owner_name}}).' },
    ],
  },
  {
    key: 'golive',
    stage: 14,
    name: 'Go live',
    description: 'Project moved to the Live stage: notify the customer and management.',
    ownerRole: 'onboarding',
    levels: [
      { level: 1, offsetMinutes: 0, audience: 'customer', templateKey: 'golive', message: 'Congratulations {{customer_name}}, your NextAi bot is now live! 🚀' },
      { level: 2, offsetMinutes: 0, audience: 'management', message: '{{customer_name}} is live ({{project}}).' },
    ],
  },
  {
    key: 'review.day7',
    stage: 15,
    name: 'Review at day 7 (health score)',
    description: 'Done when the day-7 review Task is completed with a health score.',
    ownerRole: 'qa',
    levels: [
      { level: 1, offsetMinutes: 7 * D, audience: 'owner', message: 'Day-7 review due for {{customer_name}} ({{project}}). Record the health score.' },
      { level: 2, offsetMinutes: 7 * D, audience: 'customer', templateKey: 'review_request', message: 'Hi {{customer_name}}, how is your first week with NextAi? Reply with any feedback.' },
    ],
  },
  {
    key: 'review.day30',
    stage: 15,
    name: 'Review at day 30 (health score)',
    description: 'Done when the day-30 review Task is completed with a health score.',
    ownerRole: 'qa',
    levels: [
      { level: 1, offsetMinutes: 30 * D, audience: 'owner', message: 'Day-30 review due for {{customer_name}} ({{project}}). Record the health score.' },
      { level: 2, offsetMinutes: 30 * D, audience: 'customer', templateKey: 'review_request', message: 'Hi {{customer_name}}, it has been a month with NextAi. How are we doing?' },
    ],
  },
  {
    key: 'bot.monthly_update',
    stage: 16,
    name: 'Monthly bot update',
    description: 'The AI asks every live customer for new products and offers on the 1st of the month.',
    ownerRole: 'ai_manager',
    escalationRole: 'qa',
    levels: [
      { level: 1, offsetMinutes: 0, audience: 'customer', templateKey: 'monthly_update', message: 'Hi {{customer_name}}, any new products, prices or offers this month? Send them here and we will update your bot.' },
      { level: 2, offsetMinutes: 3 * D, audience: 'customer', templateKey: 'monthly_update', message: 'Hi {{customer_name}}, a reminder to send this month\'s new products or offers.' },
      { level: 3, offsetMinutes: 5 * D, audience: 'owner', message: 'Monthly update for {{customer_name}}: no reply after 5 days.' },
    ],
  },
  {
    key: 'support.issue',
    stage: 17,
    name: 'Support — acknowledge, fix, confirm',
    description: 'Issue opened. Done when the Issue is resolved or closed.',
    ownerRole: 'support',
    levels: [
      { level: 1, offsetMinutes: 0, audience: 'owner', message: 'New support issue {{name}} from {{customer_name}}: {{subject}}' },
      { level: 2, offsetMinutes: 0, audience: 'customer', templateKey: 'support_ack', message: 'Hi {{customer_name}}, we received your request ({{name}}) and are working on it.' },
      { level: 3, offsetMinutes: 4 * H, audience: 'owner', message: 'Issue {{name}} ({{customer_name}}) is open for 4 hours.' },
      { level: 4, offsetMinutes: 1 * D, audience: 'escalation', message: 'Issue {{name}} for {{customer_name}} is unresolved after 24 hours.' },
    ],
  },
  {
    key: 'support.resolved',
    stage: 17,
    name: 'Support — confirm with the customer',
    description: 'Issue resolved: ask the customer to confirm.',
    ownerRole: 'support',
    levels: [{ level: 1, offsetMinutes: 0, audience: 'customer', templateKey: 'support_resolved', message: 'Hi {{customer_name}}, issue {{name}} is resolved. Reply if anything is still not working.' }],
  },
  {
    key: 'renewal',
    stage: 18,
    name: 'Renewal (30, 15, 7 days before, then invoice)',
    description: 'Anchored on the ERPNext Subscription end date. Done when renewed or cancelled.',
    ownerRole: 'accountant',
    escalationRole: 'management',
    levels: [
      { level: 1, offsetMinutes: -30 * D, audience: 'customer', templateKey: 'renewal_reminder', message: 'Hi {{customer_name}}, your NextAi plan renews on {{end_date}}.' },
      { level: 2, offsetMinutes: -30 * D, audience: 'owner', message: 'Renewal in 30 days: {{customer_name}} ({{name}}).' },
      { level: 3, offsetMinutes: -15 * D, audience: 'customer', templateKey: 'renewal_reminder', message: 'Hi {{customer_name}}, your NextAi plan renews in 15 days ({{end_date}}).' },
      { level: 4, offsetMinutes: -7 * D, audience: 'customer', templateKey: 'renewal_reminder', message: 'Hi {{customer_name}}, your NextAi plan renews in 7 days ({{end_date}}).' },
      { level: 5, offsetMinutes: -7 * D, audience: 'owner', message: 'Renewal in 7 days: {{customer_name}}. Prepare the renewal invoice.' },
      { level: 6, offsetMinutes: 0, audience: 'owner', message: 'Renewal date today for {{customer_name}}: raise the invoice.' },
    ],
  },
  {
    key: 'collection.overdue',
    stage: 19,
    name: 'Collection — reminders, then escalation',
    description: 'Overdue Sales Invoice. Done when paid.',
    ownerRole: 'collections',
    levels: [
      { level: 1, offsetMinutes: 3 * D, audience: 'customer', templateKey: 'payment_reminder', message: 'Hi {{customer_name}}, invoice {{name}} for {{amount}} is overdue since {{due_date}}.' },
      { level: 2, offsetMinutes: 3 * D, audience: 'owner', message: 'Invoice {{name}} ({{customer_name}}, {{amount}}) is 3 days overdue. Please call.' },
      { level: 3, offsetMinutes: 7 * D, audience: 'customer', templateKey: 'payment_reminder', message: 'Hi {{customer_name}}, a reminder that invoice {{name}} for {{amount}} is still unpaid.' },
      { level: 4, offsetMinutes: 15 * D, audience: 'escalation', message: 'Escalation: invoice {{name}} ({{customer_name}}, {{amount}}) is 15 days overdue.' },
      { level: 5, offsetMinutes: 30 * D, audience: 'management', message: 'Invoice {{name}} ({{customer_name}}, {{amount}}) is 30 days overdue. Decide on service hold.' },
    ],
  },
];
