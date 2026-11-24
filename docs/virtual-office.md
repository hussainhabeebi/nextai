# Virtual office

The team runs its day from WhatsApp on a **separate staff number**, and the business owner runs it from the business app: **Team → Office** (sidebar, or **More** on a phone).
It belongs to each business, not to the NextAi admin console: the owner manages it, the business's accountant can view it, staff
use it only through WhatsApp.
It sits on top of the lead-to-customer lifecycle ([lifecycle.md](lifecycle.md)) and uses the same staff list.

## Set-up

1. **NextAi support (admin console):** connect a second WhatsApp number to Chatwoot as its own inbox, with the same Agent
   Bot webhook URL as the customer inbox, then enter its inbox id under **Admin → Tenants → the business → Staff WhatsApp
   number**. This stays with support, like the customer inbox, so a business can't claim an inbox it doesn't own.
2. **Business owner, Team → Office → Settings:**
   - Set office hours and work days, and choose which features are on. The page shows whether the staff number is connected.
   - Set each person's **backup** for leave, and their **ERPNext Employee** id if attendance should sync.
3. **Business owner, Team → Sales pipeline → Staff:** every team member needs their WhatsApp number and roles. Give `management` to whoever
   approves requests and receives summaries.
4. **NextAi support, Admin → Templates:** map `office_notice` (one `message` param) to an approved WhatsApp utility template. Messages the
   office sends first (nudges, reminders, approvals) need it once the 24-hour window has passed.

Once a staff number is set, **all staff notifications** go out from it: lifecycle reminders, escalations, the morning digest
and health alerts. Customers keep getting messages from the customer number. Without a staff number, everything keeps using
the customer number as before.

## WhatsApp commands (staff number)

| Message | What happens |
|---|---|
| `in` / `good morning` (optional note, e.g. `in at client site`) | Check-in (marked late after start + grace). Replies with the person's open work and asks for today's plan. |
| *(plan text, `blocker: …`)* | Saved as the day's stand-up. Blockers are sent straight to management. |
| `out` | Check-out with hours worked, then asks what got done. A `handover Esha: …` line is forwarded to Esha. |
| `busy on call` / `back` | Presence shown on the office floor. |
| `who is in` | Team presence. |
| `tasks` / `overdue` | Numbered list of their lifecycle steps and ERPNext Tasks assigned to them. |
| `done 2 <note>` | Closes item 2: the lifecycle step, or marks the ERPNext Task Completed, and logs a comment. |
| `status <customer>` | Project stage, health score and open steps with owners. |
| `move <customer> to <stage>` | Sets the Project stage (Kickoff … Live …). Moving to Live starts the go-live and review steps. |
| `leave tomorrow` / `leave 25/12 to 27/12 <reason>` | Leave request → approval to management. Once approved, the person's reminders go to their backup. |
| `request discount 15% for Noor` | Approval request (discount / refund / expense / other) to management. |
| `approvals` · `approve 12` · `reject 12 <reason>` | Decide on WhatsApp. The requester is told the result. |
| `announce [sales]: <text>` (management only) | Broadcast to everyone or to roles. Staff reply `OK` to acknowledge. |
| `meet Esha Akshay tomorrow 3pm for 45m <title>` | Meeting with notifications, an ERPNext Event, and a reminder before it starts. |
| `notes 5: … \n- Esha: update menu by friday` | Meeting notes. Lines starting with `-` become ERPNext Tasks, assigned to the person named at the start of the line. |
| `handover Esha: <note>` | Forwards the note to Esha. |
| anything else | The AI answers from the person's own work, meetings and the command list. |

## Automatic (every 5 minutes, `office.tick`)

| When (tenant local time) | Action |
|---|---|
| First tick of the day | Presence reset: 🌴 for people on approved leave, *out* for everyone else. |
| Work start + grace | Nudges everyone who hasn't checked in. Management gets the list of who's missing and who's on leave. |
| End of day | Asks anyone still checked in to check out and share what they finished. |
| End of day + 1 h | AI team summary to management: attendance, what got done, blockers, risks. |
| Meeting − reminder minutes | Reminder to all attendees. |
| Meeting end | Asks the organizer for notes. Their next message is saved as the notes. |
| Weekly report day/hour | Per-person performance to management: attendance, late days, steps done and % on time, escalations, deals won, issues fixed. |

Each daily action runs **once per day**. If the worker was down, an action only fires within 2 hours of its scheduled
time, so nobody gets stale nudges late in the day.

## Team → Office (business app)

| Tab | Shows |
|---|---|
| **Floor** | One live card per person (presence, check-in, plan, blockers, open and escalated steps, next meeting), plus office totals, today's meetings, customers at risk and announcement read counts. Refreshes every 30 s. **TV mode** shows it full screen. |
| **Attendance** | Check-ins and outs, hours and late marks for the period; leave. |
| **Stand-ups** | Each person's plan, blockers, what got done and handovers, by date. |
| **Approvals** | Approve or reject from the console. The decision goes back to the requester on WhatsApp. |
| **Announcements** | Send to everyone or to roles; see who has acknowledged and who hasn't. |
| **Meetings** | Meetings with their notes and the tasks they produced. |
| **Performance** | Per-person numbers for 7–90 days. |
| **Settings** | Staff number, hours, work days, features, backups and ERPNext employees. |

## Data

New tenant-owned tables, all with RLS: `attendance`, `standups`, `leave_requests`, `announcements`, `approvals`, `meetings`.
`staff_members` gains `presence`, `backup_staff_id` and `erp_employee`. `tenants` gains `cw_staff_inbox_id`.

## Limits

- Check-in doesn't capture GPS location. Add it as a note instead, e.g. `in at client site`.
- With *ERPNext attendance sync* on, an ERPNext Attendance record (*Present*) is created at check-out. Approved leave is
  **not** created as an ERPNext Leave Application.
- The team bot replies in English. Commands are short English keywords; the AI fallback understands free text.
