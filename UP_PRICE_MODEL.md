# Polymarket UP-share 10-second price model

The Analytics tab forecasts the executable Polymarket UP ask approximately ten
seconds ahead. It is a research forecast and does not currently authorize or
block orders.

## Target

Snapshots are grouped by `market_slug` and ordered by `captured_at`. For each
candidate, the trainer finds the first quote from the same market between 8 and
14 seconds later. The regression target is:

`future UP ask - current UP ask`, measured in cents.

Training candidates are at least nine seconds apart and never cross a
five-minute market boundary. Unchanged prices remain valid training examples.

## Features

All 16 features exist when a live projection is made:

1. current UP ask in cents
2. current UP bid/ask spread in cents
3. UP-plus-DOWN ask overround in cents
4. BTC log-distance from the strike in basis points
5. seconds remaining
6. log one-second EWMA variance
7. normalized CLOB UP midpoint log-odds
8. raw Chainlink probability minus CLOB probability
9. 15-second BTC momentum
10. 30-second BTC momentum
11. 60-second BTC momentum
12. UP-minus-DOWN contract movement over 15 seconds
13. UP-minus-DOWN contract movement over 30 seconds
14. log displayed top depth
15. 60-second choppiness
16. Chainlink data age in seconds

Training-only means and standard deviations standardize the features.

## Model selection

The model is an L2-regularized linear regression trained with Huber-clipped
gradients so isolated extreme contract moves do not dominate the fit.
Regularization strengths `0.005`, `0.02`, and `0.08` are compared on a
chronological validation period. The lowest validation mean absolute error
wins, with root mean squared error as the tie-breaker. The chosen model is then
refit on the combined training and validation periods.

## Leakage controls and evaluation

Markets are split chronologically:

- the final 20% of markets are an untouched test period;
- the final 20% of the remaining markets select the regularization strength;
- earlier markets fit the candidate models.

The dashboard reports held-out mean absolute error, root mean squared error,
no-change baseline error, move-direction accuracy, and R-squared.

Training requires 160 labeled prices across eight markets. The model considers
retraining after 120 additional snapshots or 30 minutes.

## Live output

The stored regression predicts a price change in cents. The live forecast adds
that change to the latest UP ask and clamps the result to the valid 1–99 cent
contract range. The featured chart uses the final live UP ask as the projection
origin and extends the dashed forecast ten seconds beyond the observed series.
