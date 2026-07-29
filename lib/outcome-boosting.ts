import {
  OUTCOME_FEATURE_NAMES,
  outcomeLogit,
  outcomeSigmoid,
  type OutcomeBoostConfig,
  type OutcomeTree,
} from "./outcome-model.ts";
import type { OutcomeExample } from "./outcome-training.ts";

export type OutcomeMetrics = {
  logLoss: number;
  brierScore: number;
  accuracy: number;
  balancedAccuracy: number;
  auc: number;
  calibrationError: number;
  positiveRate: number;
};

export type FittedOutcomeBoost = {
  trees: OutcomeTree[];
  config: OutcomeBoostConfig;
};

const clampProbability = (value: number) => Math.min(1 - 1e-5, Math.max(1e-5, value));

export const fitOutcomeBoost = (
  examples: OutcomeExample[],
  config: Omit<OutcomeBoostConfig, "correctionScale">
): FittedOutcomeBoost => {
  const scores = examples.map((example) => outcomeLogit(example.marketProbability));
  const sortedIndices = OUTCOME_FEATURE_NAMES.map((_, featureIndex) =>
    examples.map((__, index) => index).sort((left, right) =>
      examples[left].features[featureIndex] - examples[right].features[featureIndex]
    )
  );
  const trees: OutcomeTree[] = [];
  for (let treeIndex = 0; treeIndex < config.treeCount; treeIndex += 1) {
    const gradients = scores.map((score, index) => examples[index].label - outcomeSigmoid(score));
    const hessians = scores.map((score) => {
      const probability = outcomeSigmoid(score);
      return Math.max(1e-4, probability * (1 - probability));
    });
    let bestGain = -Infinity;
    let bestTree: OutcomeTree | null = null;
    for (let featureIndex = 0; featureIndex < OUTCOME_FEATURE_NAMES.length; featureIndex += 1) {
      const order = sortedIndices[featureIndex];
      const totalGradient = order.reduce((sum, index) => sum + gradients[index], 0);
      const totalHessian = order.reduce((sum, index) => sum + hessians[index], 0);
      let leftGradient = 0;
      let leftHessian = 0;
      const stride = Math.max(1, Math.floor(order.length / config.bins));
      for (let position = 0; position < order.length - 1; position += 1) {
        const exampleIndex = order[position];
        leftGradient += gradients[exampleIndex];
        leftHessian += hessians[exampleIndex];
        const leftCount = position + 1;
        const rightCount = order.length - leftCount;
        if (
          leftCount < config.minLeaf ||
          rightCount < config.minLeaf ||
          leftCount % stride !== 0
        ) continue;
        const currentValue = examples[exampleIndex].features[featureIndex];
        const nextValue = examples[order[position + 1]].features[featureIndex];
        if (currentValue === nextValue) continue;
        const rightGradient = totalGradient - leftGradient;
        const rightHessian = totalHessian - leftHessian;
        const gain =
          leftGradient ** 2 / (leftHessian + config.l2) +
          rightGradient ** 2 / (rightHessian + config.l2) -
          totalGradient ** 2 / (totalHessian + config.l2);
        if (gain > bestGain) {
          bestGain = gain;
          bestTree = {
            featureIndex,
            threshold: (currentValue + nextValue) / 2,
            leftValue: config.learningRate * leftGradient / (leftHessian + config.l2),
            rightValue: config.learningRate * rightGradient / (rightHessian + config.l2),
          };
        }
      }
    }
    if (!bestTree || bestGain <= 1e-8) break;
    trees.push(bestTree);
    examples.forEach((example, index) => {
      scores[index] += example.features[bestTree!.featureIndex] <= bestTree!.threshold
        ? bestTree!.leftValue
        : bestTree!.rightValue;
    });
  }
  return { trees, config: { ...config, correctionScale: 1 } };
};

export const outcomeProbabilities = (
  examples: OutcomeExample[],
  model: FittedOutcomeBoost,
  correctionScale = model.config.correctionScale
) => examples.map((example) => {
  const correction = model.trees.reduce((score, tree) =>
    score + (example.features[tree.featureIndex] <= tree.threshold ? tree.leftValue : tree.rightValue),
  0);
  return outcomeSigmoid(outcomeLogit(example.marketProbability) + correctionScale * correction);
});

const aucScore = (labels: number[], probabilities: number[]) => {
  const ranked = probabilities
    .map((probability, index) => ({ probability, label: labels[index] }))
    .sort((left, right) => left.probability - right.probability);
  const positives = labels.filter(Boolean).length;
  const negatives = labels.length - positives;
  if (!positives || !negatives) return 0.5;
  let rankSum = 0;
  let index = 0;
  while (index < ranked.length) {
    let end = index + 1;
    while (end < ranked.length && ranked[end].probability === ranked[index].probability) end += 1;
    const averageRank = (index + 1 + end) / 2;
    for (let tied = index; tied < end; tied += 1) {
      if (ranked[tied].label === 1) rankSum += averageRank;
    }
    index = end;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
};

export const evaluateOutcomeProbabilities = (
  examples: OutcomeExample[],
  probabilities: number[]
): OutcomeMetrics => {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let logLoss = 0;
  let brierScore = 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, probability: 0, positives: 0 }));
  examples.forEach((example, index) => {
    const probability = clampProbability(probabilities[index]);
    const predicted = probability >= 0.5 ? 1 : 0;
    if (predicted === 1 && example.label === 1) truePositive += 1;
    else if (predicted === 0 && example.label === 0) trueNegative += 1;
    else if (predicted === 1) falsePositive += 1;
    else falseNegative += 1;
    logLoss -= example.label * Math.log(probability) + (1 - example.label) * Math.log(1 - probability);
    brierScore += (probability - example.label) ** 2;
    const bin = bins[Math.min(9, Math.floor(probability * 10))];
    bin.count += 1;
    bin.probability += probability;
    bin.positives += example.label;
  });
  const count = Math.max(1, examples.length);
  const positiveRecall = truePositive / Math.max(1, truePositive + falseNegative);
  const negativeRecall = trueNegative / Math.max(1, trueNegative + falsePositive);
  const calibrationError = bins.reduce((sum, bin) => {
    if (!bin.count) return sum;
    return sum + (bin.count / count) * Math.abs(bin.probability / bin.count - bin.positives / bin.count);
  }, 0);
  return {
    logLoss: logLoss / count,
    brierScore: brierScore / count,
    accuracy: (truePositive + trueNegative) / count,
    balancedAccuracy: (positiveRecall + negativeRecall) / 2,
    auc: aucScore(examples.map((example) => example.label), probabilities),
    calibrationError,
    positiveRate: examples.reduce((sum, example) => sum + example.label, 0) / count,
  };
};
