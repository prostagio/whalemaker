# Five-minute BTC market outcome model

The Analytics tab estimates the probability that the active Polymarket
five-minute BTC market ultimately settles UP. It does not predict a
ten-second quote and does not currently authorize or block orders.

## Labels

After a market closes, the application reads Polymarket's completed Chainlink
five-minute open and close prices. A market is labeled:

- `UP = 1` when the completed close is greater than or equal to the open;
- `DOWN = 0` when the completed close is below the open.

Every eligible snapshot from that market inherits the final outcome. Snapshots
are spaced by at least nine seconds. A market can never appear in more than one
training, validation, or test split.

## Inputs

The model can use all information available at prediction time:

1. normalized CLOB UP probability
2. UP ask and bid
3. DOWN ask and bid
4. both top-of-book spreads
5. outcome ask overround
6. UP and DOWN order-book imbalances
7. ask-depth ratio
8. BTC distance from the strike
9. seconds remaining
10. variance
11. raw Chainlink fair probability
12. Chainlink-versus-CLOB probability gap
13. 15, 30, and 60-second BTC momentum
14. 15 and 30-second relative contract movement
15. total displayed top depth
16. choppiness
17. Chainlink data age

## Model

The classifier is a nonlinear gradient-boosted ensemble of decision stumps
trained with logistic loss. Its starting score is the CLOB UP log-odds, so the
crowd probability is the baseline and the trees learn only evidence-supported
corrections.

Three tree configurations are compared on chronological validation markets:

- 80 trees, 0.04 learning rate, 20-example leaves, L2 6
- 120 trees, 0.03 learning rate, 16-example leaves, L2 8
- 160 trees, 0.022 learning rate, 14-example leaves, L2 10

Correction shrinkage values of 0, 0.25, 0.5, 0.75, and 1 are also compared.
Validation log loss selects the winner, with Brier score as the tie-breaker.
A shrinkage of zero means the CLOB baseline remains preferable to learned
corrections.

The live deployment also fails closed: learned corrections remain disabled
unless they improve held-out log loss by at least 0.002 and also improve the
held-out Brier score. When that safety gate fails, the displayed ML probability
equals the raw CLOB baseline rather than applying a demonstrably worse model.

## Evaluation

Markets are ordered chronologically:

- the final 20% are an untouched test period;
- the final 20% of the remaining markets select the configuration;
- earlier markets fit candidates.

The dashboard compares model and CLOB log loss and reports Brier score,
accuracy, balanced accuracy, ROC AUC, and calibration error.

Training requires 240 labeled snapshots across 12 settled markets. The model
considers retraining after four more settled markets, 120 additional snapshots,
or 30 minutes.
