# pump-fun-replay-sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Brilliyan010/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Brilliyan010/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

An early-bird paper trading bot for the pump.fun bonding-curve replay: it buys a new curve only while it is still cheap (price up at most 10% from create, with 2–3 distinct buyers and no creator sale yet), adds while it stays cheap, and lets winners run under a wide trailing stop with a 100-slot time limit.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout; grade it locally with the competition kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=tefny29c&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
