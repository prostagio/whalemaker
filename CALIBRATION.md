# WhaleMaker dual-entry calibration

WhaleMaker is **paper trading only**. It reads the active Polymarket BTC
five-minute market and Polymarket's Chainlink BTC/USD reference feed, but it
does not connect to a wallet or submit real orders.

## Bankroll and execution

- Starting bankroll: **$100**
- Fixed order size: **5 shares**
- Entry cost: **5 × selected ask**
- Maximum exposure: **one position per five-minute Polymarket market**
- No averaging down, repeat entry, or opposite-side entry in the same market
- Entry window: **60–210 seconds before the Polymarket close**
- Minimum Chainlink history: **60 seconds**
- Maximum Chainlink data age: **3 seconds**
- Maximum selected-side spread: **2¢**
- Minimum selected-side ask depth: **10 shares**
- High-volatility and choppy regimes are blocked

## Entry route 1: consensus-confirmed value

This route buys a contract when the internal probability model estimates a
fee-adjusted value advantage, but only when other market participants and BTC
evidence agree.

The selected side must:

- be the Polymarket midpoint favorite with at least **55% support**;
- have a **fee-adjusted model edge of at least 1.5¢**;
- cost between **55¢ and 90¢** at the executable ask;
- match the raw Chainlink probability direction;
- match BTC's current side of the strike; and
- match 15, 30, and 60-second BTC momentum.

The engine cannot buy a cheap minority contract solely because its own model
calls it undervalued.

## Entry route 2: contract-price momentum

This route buys a contract because the Polymarket share price itself appears to
be breaking upward, even when it does not pass the value threshold.

The selected contract must:

- rise at least **2¢ over 15 seconds**;
- rise at least **3¢ over 30 seconds**;
- show at least a **1¢ rise in the best bid over 15 seconds**;
- retain at least **45% Polymarket midpoint support**;
- cost between **45¢ and 85¢** at the executable ask;
- retain at least **40% support from the raw Chainlink probability model**; and
- have matching 15, 30, and 60-second BTC momentum.

The route requires **30 seconds of Polymarket quote history**. It therefore
responds to other traders moving bids and asks, not merely to the engine's own
valuation.

## Probability and fee-aware value model

For BTC price `S`, strike `K`, and seconds to expiry `T`:

1. One-second log return: `r_t = ln(S_t / S_(t-1))`
2. EWMA variance: `q_t = 0.97 q_(t-1) + 0.03 r_t²`
3. Variance floor: `q_used = max(q_t, 2.3020308442843487e-9)`
4. Standardized distance: `z = ln(S / K) / sqrt(q_used × T)`
5. Raw UP probability: `p_raw = Φ(z)`
6. Calibrated probability: `p_calibrated = 0.50 × p_raw + 0.50 × p_CLOB`

The value route subtracts the executable ask, spread penalty, 1¢ safety margin,
and estimated crypto taker fee:

`edge = calibrated probability - ask - 0.07 × ask × (1-ask) - 1¢ - 0.5 × spread`

## Recovery plan

Recovery sells the existing five shares at the current executable bid. It never
adds shares, doubles the position, or opens an opposite bet.

An exit requires enough displayed bid depth to sell all five shares, a spread
of at most 4¢, fresh Chainlink data, and an accepting market. After the position
has been held for eight seconds, any of these can trigger:

1. **Hard-loss stop:** unrealized loss reaches **20% of entry cost**.
2. **Profit trailing stop:** bid first rises at least **6¢ above entry**, then
   falls at least **4¢ from its peak** while still at least 1¢ profitable.
3. **Break-even protection:** after a 4¢ favorable move, the bid falls back to
   the entry price.
4. **Thesis invalidation:** the crowd favorite flips, the Chainlink probability
   flips, market support falls below 47%, the contract falls 2¢ over 15 seconds,
   and at least two BTC momentum windows turn adverse.
5. **Fast reversal:** bid falls at least 5¢ below entry, market support drops
   below 45%, and at least one BTC momentum window turns adverse.
6. **Late-window defense:** with 40 seconds or less remaining, the position is
   below entry and either crowd, model, or multi-window momentum turns against
   it.

The live positions table displays the entry type, current bid, observed peak
bid, and hard-stop level. Recovery reasons remain in the ledger and CSV.

## Settlement and records

- Testing settlement compares the completed Polymarket Chainlink close with the
  opening strike without waiting for official resolution.
- `UP` wins when `closePrice >= openPrice`; otherwise `DOWN` wins.
- A winning five-share position pays $5; a losing position pays zero.
- Balance equals starting balance plus realized P&L minus open stakes.
- Every buy records its entry mode and rationale.
- A model snapshot is saved every five seconds.

These thresholds are starting calibration values, not evidence of future
profitability. Real-money use requires out-of-sample testing of fees, latency,
slippage, partial fills, queue movement, and adverse selection.
