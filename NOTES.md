# NOTES — Pump.fun Replay Sprint paper bot

Competition: `u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`
("Pump.fun Replay Sprint — Paper Bot, Real Ranking"). Paper bot, 10 SOL,
24 h pump.fun replay. Entries close 27 Nov 2026 11:50 WIB.

## Dev score (grade-local, process driver, kit dev window)

- **Net PnL: +0.004933073 SOL** (return +0.000493; 90% interval
  −0.0282 … +0.0390 SOL)
- Trading: 133 fills over 45 coins, 45 round trips, win rate 24.4%,
  max drawdown 0.00157 (0.16%)
- Fees: 0.0231 SOL curve + 0.0142 SOL tx; at 2x fees net PnL −0.0323 SOL
- **Guardrails met**: 35 coins hold a round trip of ≥ 0.01 SOL
  (need ≥ 20), drawdown well under 50%
- 0 rejected, 2 failed orders
- Two executions reproduced byte for byte (L1 regrade); a second full
  grade-local run returned identical hashes:
  - action_log_sha256 `c4c0258feddef79ba239739c4b8f17a16bf76b56de001f9a35a6eb039250644f`
  - result_sha256 `0243d378e90dc25fefcfd7c7de8310993936c87dbae0abb29b3bb506f7889020`
  (Note: the server grades on Node v26.13.1 in Docker, this machine runs
  v24.22.1, so the server's result hash will differ.)

## Ticket-1 rejection — timeout diagnosis (25 Nov 2026)

Ticket-1 (submission `01a20c3c-b4a6-7787-8aad-a071425e8417`) was REJECTED by the
server in round 1: the only failing check was `run_completes` — "The latest
grade run on the dev phase ended timeout." Every other check PASSED. Server
limits: wall budget 1800 s, 1 CPU, 1024 MB, 64 pids.

**Cause found: the OLD kit (level 40), not the bot.** The old kit shipped
harness `harness@1adec795` / scorer `scorer@c4f67f9f`. The NEW kit (level 3)
ships harness `harness@c62b0ab7dd3f8c0410c8b3e90da98acb5fa7d898d1a3019dfd35d7425c924ed0`
(node v26.13.1) / scorer `scorer@26f98e34b4f52a6a2397ca67a70991ab647397739e33e0d77f1ad00b3fc97cda`.
The dataset did NOT change (`dataset_sha256`
`b661ceee26070f1f07eced009b43dda699e1e96d40a6724c7e72273b1e3715a9`;
`bundle_sha256`
`405e82a96403dd30ea71aa83727ba3d5a8103de4c96cf75052ed29598e2528d7` — same as
the old kit). Re-grading the unchanged repo (HEAD `1232d72`) with the new
kit completes cleanly every time.

**Grade-local runs with the new kit (process driver, `--json`, all exit 0,
status `finished`, error `null`, `l1.reproduced: true`):**

| run | constraint | wall time |
|---|---|---|
| 1 | `taskset -c 0` (1 CPU) | 100 s |
| 2 | `systemd-run` scope, MemoryMax=1024M + CPUQuota=100% (server-like caps) | 56 s |
| 3 | `taskset -c 0` + bot-process monitor | 66 s |
| 4 | reviser verification run, plain process driver | 43 s |

All four runs returned IDENTICAL results. The bot is nowhere near the
server limits: in the monitored run (run 3) the bot itself used only
**11 s CPU total** (two runs: 6 s + 5 s) and **peak RSS 124–137 MB**,
against a budget of 1800 s wall / 1024 MB. Whole grade-local finishes in
~1 minute even under server-like caps — the timeout cannot have come from
this bot.

**Hashes (new kit):**
- action_log_sha256 `c4c0258feddef79ba239739c4b8f17a16bf76b56de001f9a35a6eb039250644f`
  — UNCHANGED from the old kit (byte-identical bot behaviour)
- result_sha256 `89290e23b084c9d1e96fdf33fcb63191c1412ed665c9be0f2daf549990d27218`
  — changed from the old kit's `0243d378...` because the harness/scorer
  versions changed; expected, not a bot change.

**Score UNCHANGED: net PnL +0.004933073 SOL (4,933,073 lamports), 133 fills,
45 round trips** — same as the dev score above.

**Static check (25 Nov 2026, reviser):** `main.ts` `onBatch` makes single
passes over `batch.fills` / `batch.events` / `held` (≤ 5 positions) /
`pending` / `traded` (per-batch set); `batch.marks.find(...)` runs only
inside the held-positions loop (≤ 5 × marks-per-batch). `BotState.applyBatch`
in `vendor/makefun-bot.ts` is a single linear pass over fills, marks and
events with O(1) Map lookups. No dataset loading, no clock/env/randomness,
no loop over all tapes/curves — no material O(n²) hot spot anywhere. All
loops are linear in the 128,058 events / 63,369 slots of the replay.

**Decision: NO code or strategy change.** Nothing needs optimising — the
bot uses 11 s CPU of an 1800 s budget — and any edit would only risk
breaking the byte-identical determinism and the verified score above for
zero benefit. **The only change since ticket-1 is this NOTES.md file.**
One mismatch remains and is out of our control: local Node is v24.22.1
while the server grades on Node v26.13.1 (Docker is not available on this
VM, so the grade-local runs used the process driver); the server's
`result_sha256` will therefore differ, but the `action_log_sha256` should
match.

## Stress test (20 block surrogates of the dev window)

- Median −0.04 SOL, p10 −0.08, p90 −0.01 SOL; **18 of 20 copies lost
  money**; dev score above 18 of 20 copies.
- Honest read: the dev score is slightly positive but the strategy is
  roughly breakeven-to-slightly-negative on reshuffled windows (typical
  copy −0.01 … −0.09 SOL). It never blows up — losses stay tiny and
  drawdown stays ~0.2% — but the final window is unseen and a small
  loss there is the likelier outcome than a win. The edge is thin by
  construction: every alternative tested (see below) lost more.

## Concentration

- Top 3 coins made 51% of the gains; without them net PnL is −0.02 SOL.
  The result leans on a few coins, as the stress test also shows.

## Baseline comparison (same kit, same dev window, process driver)

| entry | net PnL (SOL) | guardrails |
|---|---|---|
| **this bot** | **+0.0049** | met (35 coins, dd 0.16%) |
| baseline-hold-cash | 0.0000 | NOT met (0 coins) |
| baseline-equal-weight | −0.0193 | NOT met (1 coin) |
| pilot/sniper | −0.4748 | met (264 coins, dd 5.2%) |
| pilot/reversion | −3.9951 | met (dd 49.3%) |
| pilot/momentum | −9.4892 | NOT met (dd 95.7%) |

This bot is the only entry measured with a positive dev PnL, and it
beats the best pilot (sniper) by ~0.48 SOL.

## Strategy summary

Early-bird sniper with loose exits, written from scratch in `main.ts`
(Node 22, stdlib only, vendor shim `vendor/makefun-bot.ts` copied
byte-for-byte from the kit's `sdk/ts/makefun-bot.ts` as the kit instructs).

- **Entry (one per coin):** within 10 slots of the CreateEvent, real SOL
  reserves ≥ 0.3, price runup from create ≤ +10%, 2–3 distinct
  non-creator buyers, creator has not sold, sells/buys by others ≤ 10×.
  First buy min(0.05 SOL, 1% of real reserves), min 0.005 SOL.
- **Adds:** +0.02 SOL per qualifying batch up to 0.10 SOL total while
  age ≤ 60 slots and runup ≤ +15%, ≥ 2 slots between buys.
- **Exits:** take profit +50%; trailing stop −35% once up +5%;
  time limit 100 slots. No hard stop-loss; no exit on creator sell
  while held (tested worse on dev).
- **Pace guard:** if fills/coins lag prorated targets (30 coins /
  70 fills over 24 h), opens tiny 0.01 SOL probe round trips (max 1
  at a time) so a thin final window still clears the 20-coin guardrail.
  Idle on dev.
- Max 5 open positions (hello caps), ≤ 16 orders/batch, buys capped at
  1% of real reserves, deterministic (no clock, env, or randomness).

## Parameter search (offline simulator replicating the harness math)

~500 offline simulations plus 7 real grade-local runs. What mattered:
runup ≤ 10% is load-bearing (15% → −0.019 SOL); max age 10 slots beat
5 (+0.0006), 20 (−0.0033) and 30 (−0.0013); trailing stop 35% beat
25% (+0.0013); momentum entries (best −0.32) and reversion (worse)
both lost; tight stop-losses just realise noise. Parameters were picked
from flat regions, not single best cells, but the stress test still
flags dev-window dependence — see above.
