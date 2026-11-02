"""Tiny Frappe module installed into the bench image; called by the provisioner via
`bench --site <site> execute nextai_provisioning.create_api_user --kwargs '{"email": ...}'`."""
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
