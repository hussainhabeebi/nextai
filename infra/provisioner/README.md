# NextAi provisioner

Internal service on the ERPNext host. Runs **only** whitelisted `bench` operations against the
`nextai` Docker Compose project (`docker compose -p nextai exec backend bench ...`) via `execFile`
(no shell). Every request is HMAC-signed (`x-timestamp`, `x-signature = hex(HMAC-SHA256(secret, "<ts>.<body>"))`),
rejected if older than 5 minutes or replayed. One operation runs at a time.

| op | command |
|---|---|
| `new-site` | `bench new-site <site> --admin-password *** --db-root-password *** --install-app erpnext` |
| `install-app` | `bench --site <site> install-app erpnext\|india_compliance` |
| `enable-scheduler` | `bench --site <site> enable-scheduler` |
| `set-config` | `bench --site <site> set-config host_name\|maintenance_mode\|pause_scheduler <value>` |
| `create-api-user` | `bench --site <site> execute nextai_provisioning.create_api_user` (ships in `frappe_app/`) |
| `backup` | `bench --site <site> backup --with-files` |

Run (binds to 127.0.0.1 by default; set `PROVISIONER_HOST` to the private-network IP if core runs elsewhere):

```bash
docker build -t nextai-provisioner infra/provisioner
docker run -d --name nextai-provisioner --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e PROVISIONER_SECRET=... -e DB_ROOT_PASSWORD=... nextai-provisioner
```

Install the helper module into the bench image: copy `frappe_app/nextai_provisioning` onto the
Python path of the `backend` container (e.g. `apps/frappe/frappe/../nextai_provisioning`).
