# WhaleMaker market-consensus calibration

This release is **paper trading only**. It reads the active Polymarket BTC
five-minute market and its Chainlink BTC/USD reference feed, but it does not
connect to a wallet or submit real orders.

## Bankroll and execution

- Starting bankroll: **$100**
- Fixed order size: **5 shares**
- Entry cost: **5 × the selected outcome's ask price**
- Maximum exposure: **one position per Polymarket five-minute market**
- No averaging down, repeat entry, or opposite-side entry in the same market
- No order when the available balance is below the five-share cost

## Direction: the market leads

The engine no longer chooses a side because its own fair-value calculation says
that a cheap contract is undervalued. It first reads the midpoint probabilities
implied by the live Polymarket order books:

`UP midpoint = (UP bid + UP ask) / 2`

`DOWN midpoint = (DOWN bid + DOWN ask) / 2`

The higher midpoint is the crowd favorite and is the only side the engine may
buy. The favorite must have at least **55% market confidence**, and its
executable ask must be between **55¢ and 90¢**.

## Independent confirmation gates

Polymarket consensus proposes the direction. Chainlink and market-quality
signals can only confirm or veto it:

- At least **60 seconds** of live Chainlink history
- Entry only with **60–210 seconds** remaining
- BTC must be on the same side of the strike as the Polymarket favorite
- The raw Chainlink probability model must select the same side
- 15-second and 30-second momentum must point the same way; 60-second momentum
  must not materially oppose it
- 60-second choppiness must be at most **0.55**
- High-volatility regimes are blocked
- Selected-side spread must be at most **2¢**
- Selected-side top-of-book ask depth must be at least **20 shares**
- Market data must be no more than **3 seconds** old
- Polymarket must still be accepting orders

If any gate fails, the engine waits. It never switches to the less popular side
merely because that contract is cheaper.

## Chainlink probability model

For current BTC price `S`, strike `K`, and seconds to expiry `T`:

1. One-second log return: `r_t = ln(S_t / S_(t-1))`
2. EWMA variance: `q_t = 0.97 q_(t-1) + 0.03 r_t²`
3. Variance floor: `q_used = max(q_t, 2.3020308442843487e-9)`
4. Standardized distance: `z = ln(S / K) / sqrt(q_used × T)`
5. Raw UP probability: `p_raw = Φ(z)`
6. Research calibration: `p_calibrated = 0.50 × p_raw + 0.50 × p_CLOB`

The calibrated probability and fee-aware model gaps are recorded for research,
but they do **not** determine which side is purchased.

## Timing and test settlement

- Market discovery uses the active `btc-updown-5m-{epoch}` Polymarket event.
- The countdown and stored cutoff use Polymarket's market end time.
- After the cutoff, test settlement reads the completed Chainlink price window
  exposed by Polymarket and calculates the result without waiting for official
  resolution.
- `UP` wins when `closePrice >= openPrice`; otherwise `DOWN` wins.
- A winning five-share position pays **$5**; a losing position pays zero.
- Balance equals starting balance plus realized P&L minus stakes still committed
  to open positions.

## Recovery exits

Recovery is a paper sale of the existing position at the current best bid. It
never adds shares or opens an opposite bet.

An open position is eligible after 10 seconds while data is fresh, the selected
book is tradeable, and displayed bid depth covers all five shares. A loss of
**30% of entry cost** triggers an emergency exit independently of the internal
fair-price model, so the engine cannot keep holding merely because its own model
still favors the original side. Other reversal evidence—strike crossing,
adverse momentum, probability deterioration, time remaining, and choppiness—is
used for earlier confirmed exits.

Recovery P&L is:

`5 × exit bid - 5 × entry ask`

This remains a paper fill assumption. Real fees, latency, partial fills, queue
movement, and adverse selection are not modeled as executable live trading.

## Recorded research data

A database snapshot is saved every five seconds with BTC and strike prices,
time remaining, variance, raw and calibrated probabilities, both order books,
spread, depth, data age, 15/30/60-second momentum, choppiness, volatility
regime, current signal, and every blocking reason. Results remain downloadable
as CSV.

These thresholds are a conservative starting calibration, not evidence of
future profitability. Real-money use still requires out-of-sample testing.
