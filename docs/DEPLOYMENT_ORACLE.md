# Deploying to the Oracle VM

The runbook for `VM.Standard.E2.1.Micro` — 1 OCPU, 1 GB RAM, x86, Ubuntu 24.04,
`eu-frankfurt-1`. [`DEPLOYMENT.md`](DEPLOYMENT.md) covers what is deployed and
what is broken; this covers how to get it there.

```text
Internet
   │
   ▼
Cloudflare ─────── TLS terminated, DDoS, cache, WAF
   │  Full (strict), so the hop below is encrypted too
   ▼
Oracle VM (1 GB)
   ├── edge      nginx, ports 80/443, Origin Certificate
   ├── backend   API + all workers, one Node process
   └── redis     queues, AOF, 100 MB cap
   │
   ├──▶ Supabase   Postgres
   └──▶ Brevo      email

Vercel serves the web app and is not involved in any of the above.
```

Three containers, about **580 MB** of limits against the ~970 MB the OS leaves
free. The API was measured at 189 MiB idle and 205 MiB while serving twenty
concurrent PDF renders, so those limits are headroom rather than a target.

---

## One-time setup

### 1. Swap, before anything else

Oracle's Ubuntu images ship with none. On 1 GB that means the kernel's only
response to a memory spike is to kill something, and the biggest process is the
API.

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Prefer RAM; use swap as a safety net, not as working memory.
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

free -h        # confirm 2.0Gi of swap
```

### 2. Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker           # or log out and back in
docker --version
```

### 3. Open the firewall — **both** of them

This is the step that catches almost everyone on Oracle. There are two
independent firewalls and opening one is not enough.

**The VCN security list** (Oracle console → Networking → your VCN → Security
Lists → default): add ingress rules for TCP **80** and **443** from
`0.0.0.0/0`.

**The instance's own iptables.** Oracle's Ubuntu images ship with a restrictive
INPUT chain that rejects everything except SSH. Even with the security list
open, traffic is dropped here:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save          # or: apt install iptables-persistent
```

If the site is unreachable and everything else looks right, it is almost always
this. Listing the chain with
`sudo iptables -L INPUT -n --line-numbers` shows whether the ACCEPT rules sit
*above* the catch-all REJECT.

### 4. Cloudflare

**DNS** — an `A` record for `api.<your-domain>` pointing at `130.162.43.168`,
**proxied** (orange cloud). Proxying is what puts Cloudflare in front; grey
cloud exposes the VM directly and none of the protection applies.

**Origin certificate** — SSL/TLS → Origin Server → Create Certificate. Take the
defaults (RSA, 15 years). You are shown the certificate and key **once**.

```bash
mkdir -p ~/vitals-backend/deploy/certs
# paste the certificate into origin.pem and the key into origin.key
chmod 600 ~/vitals-backend/deploy/certs/origin.key
```

**SSL mode** — SSL/TLS → Overview → **Full (strict)**. Anything less makes the
certificate pointless; "Flexible" in particular leaves the hop to your VM in
plain text.

### 5. Get the deployment files onto the VM

The VM never builds, but it does need the compose file, the nginx config and
your environment. Cloning is simplest, because updating is then `git pull`:

```bash
git clone https://github.com/Ige-Joseph/vitals-backend.git ~/vitals-backend
cd ~/vitals-backend
```

### 6. `.env.production`

Never committed. Copy `.env.example` and fill it in, with three things worth
getting right:

```bash
# Supabase — the POOLER on 6543, not the direct connection.
# Prisma opens a pool per instance and Supabase's direct connection limit is
# small; pgbouncer in transaction mode plus connection_limit=1 is what keeps
# this from exhausting it under any real concurrency.
DATABASE_URL="postgresql://…@…pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"

# Migrations need a real session, so they use the direct connection on 5432.
DIRECT_URL="postgresql://…@…supabase.com:5432/postgres"

# Where the browser actually is. Auth requests carry X-Auth-Transport: cookie
# and the backend refuses any whose Origin is not listed here — get this wrong
# and login answers 403 with nothing obviously broken.
FRONTEND_URL="https://your-app.vercel.app"
CORS_ORIGIN="https://your-app.vercel.app"
API_URL="https://api.your-domain.com"
```

> **Check your Supabase region.** The VM is in Frankfurt. A Supabase project in
> a US region puts the Atlantic between the API and its database, on every
> query, and a single request makes several. Matching regions is free latency.

### 7. Let the VM pull the image

Simplest is to make the GHCR package public: GitHub → Packages →
`vitals-backend` → Package settings → Change visibility.

If you would rather keep it private, create a token with `read:packages` and:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u Ige-Joseph --password-stdin
```

---

## First deploy

```bash
cd ~/vitals-backend
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml logs -f backend
```

Migrations run automatically when the container starts. Watch for
`migrations found` and `Server running`, then `Worker process started`.

### Verify, in this order

```bash
# 1. the API is alive inside the box
docker compose -f docker-compose.prod.yml exec backend \
  wget -qO- http://127.0.0.1:3000/api/v1/health

# 2. nginx is terminating TLS and proxying
curl -sk https://localhost/api/v1/health

# 3. it works from outside, through Cloudflare
curl -s https://api.your-domain.com/api/v1/health

# 4. the workers are running — without these, reminders never fire and
#    rendered reports are never deleted
docker compose -f docker-compose.prod.yml logs backend | grep -i "scheduled jobs"

# 5. memory, against the limits
docker stats --no-stream
free -h
```

Expect `"status":"healthy"` with `database` and `redis` both `ok`, and the
scheduled-jobs line listing `reminder-engine`, `outbox-poller`,
`appointment-sweep` and `report-sweep`.

---

## Updating

CI publishes a new image on every green build of `main`. On the VM:

```bash
cd ~/vitals-backend
git pull                                             # compose/nginx changes
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
docker image prune -f                                # reclaim the old layers
```

There is a few seconds of downtime while the container restarts. On one
instance that is unavoidable without a second machine.

### Rolling back

Every build is also tagged with its commit sha. Pin it:

```bash
# in docker-compose.prod.yml, replace :latest
image: ghcr.io/ige-joseph/vitals-backend:sha-<full-commit-sha>

docker compose -f docker-compose.prod.yml up -d
```

**Migrations do not roll back with the image.** Each migration header carries
its own rollback SQL — read it before rolling back across one, because an image
that predates a migration may not understand the schema it finds.

---

## Operating it

```bash
# logs (rotated at 10 MB × 3 by the compose file, so they cannot fill the disk)
docker compose -f docker-compose.prod.yml logs -f --tail=100 backend

# is Redis near its cap? BullMQ holds scheduled work here, so this is not a cache
docker compose -f docker-compose.prod.yml exec redis \
  redis-cli info memory | grep -E "used_memory_human|maxmemory_human"

# queue depth
docker compose -f docker-compose.prod.yml exec redis redis-cli keys "bull:*" | wc -l

# are report documents being swept?
docker compose -f docker-compose.prod.yml exec backend ls -la /tmp/vitals-reports
```

### What to watch, in order of likelihood

**Memory.** `docker stats` against the limits. The API sat at 189–205 MiB under
test; sustained growth toward 400 MB means a leak, not load.

**Redis approaching 100 MB.** It is configured `noeviction`, so it will start
refusing writes rather than silently dropping queued jobs. Refusing writes is
loud and recoverable; dropping a reminder is neither. If it gets close, the
question is why jobs are accumulating, not whether to raise the cap.

**Report files accumulating in `/tmp/vitals-reports`.** They are deleted about
an hour after rendering by a sweep that runs *inside the worker*. Files piling
up means the worker is not running, which also means reminders are not firing.

**Swap in active use.** `free -h` showing swap consistently used is the signal
that 1 GB has stopped being enough.

---

## Once this is live

**Rotate the Upstash credential.** Redis now runs on the VM and the old managed
instance is unused, but the credential in your history still works until you
revoke it.

**Consider Cloudflare Authenticated Origin Pulls.** With it, nginx will only
accept connections presenting Cloudflare's client certificate, so someone who
discovers the instance IP cannot bypass Cloudflare by talking to it directly.

**One instance means a reboot is downtime.** For a few hundred users that is
usually an acceptable trade — it is worth choosing deliberately rather than
discovering during an Oracle maintenance window.
