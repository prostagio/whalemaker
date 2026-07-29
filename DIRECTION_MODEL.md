# BTC 10-second direction model

The Analytics tab includes a research-only classifier that estimates whether
Chainlink BTC/USD will be higher or lower ten seconds from the latest complete
WhaleMaker snapshot. It does not place orders and cannot override the existing
entry or recovery rules.

## Label construction

Snapshots are grouped by `market_slug` and sorted by `captured_at`. For each
candidate observation, the trainer finds the first observation from the same
market between 8 and 14 seconds later:

- `UP = 1` when `future_btc_price > current_btc_price`
- `DOWN = 0` when `future_btc_price < current_btc_price`
- unchanged prices and missing future observations are discarded

Training candidates are spaced at least nine seconds apart. A label can never
cross into another five-minute market.

## Features

All features exist at prediction time:

1. BTC log-distance from the strike in basis points
2. seconds remaining in the five-minute market
3. log one-second EWMA variance
4. normalized CLOB UP midpoint log-odds
5. raw Chainlink probability minus the CLOB midpoint
6. 15-second BTC momentum
7. 30-second BTC momentum
8. 60-second BTC momentum
9. UP-minus-DOWN contract movement over 15 seconds
10. UP-minus-DOWN contract movement over 30 seconds
11. top-of-book spread in cents
12. log displayed top depth
13. 60-second choppiness
14. Chainlink data age in seconds

Means and standard deviations are calculated on training data only and stored
with the fitted model.

## Model and selection

The classifier is L2-regularized logistic regression. Three regularization
strengths (`0.005`, `0.02`, and `0.08`) are compared on a chronological
validation period. The winner maximizes balanced accuracy, with log loss as the
tie-breaker. It is then refit on the combined training and validation periods.

## Leakage controls and evaluation

Markets are ordered chronologically:

- the final 20% of markets are held out as the test period;
- the final 20% of the remaining markets are used for model selection; and
- all earlier markets are used for initial fitting.

No market can appear in more than one split. The dashboard reports held-out
accuracy, balanced accuracy, ROC AUC, precision, recall, log loss, and the
majority-direction baseline.

Training requires at least 160 labeled examples across eight five-minute
markets. Until those requirements pass, the model reports `COLLECTING` and does
not emit a prediction. It automatically retrains after 120 additional
snapshots or 30 minutes.

## Interpretation

The output is the probability of an UP move over the next ten seconds. A 0.50
threshold maps it to UP or DOWN. This is a short-horizon research forecast, not
evidence of trade profitability: spread, fees, order latency, adverse
selection, and calibration still have to be evaluated separately.

## Latest verified production run

The run trained on 3,034 stored snapshots available on 2026-07-29:

- 1,035 non-overlapping labeled examples across 63 markets
- 824 development examples and 211 examples from 13 later unseen markets
- 56.4% held-out accuracy
- 56.1% held-out balanced accuracy
- 0.557 ROC AUC
- 0.687 log loss
- 50.5% precision and 53.8% UP recall

A market-cluster bootstrap produced a broad 95% interval of approximately
50.2%–62.6% for accuracy and 46.3%–62.6% for AUC. The sample therefore supports
deploying the model as a measured research forecast, but it does not yet prove
a persistent predictive edge. The dashboard remains the authoritative source
for the latest automatically retrained metrics.
