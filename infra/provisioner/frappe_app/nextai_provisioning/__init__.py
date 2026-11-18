"""Tiny Frappe module installed into the bench image; called by the provisioner via
`bench --site <site> execute nextai_provisioning.<function> --kwargs '{...}'`."""
import json

import frappe


def create_api_user(email: str):
    if not frappe.db.exists("User", email):
        user = frappe.get_doc({
            "doctype": "User",
            "email": email,
            "first_name": "NextAi Bot",
            "user_type": "System User",
            "send_welcome_email": 0,
            "roles": [{"role": r} for r in ("Accounts Manager", "Accounts User", "Sales User", "Purchase User", "Item Manager")],
        }).insert(ignore_permissions=True)
    else:
        user = frappe.get_doc("User", email)
    api_secret = frappe.generate_hash(length=15)
    if not user.api_key:
        user.api_key = frappe.generate_hash(length=15)
    user.api_secret = api_secret
    user.save(ignore_permissions=True)
    frappe.db.commit()
    print(json.dumps({"api_key": user.api_key, "api_secret": api_secret}))


def complete_setup(company_name: str, abbr: str, country: str, currency: str, timezone: str, fy_start: str, fy_end: str):
    """Run the ERPNext setup wizard non-interactively for a fresh NextAi site.

    Creates the company with the standard chart of accounts, the fiscal year, default accounts and the
    country's tax templates (UAE VAT; GST via India Compliance when installed). Idempotent: on a site whose
    setup is already complete it only reports the existing company.
    """
    from frappe.desk.page.setup_wizard.setup_wizard import setup_complete

    done = frappe.db.get_single_value("System Settings", "setup_complete")
    if not done:
        setup_complete({
            "language": "English",
            "country": country,
            "timezone": timezone,
            "currency": currency,
            "full_name": "NextAi",
            "company_name": company_name,
            "company_abbr": abbr,
            "chart_of_accounts": "Standard",
            "fy_start_date": fy_start,
            "fy_end_date": fy_end,
            "setup_demo": 0,
        })
        frappe.db.commit()
    company = frappe.db.get_value("Company", {"company_name": company_name}, ["name", "abbr"], as_dict=True) \
        or frappe.db.get_value("Company", {}, ["name", "abbr"], as_dict=True, order_by="creation asc")
    if not company:
        frappe.throw("Setup finished without a company")
    print(json.dumps({"company": company.name, "abbr": company.abbr, "setup": "already" if done else "completed"}))
