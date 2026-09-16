# Student-Teacher Portal — AWS ECS Deployment (Dev)

A three-tier app (React frontend, Node/Express backend, MySQL RDS) deployed on AWS ECS Fargate, behind an Application Load Balancer, with Docker images built and pushed via GitHub Actions.

## Architecture

```
Internet
   │
   ▼
Application Load Balancer (HTTP :80)
   ├── /  ──────────────► Frontend target group ──► ECS service (frontend-td) ── nginx :80
   └── /api, /health etc ► Backend target group  ──► ECS service (backend-TD)  ── node :3500
                                                              │
                                                              ▼
                                                     SSM Parameter Store
                                                     (/myapp/db/host, user,
                                                      password, name)
                                                              │
                                                              ▼
                                                        RDS MySQL (private)

GitHub Actions ──build & push──► ECR (backend-image, frontend-image)
```

## What was built

### 1. Networking
- VPC created via the AWS Console wizard (VPC + more): 2 public subnets, 2 private subnets, 1 Internet Gateway, 1 NAT Gateway.
- DB subnet group created using the private subnets, for RDS.

### 2. Database
- RDS MySQL instance created (next → next → create), credentials/host/db-name captured.
- All connection values (`host`, `user`, `password`, `database`) stored as **SSM Parameter Store** entries under `/myapp/db/*`, matching what `backend/server.js` reads via `GetParametersCommand`.

### 3. Container registry
- Two ECR repositories created: `backend-image`, `frontend-image`.

### 4. CI/CD (GitHub Actions)
- Two workflows, both `workflow_dispatch` (manual trigger):
  - `Backend Build & Push` — builds `backend/Dockerfile`, pushes to ECR, tagged `${{ github.run_number }}`.
  - `Frontend Build & Push` — builds `frontend/Dockerfile`, pushes to ECR, with `REACT_APP_API_BASE_URL` passed as a build arg from a GitHub secret.
- AWS credentials stored as **environment-scoped** secrets (`development` environment) — workflows reference `environment: development` so the job can read them.
- IAM CI user permissions: `AmazonEC2ContainerRegistryPowerUser` (ECR push) + `AmazonECS_FullAccess` (temporary, see "Known gaps" below).

### 5. Compute (ECS)
- Backend first:
  - ECS cluster created.
  - Task definition `backend-TD`, container port 3500, **Task role** set to `ecsTaskExecutionRole` with `AmazonSSMFullAccess` attached (temporary, see below) so the app can call SSM at runtime.
  - Load balancer + target group (`ecs-backend-TG`, port 3500) created during service setup, HTTP listener only.
  - Service launched with a public IP on the task (dev-only shortcut).
  - Verified via CloudWatch logs: `✅ Database verified` → `✅ Connected to MySQL` → `🚀 Server running on port 3500`.
- Frontend second, same pattern: new task definition, service, target group, port 80, using the backend ALB URL as `REACT_APP_API_BASE_URL` in the GitHub secret for the frontend build.

## How to verify it's working

| Check | Where |
|---|---|
| Backend reachable | `http://<alb-dns>/health` → `{"status":"ok",...}` |
| DB connectivity | `http://<alb-dns>/health/db` → `{"database":"connected",...}` |
| Frontend reachable | `http://<alb-dns>/` → React app loads |
| Target group health | EC2 → Target Groups → each TG's **Targets** tab shows `healthy` |
| Task logs | ECS → cluster → service → Tasks → task → Containers → Logs |

## Issues hit during setup (and the fix)

| Symptom | Root cause | Fix |
|---|---|---|
| `Could not load credentials from any providers` (local Docker) | `server.js` calls AWS SSM at boot; no AWS credentials available in a plain local container | For local dev, swapped to a plain env-var `getDBConfig()` reading `host`/`user`/`password`/`database` from `docker-compose.yaml`. AWS/ECS deployment keeps the original SSM-based `server.js`. |
| `AccessDeniedException: ... not authorized to perform ssm:GetParameters` (ECS) | Permission was attached to the **execution role**, but the running app calls SSM using the **Task role** — two separate fields on the task definition | Set the task definition's **Task role** (not just Task execution role) to a role with SSM read access, created a new task definition revision, force-deployed the service |
| Backend task stuck in a register → drain → deregister loop | Task was crashing (`exit code 1`) right after boot from the SSM error above, so ECS kept replacing it | Same fix as above — once the task stopped crashing, it passed the target group health check and stabilized |

## Known gaps / recommended hardening

These work for a dev/demo environment but should be tightened before anything resembling production:

1. **IAM is over-permissioned.**
   - CI user has `AmazonECS_FullAccess` — only needed once an ECS deploy step is added to the workflows, and even then should be a scoped custom policy (`ecs:UpdateService`, `ecs:DescribeServices`, `ecs:RegisterTaskDefinition`, `iam:PassRole` on specific role ARNs only).
   - Task role has `AmazonSSMFullAccess` — should be scoped to `ssm:GetParameters`/`GetParameter` on `arn:aws:ssm:<region>:<account>:parameter/myapp/db/*` only (plus `kms:Decrypt` if parameters are `SecureString`).
2. **Backend and frontend tasks have public IPs.** Only the ALB should be internet-facing. Tasks should run in the **private subnets** with no public IP, reachable only via the ALB's security group rule. RDS should already be private — confirm its security group only allows inbound 3306 from the ECS tasks' security group, not `0.0.0.0/0`.
3. **No HTTPS.** ALB currently has an HTTP-only listener. Add an ACM certificate and an HTTPS listener (443) with HTTP→HTTPS redirect before sharing this outside a dev/test audience.
4. **CI/CD is push-only, manually triggered.** No automatic trigger on `git push`, and no step that actually redeploys ECS after a new image is pushed (currently done manually via "Force new deployment" in the console). Next iteration: trigger on push to `main` with a path filter, and add an `aws ecs update-service --force-new-deployment` (or task-definition-revision) step.
5. **Static IAM user keys in GitHub Secrets.** Consider migrating to GitHub OIDC federation (`aws-actions/configure-aws-credentials` with `role-to-assume`) so no long-lived AWS keys are stored in the repo at all.

## Suggested next steps

1. Move ECS tasks into private subnets; keep only the ALB public.
2. Scope down the two IAM policies (CI user + task role) to least privilege.
3. Add an automatic trigger + ECS deploy step to both GitHub Actions workflows.
4. Add an HTTPS listener with an ACM cert.
5. Move from manual console changes to Infrastructure-as-Code (Terraform or CloudFormation) once the manual version is stable, so the whole environment can be rebuilt/torn down reliably.
