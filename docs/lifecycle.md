# Lead-to-customer lifecycle

NextAi runs the full lifecycle from lead to renewal on top of ERPNext:

- **ERPNext is the system of record** for every step: Lead, Opportunity, Event, Quotation, Sales Order, Sales Invoice, Payment Entry,
  Project (from the *Onboarding Template*), Task, Issue and Subscription.
- **NextAi orchestrates.** It turns ERPNext changes into *timers*, sends WhatsApp reminders to staff and customers at each
  *reminder level*, escalates late steps, and closes the timer when the step is done.

It is used on NextAi's own ("house") tenant and only acts for tenants that have a playbook installed. Customer businesses'
ERPNext sites are never touched.

## Decisions

| Topic | Decision |
|---|---|
| When the onboarding Project is created | After the **first payment** (Payment Entry, Receive, from a Customer with no Project yet) |
| Escalation manager | **Accountant** by default (configurable per rule). If the owner *is* the accountant, the escalation goes to management |
| Renewal source of truth | ERPNext **Subscription** (`end_date`, falling back to `current_invoice_end`) |
| Reminder configuration | Per tenant in **Admin → Lifecycle**: every rule and every level can be switched on/off, re-timed, re-targeted, reworded, added or deleted |

## Model

```
StaffMember     name, WhatsApp, ERPNext user, roles[] (sales, accountant, collections, onboarding, qa, support, ai_manager, management)
LifecycleRule   key, stage, owner role, escalation role, enabled
  ReminderLevel level, offset (minutes from the anchor, negative = before), audience (owner | escalation | customer | management),
                WhatsApp template key, message with {{placeholders}}, enabled
LifecycleTimer  rule × ERPNext document, anchor time, owner, customer name/phone, context, sentLevels[], status (open | done | cancelled)
```

All four tables are tenant-owned with RLS, like the rest of the schema.

- **`lifecycle.event`** (queue): fed by the ERPNext webhook and the Leadvyne webhook. It re-reads the document from ERPNext,
  then starts, re-anchors or closes timers.
- **`lifecycle.scan`** (every 5 min):
  - Sends each enabled level once when it is due. A level is claimed in `sentLevels` before it is sent, so it never goes out twice.
  - A level that is more than 24 h late when first seen is skipped instead of sent.
  - A timer closes itself once all its enabled levels are handled.
  - On the 1st of each month it starts the monthly bot-update timer for every Live project.

Owners are resolved in this order: the staff member whose ERPNext user owns or is assigned the document, otherwise round-robin
among active staff with the rule's owner role.

## Stage map (default playbook)

| # | Rule key | Starts when | Anchor | Done when | Owner |
|---|---|---|---|---|---|
| 1 | `lead.assign` | Lead created (Leadvyne → ERPNext) | creation | after level 1 | sales |
| 2 | `lead.first_call` | Lead created | creation (call within 1 h) | Lead status changes / Opportunity from the Lead | sales |
| 3 | `demo.reminder` | Event linked to an Opportunity | `starts_on` (24 h and 1 h before; customer + salesperson) | Event Completed / Cancelled | sales |
| 4 | `demo.outcome` | Event Completed | now (outcome within 2 h) | Opportunity `custom_demo_outcome` set | sales |
| 5 | `proposal.send` | Opportunity `sales_stage` ~ Proposal/Quotation | now (within 24 h) | Quotation submitted | accountant |
| 6 | `proposal.followup` | Quotation submitted | submit (days 2, 5, 10) | Quotation Ordered / Lost | accountant |
| 7 | `deal.won` | Sales Order submitted | now | after the notices | accountant |
| 8 | `invoice.due` | Sales Invoice submitted | `due_date` | outstanding = 0 | accountant |
| 9 | `handover.project` | **first payment** → Project from *Onboarding Template*, assigned to onboarding | now | after the notices | onboarding (Esha) |
| 10 | `kickoff.data` | Project created | now (customer chased days 1, 3; owner day 5; escalation day 7) | Project `custom_stage` past *Data Collection* | onboarding |
| 11–13 | `task.due` | Task with `exp_end_date` (setup, bot build, QA by Akshay, testing, training) | `exp_end_date` | Task Completed / Cancelled | assignee |
| 14 | `golive` | Project `custom_stage` = Live | now | after the notices | onboarding |
| 15 | `review.day7`, `review.day30` | Project Live | now (+7 d, +30 d) | after the notices | qa (Akshay) |
| 16 | `bot.monthly_update` | 1st of the month, every Live project | now | after the notices | ai_manager |
| 17 | `support.issue`, `support.resolved` | Issue opened / resolved | opening time / now | Issue Resolved / Closed | support (Habeeb, Esha) |
| 18 | `renewal` | Subscription with an end date | `end_date` (−30, −15, −7 days, then invoice) | Subscription Cancelled / Completed; a new end date re-arms it | accountant |
| 19 | `collection.overdue` | Sales Invoice submitted | `due_date` (+3, +7, +15 escalation, +30 management) | outstanding = 0 | collections (Majida) |

Message placeholders: `{{customer_name}} {{owner_name}} {{name}} {{lead_name}} {{source}} {{phone}} {{start_time}} {{amount}}
{{due_date}} {{project}} {{subject}} {{end_date}} {{month}}`.

When a WhatsApp template is mapped for a level's template key (Admin → Templates), its ordered params are filled from the same
variables; `message` holds the rendered text. Without a mapped template the rendered text is sent as plain text, which only
reaches customers inside the 24 h window.

## ERPNext site setup (house tenant)

1. **Custom fields**
   - Project: `custom_stage` (Select: Kickoff, Data Collection, Build, QA, Testing, Live, Hypercare).
   - Opportunity: `custom_demo_outcome` (Select or Data).
   - Lead: `custom_leadvyne_id` (Data).
2. **Project Template** named `Onboarding Template`, with tasks:
   - Kickoff, Data collection, Setup, Bot build, Quality check (Akshay), Customer testing, Training, Go live, Day-7 review, Day-30 review.
   - Use `depends_on` so the QA task waits for Bot build.
3. **Lead Sources**: `Advertisement`, `WhatsApp` and `Website` must exist.
4. **Webhooks** (one per doctype and event) to `https://api.nextaierp.com/webhooks/erpnext/<tenant-slug>`:
   - Doctypes: Lead, Opportunity, Event, Quotation, Sales Order, Sales Invoice, Payment Entry, Project, Task, Issue, Subscription.
   - Events: `after_insert`, `on_update`, `on_submit`, `on_cancel`.
   - Body: `{"doctype":"{{ doc.doctype }}","name":"{{ doc.name }}","event":"<event>","modified":"{{ doc.modified }}"}`.
   - Webhook Secret: the tenant's ERPNext webhook secret.
5. Turn off the generic invoice reminders for this tenant (`settings.reminders.enabled = false`) so customers don't get both
   those and the playbook's payment and collection reminders.

## NextAi admin setup

**Admin → Lifecycle**, then pick the tenant:

1. **Rules → Install default 19-stage playbook.**
2. **Staff:** add each person with their WhatsApp number, ERPNext user and roles. For example:
   - Salespeople: `sales`
   - Accountant: `accountant`
   - Majida: `collections`
   - Esha: `onboarding`, `support`
   - Akshay: `qa`
   - Habeeb: `support`
   - AI Manager: `ai_manager`
   - Management: `management`
3. **Setup → Generate secret** for Leadvyne. Configure Leadvyne to POST to the URL shown, with
   `X-Leadvyne-Signature: sha256=<hex HMAC-SHA256 of the raw body>`.
   - Payload: `{id, name, phone, email?, source?, campaign?, company?, message?}`.
   - The exact Leadvyne field names and signature header still need confirming (see `routes/webhooks/leadvyne.ts`).
4. **Templates:** map the template keys used by customer levels to approved WhatsApp templates:
   - `lifecycle_notice` (one `message` param, used for staff)
   - `demo_reminder`, `proposal_followup`, `payment_reminder`, `onboarding_welcome`, `data_request`, `golive`,
     `review_request`, `monthly_update`, `support_ack`, `support_resolved`, `renewal_reminder`

## Not built yet

- **AI data chasing:** customer replies with files are not yet attached to the Task. This needs an `onboarding_data` intent in
  the WhatsApp flow; today the reminders ask for the data and the owner collects it.
- **Health score:** no automatic score (usage, open issues, payment status) or management alert below a threshold yet.
- **Staff extras:** no 9 am staff digest and no `/admin/pipeline` funnel or overdue report yet.
- **Monthly update replies:** customer replies to the monthly bot update are not yet turned into product updates in ERPNext.
