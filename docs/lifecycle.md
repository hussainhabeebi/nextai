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
| Reminder configuration | Per business, by its owner, in the business app under **Team → Sales pipeline**: every rule and every level can be switched on/off, re-timed, re-targeted, reworded, added or deleted |

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

Business app → **Team → Sales pipeline** (owner; the accountant can view):

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

## Customer replies on WhatsApp

A message from a number that is not an app user, on a tenant with a playbook, is matched to that customer's open step
(by `customerPhone`) before the usual "unknown number" reply:

| Open step | What happens |
|---|---|
| `kickoff.data` | Files are stored (R2) and attached to the Project, and the message is logged as a Comment. The AI (`llm.checkItems`) ticks off the tenant's **data checklist** and replies with what is still missing. The chase restarts from the reply. When everything is in, the step closes and the owner is told to move the project to Build. |
| `bot.monthly_update` | Files and text go to the Project. A **"Monthly bot update" Task** (due in 3 days) is created and assigned to the AI manager, who gets notified along with QA (Akshay, the rule's escalation role). The step closes, and the new Task gets its own `task.due` reminders. |
| `support.issue` (open) | The message is added as a Comment on the Issue and support is notified. |
| `support.resolved` (sent in the last 7 days) | "Still not working"-style replies **re-open the Issue**: it goes back to Open and the support reminders and escalation run again from now. Anything else is logged as the customer's confirmation. |
| `review.day7` / `review.day30` (sent in the last 7 days) | The reply is logged on the Project as feedback and QA is notified. |
| none | If `autoIssueFromWhatsApp` is on and the number belongs to an ERPNext Customer, the message is added as a Comment to their open Issue, or a new Issue is created (its `support.issue` step acknowledges the customer). |

## Health score (day 7 / day 30)

Before a review reminder is sent, NextAi scores the project out of 100:

- −10 per open Issue (max −30)
- −20 per overdue unpaid invoice (max −40)
- −5 per overdue open Task (max −20)
- −5 per lifecycle step that reached escalation in the last 30 days (max −20)

The score is written to the Project (`custom_health_score`) and shown in the reminder (`{{health_score}}`, `{{health_reasons}}`).
Management is alerted when it is below the tenant's threshold.

## Staff digest

At the tenant's digest hour (default 09:00 local), each active staff member gets one WhatsApp message listing their open steps:
🔴 escalated, 🟠 reminded but still open, 🟡 coming up in the next 24 hours. It is sent once per day, and only to people who
have something on the list. Template key: `lifecycle_digest` (one `message` param).

## Report (Team → Sales pipeline → Report)

For the last 7 / 30 / 90 / 365 days:

- **Funnel:** leads → demos → proposals → won → paid → live, with the conversion from each stage to the next.
- **Lead sources.**
- **Escalated and still open:** the current overdue list.
- **People:** open, escalated and done per owner.
- **Stages:** started, done, cancelled, open and escalation rate per stage.

## Settings (Team → Sales pipeline → Setup)

| Setting | Default |
|---|---|
| Morning digest on, and its hour | on, 09:00 |
| Health-score alert threshold | 60 |
| Onboarding data checklist | Product list, Prices, FAQs, Logo, Business hours |
| WhatsApp → Issue for known customers | on |

## Leadvyne

Leadvyne's payload format is not publicly documented, so `POST /webhooks/leadvyne/<slug>` accepts common variants:

- **Field layout:** flat, or nested under `lead` / `data`.
- **Field names:**
  - name: `name`, `full_name`, `lead_name`, or `first_name` + `last_name`
  - phone: `phone`, `mobile`, `phone_number`, `whatsapp`
  - email: `email`, `email_id`
  - source: `source`, `lead_source`, `platform`, `channel`
  - campaign: `campaign`, `campaign_name`, `utm_campaign`, `ad_name`, `form_name`
  - company: `company`, `company_name`
  - message: `message`, `notes`, `comments`
  - id: `id`, `lead_id`, `leadgen_id`
- **Authentication:**
  - signature header `X-Leadvyne-Signature`, `X-Signature` or `X-Hub-Signature-256`, as hex HMAC-SHA256 of the body (`sha256=` prefix optional);
  - or `?token=<secret>` when Leadvyne cannot sign.

Send one test lead from Leadvyne and check that it appears in ERPNext. If its field names differ, add them to
`normalizeLeadPayload` in `apps/core/src/routes/webhooks/leadvyne.ts`.

## Extra ERPNext setup for these features

- Project: custom field `custom_health_score` (Int).
- WhatsApp templates: `lifecycle_digest` (one `message` param).
