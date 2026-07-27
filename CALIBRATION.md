# WhaleMaker starting calibration

This release is deliberately **paper trading only**. It reads the active
Polymarket BTC five-minute market and its Chainlink BTC/USD reference feed, but
does not connect to a wallet or submit orders.

## Bankroll and execution

- Starting bankroll: **$100**
- Fixed stake: **$5 per signal**
- Maximum bet frequency: **one every 20 seconds**
- No bet when the available balance is below $5
- Normal required net edge: **2 cents**
- Adaptive required net edge: **0.5 cents** only in low/medium volatility,
  when the Chainlink model leads the same-side Polymarket probability by at
  least 0.25 percentage points and total disagreement is no more than 6 points
- At least one outcome must have an executable price of **80 cents**
- The current Chainlink tick must be no more than **1,000 ms** old
- The Polymarket spread must be no more than **4 cents**
- Both outcome asks must expose at least **5 shares** of top-level depth

## Fair-price model

For current BTC price `S`, strike `K`, and seconds to expiry `T`:

1. One-second log return: `r_t = ln(S_t / S_(t-1))`
2. EWMA variance: `q_t = 0.97 q_(t-1) + 0.03 r_t²`
3. Variance floor: `q_used = max(q_t, 2.3020308442843487e-9)`
4. Standardized distance: `z = ln(S / K) / sqrt(q_used × T)`
5. Raw UP fair probability: `p_raw = Φ(z)`
6. Calibrated fair probability: `p_fair = 0.50 × p_raw + 0.50 × p_CLOB`

The 0.97 EWMA decay corresponds to the documented **22.7566-second half-life**.

## Entry score

- UP edge: `p_fair - UP ask - 1¢ safety margin - 0.5¢ spread penalty`
- DOWN edge: `(1 - p_fair) - DOWN ask - 1¢ safety margin - 0.5¢ spread penalty`
- Pick the side with the larger positive edge.
- Wait when the best net edge is below 2¢ or fewer than 15 seconds remain.

## Initial market-quality gates

- Maximum spread: **4¢**
- Minimum depth: **5 shares at both top levels**
- Maximum venue divergence: **10 bps**
- Maximum exchange-data age: **1,000 ms**

## Polymarket timing and settlement

- Market discovery uses the active `btc-updown-5m-{epoch}` Polymarket event.
- Window start comes from Polymarket's `eventStartTime`.
- The close countdown and stored settlement cutoff come from the market's
  `endDate`; the app does not manufacture its own five-minute timer.
- Testing settlement does not wait for Polymarket's official resolution. After
  the cutoff, the app reads the completed Chainlink price window from
  Polymarket and calculates the outcome itself.
- `UP` wins when `closePrice >= openPrice`; otherwise `DOWN` wins.
- Winning payout is `stake / entry price`; losing payout is zero.
- The persistent balance is recalculated as starting balance plus settled P&L
  minus stakes still held in open bets.

## Recorded research variables

While the engine is running, a database snapshot is saved every five seconds.
It contains the complete fair-price inputs and outputs, both CLOB books,
spread, top-level depth, data age, 15/30/60-second Chainlink momentum,
60-second choppiness, volatility regime, required edge tier, signal, and all
blocking reasons.

These are starting values from the workspace's strategy epoch 3 configuration,
not evidence of future profitability. The live inputs now use Polymarket's
active market, public CLOB, and settlement-matched Chainlink BTC/USD values.
Before real-money use, the model still requires out-of-sample testing with
fees, latency, slippage, fill probability, and adverse selection included.
