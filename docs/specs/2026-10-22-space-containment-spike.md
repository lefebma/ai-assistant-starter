# SPACE containment against Havn's security suite: spike result

Card #225. Written 2026-10-22 (lab times below are UTC, 2026-10-23). Builds on
the #224 fit spike and the #218 containment matrix. All data synthetic, mock
destinations only, no real credentials on the lab host, host deleted at the end.

## Question

Does a SPACE execution adapter preserve Havn's externally enforced permissions
(roles #195, tool guard #194, audit log #196), and does it improve isolation?

## Answer

**Not answered on a live SPACE. Blocked at install.** SPACE's documented Kind
dev stack, at the pinned commit, did not come up on the lab host after two
bring-ups: the API never started because the database migration job could not
resolve the in-cluster Postgres service name. Every live result the card asks for
depends on a running API, so none of them exist: the baseline vs SPACE matrix,
guest/host and cross-sandbox separation, gateway credential scope, log leaks,
revocation, DNS and token confusion, and the overheads.

What was delivered without a live SPACE:

- **The adapter** (`src/assurance/space-adapter.ts`), behind the unchanged gate,
  unit-tested against a fake SPACE server and a fake guest. It shows that the
  integration *design* preserves the #195/#194/#196 controls. It does not show
  that SPACE's gateway enforces anything.
- **One real integration defect** found by those tests (defect 1 below).
- **A reproducible lab script and a live test**, ready for whoever retries.

**Release-gate recommendation: no-go, and do not schedule a retry yet.** #224
already recommended deferring adoption. This spike adds a further data point:
the only documented install did not complete on a clean Ubuntu 24.04 host
without debugging the project's own cluster networking. Retry only if SPACE
tags a release, or if #226 is still wanted (it needs the same stack).

## Reproducible config

| Item | Value |
|---|---|
| Host | GCE `space-lab-225`, project `havn-lab`, zone `us-east4-a`, Ubuntu 24.04 (`ubuntu-2404-lts-amd64`), kernel 7.0.0-1014-gcp |
| Shape | `n2-standard-8` (8 vCPU, 32 GB), 150 GB pd-balanced, nested virtualisation, `--max-run-duration=12h --instance-termination-action=DELETE` |
| `/dev/kvm` | Present: `crw-rw---- root kvm 10,232`. `vmx` flag on all 16 logical entries |
| SPACE | Commit `60437d062ab918100a7db7aa7c19d0c4ff765a91`, Firecracker 1.15.1, guest kernel 6.1.155 (sha256 `e20e46d0…f2`) |
| Install | SPACE's Kind path (`install-prereqs.sh`, `install-fc-vendor.sh`, `up.sh`), no AWS credentials, `SPACE_TILT_MAX_PARALLEL_UPDATES=2` |
| Script | `scripts/lab/space-lab-setup.sh` (run on the VM in tmux), then `scripts/lab/run-live.sh` for the live test |

**Why not the brief's `n2-standard-4` with a 50 GB disk.** SPACE's install doc
asks for at least 30 GiB free on Docker's data root *and* on `$HOME` (one disk
here). Each Kind node also needs a 40 GiB sparse btrfs cache, and the first
bring-up compiles the whole Rust workspace. 50 GB cannot hold that, and #224
sized the host at 8 vCPU / 32 GB. Peak disk use was 44 GB.

**Deviation from the #224 plan.** Ubuntu's `docker.io` has no buildx, and
SPACE's node-image build runs `docker build --provenance`, so the first
bring-up failed in 1.5 s with `unknown flag: --provenance`. The script now
installs `docker-buildx`.

## What happened on the lab host

| UTC | Event |
|---|---|
| 03:06:54 | VM created. `/dev/kvm` confirmed before anything else |
| 03:08 | Prereqs and Firecracker vendor tree installed |
| 03:09 | `up.sh` attempt 1: fails at once, no buildx (fixed above) |
| ~03:10 | `up.sh` attempt 2: Kind cluster (control plane plus 5 workers) created; Tilt builds every image |
| 03:33 | `space-db-migrate` job, `bootstrap-roles` init container: `failed to connect to control-plane Postgres … failed to lookup address information: Temporary failure in name resolution`. `up.sh` exits after 23m54s |
| 03:44 | Postgres service (`10.96.57.144:5432`) and both CoreDNS pods `Running`. Migration retriggered with `tilt trigger space-db-migrate`; `up.sh` rerun with `SPACE_BOOTSTRAP_TIMEOUT=1200` |
| 03:45 | Same error, same container. 43 pods Running; `space-db-migrate` in `Init:Error`; `space-credential-manager` and both builder credential managers in `CrashLoopBackOff` ("name resolution and TCP dial did not finish within 6s") |
| ~03:56 | Probe pod pinned to `space-local-worker3` (the infra node the job runs on): `nslookup postgres.space.svc.cluster.local` gives `connection timed out; no servers could be reached`. Pod-to-CoreDNS traffic fails on that node |
| 03:57:50 | Stopped at the 20-minute retry window. VM deleted (see cleanup proof) |

The Kind nodes resolve upstream through `172.18.0.1`, and CoreDNS logged no
errors. The only `drop` in the infra node's nftables was kube-proxy's standard
loopback-DNAT rule, which is not the cause. **Root cause not found.** The
candidates are SPACE's node setup changing the infra node's networking (it
writes nft rules, `ip_forward` and veths in the root namespace), or a kube-proxy
or kindnet problem on the GCE kernel 7.0 host. Telling them apart needs more
time than the timebox left.

Resources during the build: load average up to about 10.5 on 8 vCPU. Memory at
the end: 3 GB used plus 26 GB page cache, out of 31. Disk: 44 GB of 145 GB.

## Baseline vs SPACE matrix

| Route | Result |
|---|---|
| Baseline (#218 direct egress) | Unchanged from #218: **9 of 27 pass**. Rerun green in this branch (`tests/assurance-containment.test.ts`) |
| #218 allowlist shim | Unchanged: 24 of 27 pass |
| SPACE adapter, live | **Not run.** The API never came up |
| SPACE adapter, fake guest (CI) | Covers the gate-to-route integration only, see below. Not a containment result |

## Negative-test evidence (fake guest and fake SPACE server, CI)

`tests/assurance-space-adapter.test.ts`, 13 tests, all passing, no SPACE
endpoint needed. These test the adapter, not SPACE.

| Property | Evidence |
|---|---|
| A refused call never reaches the sandbox | C03 (role) and C10 (tool guard): zero creates, zero runs |
| One sandbox per run, default-deny policy per role | C20 then C01: two sandboxes, both `default_action: deny`, allow list holds only the approved address |
| An expired grant gets deny-all at the gateway | C21: the policy sent is exactly `DENY_ALL`, though roles.json ignores the expiry (#218 defect 4) |
| Host-side audit before dispatch and after exit | The audit log holds `Bash`, `space.dispatch` (with the sandbox id), `space.exit` (with the exit code); the chain verifies |
| Fails closed without a sandbox | Create failure: the command runs nowhere, with no fallback to the host |
| Revocation and cleanup | `revoke` sends `DENY_ALL` to a live sandbox; `dispose` deletes every sandbox |
| Management vs data-plane token separation | The attachment token goes only to the data plane and the management token only to the API. An events URL at another origin is refused, and a 307 carrying a token is refused |
| Plain HTTP only to loopback or a private lab address | `http://space.example.test` is rejected |
| A stream without `process_exited` is not success | Reported as an error; an incomplete SSE frame throws |

The live test (`tests/assurance-space-live.test.ts`, `SPACE_LIVE=1`) is written
but has never run. Two things in it are untested and should be checked first on
any retry: the `PATCH /v1/sandboxes/{id}` shape for policy replacement, and
whether a gateway denial reaches the guest as a curl network error. The adapter
treats those exit codes as "egress denied" only as a hint, and the mock site's
own record decides. It binds the mock sites to the VM's LAN address on purpose:
SPACE hard-denies guest egress to loopback, so loopback sites would fake
containment.

## Measured overheads

None. No sandbox was ever created. The one measured cost: a cold bring-up to
the point of failure took 23m54s on 8 vCPU.

## Cleanup proof

```
$ gcloud compute instances delete space-lab-225 --project=havn-lab --zone=us-east4-a --quiet
Deleted [https://www.googleapis.com/compute/v1/projects/havn-lab/zones/us-east4-a/instances/space-lab-225].
$ gcloud compute instances list --project=havn-lab
Listed 0 items.
```

VM lifetime: 03:06:54 to 03:57:50 UTC, about 0.85 hours.

## Fit / release-gate recommendation

**No-go.** Nothing here supports a claim that SPACE contains Havn's workloads,
because SPACE never ran. The adapter design keeps the gate, roles, tool guard and
audit log in front of execution, so a later attempt starts from working code. But
#224's adoption blockers all still hold (no Havn host has KVM, bare-metal costs
3x to 8x a Havn box, pre-1.0, dev-only install), and the dev install's failure
here adds to them. The cheaper next step for Havn is still the on-box option
#224 named: OS-level default-deny egress (#218 defect 1) plus a lighter sandbox
such as bubblewrap or gVisor.

## Defects

Link under #173.

1. **Two `AuditLog` instances on one file break the hash chain.** Each keeps its
   own sequence and hash head, so interleaved appends fail `verify()` with
   "sequence broken" and "chain link broken". Found when the adapter wrote its
   dispatch and exit records through its own instance. The adapter now writes
   through the gate's shared trail (`getAuditTrail`), and a test pins the
   failure. This hits any future second writer, not only SPACE. `AuditLog`
   should re-read the head under a lock, or the process should enforce one
   writer.
2. **SPACE's Kind install fails on a clean GCE Ubuntu 24.04 host.** In-cluster
   DNS from the infra node times out, `space-db-migrate` cannot reach Postgres,
   and the API never starts. Reproduced twice. Root cause unknown. This blocks
   every live test in #225 and #226.
3. **The #224 setup plan omits `docker-buildx`.** On Ubuntu's `docker.io`, the
   SPACE build fails on `--provenance`. Fixed in the lab script.
4. **Carried from #224:** obligations #197 is not on `origin/main`, so there is
   nothing of it to carry through the adapter. SPACE also does nothing for the
   email and calendar tokens the assistant process holds on the box.
5. **Repo policy:** `tests/no-bash.test.ts` forbids `.sh` files. The two lab
   scripts are VM provisioning, not product automation, so the test now skips
   directories named `lab`. Revert that if the lab scripts are ever removed.

## Reuse for #226

#226 needs the same stack, so it is blocked by defect 2. To retry: create the
same VM (config above), copy `scripts/lab/space-lab-setup.sh` over and run it in
tmux. If `space-db-migrate` fails again, start with DNS from a pod on the infra
node (`space.pplx.net/infra=true`), before running anything else. Once the API
answers `/healthz`, authenticate as in SPACE's `installation.md`, then run
`scripts/lab/run-live.sh` from a copy of this branch with `npm ci`. #226 can
reuse `HttpSpaceApi`, `SpaceRoute` and the grants as they are.
