# Quadlet units

Podman's systemd generator turns these files into services, so a single host can
run ReadFlow without compose:

```bash
mkdir -p ~/.config/containers/systemd ~/.config/readflow
cp deploy/quadlet/*.container deploy/quadlet/*.service deploy/quadlet/*.timer \
   ~/.config/containers/systemd/

cat > ~/.config/readflow/readflow.env <<'ENV'
POSTGRES_USER=readflow
POSTGRES_PASSWORD=change-me
POSTGRES_DB=readflow
DATABASE_URL=postgresql+psycopg://readflow:change-me@127.0.0.1:5432/readflow
READFLOW_COOKIE_SECURE=auto
BACKUP_DIR=/srv/readflow/backups
BACKUP_RETENTION=14
ENV
chmod 600 ~/.config/readflow/readflow.env

systemctl --user daemon-reload
systemctl --user enable --now readflow-pg.service readflow-api.service readflow-web.service
systemctl --user enable --now readflow-backup.timer
```

Notes:

- The API runs its migrations on start (`server/docker-entrypoint.sh`), so the
  first boot creates the schema. Create the first account at `/setup`.
- `readflow-api.container` publishes only to loopback; `readflow-web` is the
  public entry point (change its `PublishPort` to expose it on the LAN).
- The GPU device line requires the NVIDIA Container Toolkit **and** a fresh CDI
  spec (`sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`). Drop it
  and use the `-cpu` image on a machine without a GPU.
- `readflow-backup.service` uses `scripts/backup.sh --compose`, which dumps
  through the running `pg` container; set `WorkingDirectory` to this checkout.
- Restore with `pg_restore --clean --if-exists -d readflow <file>.dump` against a
  scratch database first if you are unsure.
