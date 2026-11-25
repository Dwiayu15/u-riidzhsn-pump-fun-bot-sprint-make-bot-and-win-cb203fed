# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Dwiayu15/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Dwiayu15/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun bonding curves, built for the make.fun
"Pump.fun Bot Sprint" replay competition (harness pumpfun-replay/v2). It
never chases strength: it waits for a coin that has already drawn real SOL
and a real price peak, then buys the dip only while the tape shows buyers
absorbing it. Entries are laddered (an anchor tranche plus at most one
stepped-down add), every position carries hard exits — take profit,
trailing stop, hard stop and a time stop — and a portfolio shell halves
size, then halts new entries, when equity drawdown grows. It speaks the
agent-fun/replay/v2 protocol on stdin/stdout and is a pure function of the
batches it is fed: no clock, no randomness, no network, so repeated runs
produce identical order streams.

## Strategy in brief

- **Watch**: every coin's tape is tracked — its recent price peak, the low
  since that peak, and the buy/sell flow of its last dozen trades.
- **Enter**: only when a liquid curve (at least 4 SOL of real reserves, at
  least 40 trades seen) trades 25–45% under its peak, has bounced at least
  5% off its post-peak low, and buyers are absorbing the dip. One anchor
  tranche of about 0.33 SOL, sized down by the curve's per-reply cap.
- **Add**: at most one ladder tranche, only after a further 12% step down
  with the flow still absorbing, capped at 0.55 SOL per coin.
- **Exit**: take profit at +12%, hard stop at −8%, a trailing stop once a
  position has run +22%, and a time stop after about 30 minutes.
- **Risk shell**: at least 0.75 SOL of cash always stays free; size halves
  when equity drawdown passes 5% and new entries halt for a stretch past
  12%, keeping the book far inside the competition's 50% drawdown guardrail.

## Run it

```sh
node main.ts
```

The bot is driven by the replay harness: it reads `hello`, `batch` and
`done` JSON lines on stdin and answers each batch with one reply line on
stdout. The protocol shim is vendored at `vendor/makefun-bot.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kj5vx9mv&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
