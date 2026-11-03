# Deploying WordForge

The app is one container plus a PostgreSQL database. Two things to remember on any host:

1. **WebSockets must work** (rooms use them) and **run exactly one app instance**, because rooms and rate limits live in memory.
2. **Set `JWT_SECRET`.** With `NODE_ENV=production` (already set in the Dockerfile) the server refuses to start without it.

Prices and free tiers change, so check your provider's pricing page before you create anything.

## Environment variables

| Variable | Needed | Meaning |
|---|---|---|
| `JWT_SECRET` | yes | Long random string. Make one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_URL` | yes in production | `postgres://user:password@host:5432/dbname` (add `?sslmode=require` for managed databases) |
| `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | for AI | Without a key the game still works with the built-in words |
| `AI_MODEL` | optional | Override the model name (needed for OpenAI) |
| `TRUST_PROXY` | behind a proxy | Set to `1` so rate limiting sees real client IPs |
| `PORT` | automatic | Cloud hosts set it; the app reads it |
| `PGSSL` | optional | Set to `1` if your database needs TLS and the URL has no `sslmode` |

Never commit real keys. Put them in the host's secret manager or environment settings.

## 1. Try the production setup on your computer

```bash
docker compose up --build
# open http://localhost:3000
```

This starts the app and PostgreSQL together. **Do this once before any cloud deploy:** it is also the quickest way to confirm that the PostgreSQL path works on your machine. Put `JWT_SECRET=...` and an AI key in a `.env` file next to `docker-compose.yml` to use them.

## 2. Google Cloud Run (recommended: WebSockets work)

You need a Google Cloud project with billing enabled and the [gcloud CLI](https://cloud.google.com/sdk/docs/install).

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# from the project folder (the one with the Dockerfile)
gcloud run deploy wordforge \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --max-instances 1 \
  --timeout 3600 \
  --set-env-vars "TRUST_PROXY=1,JWT_SECRET=PASTE_SECRET,DATABASE_URL=PASTE_URL,GEMINI_API_KEY=PASTE_KEY"
```

The command prints the public `https://…run.app` URL. That is your "deployed link".

- `--max-instances 1` keeps all rooms on one instance.
- `--timeout 3600` lets a WebSocket stay open for up to an hour.
- With the default of zero minimum instances the instance sleeps when idle and rooms disappear. For a demo day add `--min-instances 1` (this costs money while it runs).
- For real secrets use Secret Manager (`--set-secrets JWT_SECRET=jwt-secret:latest`) instead of `--set-env-vars`.

**The database, choose one:**

- **External PostgreSQL** such as Neon or Supabase (both have free tiers at the time of writing): create a database, copy its connection string (it ends with `?sslmode=require`) into `DATABASE_URL`. This is the least work.
- **Cloud SQL for PostgreSQL**: create an instance, a database and a user, then add `--add-cloudsql-instances PROJECT:REGION:INSTANCE` to the deploy command and use
  `DATABASE_URL=postgres://USER:PASSWORD@/DBNAME?host=/cloudsql/PROJECT:REGION:INSTANCE`.
  Cloud SQL is not free; check the price first.

The server creates all tables on first start, so there is no migration step.

## 3. AWS

**AWS App Runner does not support WebSockets** (as of the sources checked while writing this), so rooms would not work there. Use one of these:

### Simplest: one EC2 virtual machine with Docker Compose

1. In the EC2 console launch an Ubuntu instance (a small one is enough). In its security group allow inbound **22** (SSH, from your IP) and **80** (HTTP, from anywhere).
2. Connect over SSH and install Docker: `curl -fsSL https://get.docker.com | sh`
3. Copy the project to the machine (`git clone …` or `scp`).
4. Create a `.env` file in the project folder:
   ```
   JWT_SECRET=PASTE_SECRET
   GEMINI_API_KEY=PASTE_KEY
   ```
5. In `docker-compose.yml` change the app's port mapping from `"3000:3000"` to `"80:3000"`.
6. Run `sudo docker compose up -d --build`.
7. Open `http://EC2_PUBLIC_IP`. Check logs with `sudo docker compose logs -f app`.

This runs PostgreSQL in a container on the same machine, which is fine for a course project. To use **Amazon RDS** instead, create an RDS PostgreSQL instance in the same VPC, allow port 5432 from the EC2 security group, set `DATABASE_URL=postgres://…?sslmode=require` in `.env` and remove the `db` service from the compose file.

HTTPS is optional for a demo. If you add it (for example Caddy or an Application Load Balancer with a certificate), the page automatically switches its WebSocket to `wss://`.

### Managed: ECS Fargate behind an Application Load Balancer

Push the image to ECR, create a Fargate service with **desired count 1** behind an ALB (the ALB supports WebSockets; raise its idle timeout above the default 60 s if you want long rooms), set the environment variables in the task definition and point `DATABASE_URL` at RDS. More steps, more cost, same app.

## 4. After the deploy: quick check

1. `https://YOUR_URL/healthz` shows `{"ok":true}`.
2. Register, start a game, finish it. Check the badge, XP and the leaderboard.
3. Open the same site on a phone and your laptop, create a room on one and join with the code on the other.
4. Play the daily word.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Container exits with `JWT_SECRET must be set in production` | Set `JWT_SECRET` |
| `no pg_hba.conf entry` or SSL errors | Add `?sslmode=require` to `DATABASE_URL`, or set `PGSSL=1` |
| `model not found` in the log | Set `AI_MODEL` to a current model name from your provider's docs |
| AI is on but every theme falls back to general words | Look in the log for `[ai] word generation failed`: usually a wrong key, a wrong model name or a hit rate limit. The game keeps working meanwhile. |
| Rooms say "No room with that code" | The app restarted or runs more than one instance. Use a single instance. |
| Rooms never connect | The host or proxy blocks WebSockets (App Runner, some corporate proxies). Use Cloud Run, EC2 or ECS+ALB. |
| Everyone gets "Too many requests" | Set `TRUST_PROXY=1` when running behind a load balancer |
