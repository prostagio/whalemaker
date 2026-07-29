import { DIRECTION_FEATURE_NAMES } from "./direction-model.ts";
import type { DirectionExample } from "./direction-training.ts";

export type DirectionMetrics = {
  accuracy: number;
  balancedAccuracy: number;
  precision: number;
  recall: number;
  auc: number;
  logLoss: number;
  positiveRate: number;
};

export type FittedDirectionLogistic = {
  means: number[];
  scales: number[];
  weights: number[];
  bias: number;
};

const clampProbability = (value: number) => Math.min(1 - 1e-5, Math.max(1e-5, value));
const sigmoid = (value: number) => {
  if (value >= 0) {
    const exponential = Math.exp(-Math.min(value, 40));
    return 1 / (1 + exponential);
  }
  const exponential = Math.exp(Math.max(value, -40));
  return exponential / (1 + exponential);
};

const fitStandardizer = (examples: DirectionExample[]) => {
  const width = DIRECTION_FEATURE_NAMES.length;
  const means = Array(width).fill(0);
  for (const example of examples) {
    for (let index = 0; index < width; index += 1) means[index] += example.features[index];
  }
  means.forEach((value, index) => {
    means[index] = value / Math.max(1, examples.length);
  });
  const scales = Array(width).fill(0);
  for (const example of examples) {
    for (let index = 0; index < width; index += 1) {
      scales[index] += Math.pow(example.features[index] - means[index], 2);
    }
  }
  scales.forEach((value, index) => {
    scales[index] = Math.max(Math.sqrt(value / Math.max(1, examples.length)), 1e-6);
  });
  return { means, scales };
};

const standardize = (features: number[], means: number[], scales: number[]) =>
  features.map((value, index) => (value - means[index]) / scales[index]);

export const fitDirectionLogistic = (
  examples: DirectionExample[],
  l2: number,
  epochs: number
): FittedDirectionLogistic => {
  const { means, scales } = fitStandardizer(examples);
  const weights = Array(DIRECTION_FEATURE_NAMES.length).fill(0);
  const positiveRate = examples.reduce((sum, example) => sum + example.label, 0) / examples.length;
  const standardizedExamples = examples.map((example) => ({
    features: standardize(example.features, means, scales),
    label: example.label,
  }));
  let bias = Math.log(clampProbability(positiveRate) / (1 - clampProbability(positiveRate)));
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    let biasGradient = 0;
    for (const example of standardizedExamples) {
      let score = bias;
      for (let index = 0; index < weights.length; index += 1) score += weights[index] * example.features[index];
      const error = sigmoid(score) - example.label;
      biasGradient += error;
      for (let index = 0; index < weights.length; index += 1) gradient[index] += error * example.features[index];
    }
    const learningRate = 0.12 / Math.sqrt(1 + epoch / 30);
    bias -= learningRate * biasGradient / examples.length;
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -= learningRate * (gradient[index] / examples.length + l2 * weights[index]);
    }
  }
  return { means, scales, weights, bias };
};

export const directionProbabilities = (
  examples: DirectionExample[],
  model: FittedDirectionLogistic
) => examples.map((example) => {
  const standardized = standardize(example.features, model.means, model.scales);
  return sigmoid(standardized.reduce((score, value, index) => score + value * model.weights[index], model.bias));
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

export const evaluateDirectionProbabilities = (
  examples: DirectionExample[],
  probabilities: number[],
  threshold = 0.5
): DirectionMetrics => {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let loss = 0;
  examples.forEach((example, index) => {
    const probability = clampProbability(probabilities[index]);
    const predicted = probability >= threshold ? 1 : 0;
    if (predicted === 1 && example.label === 1) truePositive += 1;
    else if (predicted === 0 && example.label === 0) trueNegative += 1;
    else if (predicted === 1) falsePositive += 1;
    else falseNegative += 1;
    loss -= example.label * Math.log(probability) + (1 - example.label) * Math.log(1 - probability);
  });
  const positiveRecall = truePositive / Math.max(1, truePositive + falseNegative);
  const negativeRecall = trueNegative / Math.max(1, trueNegative + falsePositive);
  return {
    accuracy: (truePositive + trueNegative) / Math.max(1, examples.length),
    balancedAccuracy: (positiveRecall + negativeRecall) / 2,
    precision: truePositive / Math.max(1, truePositive + falsePositive),
    recall: positiveRecall,
    auc: aucScore(examples.map((example) => example.label), probabilities),
    logLoss: loss / Math.max(1, examples.length),
    positiveRate: examples.reduce((sum, example) => sum + example.label, 0) / Math.max(1, examples.length),
  };
};
