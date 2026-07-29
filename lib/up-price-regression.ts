import { UP_PRICE_FEATURE_NAMES } from "./up-price-model.ts";
import type { UpPriceExample } from "./up-price-training.ts";

export type UpPriceMetrics = {
  maeCents: number;
  rmseCents: number;
  baselineMaeCents: number;
  directionAccuracy: number;
  rSquared: number;
};

export type FittedUpPriceRegression = {
  means: number[];
  scales: number[];
  weights: number[];
  bias: number;
};

const clampContractPrice = (value: number) => Math.min(0.99, Math.max(0.01, value));

const fitStandardizer = (examples: UpPriceExample[]) => {
  const width = UP_PRICE_FEATURE_NAMES.length;
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

export const fitUpPriceRegression = (
  examples: UpPriceExample[],
  l2: number,
  epochs: number
): FittedUpPriceRegression => {
  const { means, scales } = fitStandardizer(examples);
  const weights = Array(UP_PRICE_FEATURE_NAMES.length).fill(0);
  const standardizedExamples = examples.map((example) => ({
    features: standardize(example.features, means, scales),
    target: example.targetDeltaCents,
  }));
  let bias = examples.reduce((sum, example) => sum + example.targetDeltaCents, 0) /
    Math.max(1, examples.length);
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    let biasGradient = 0;
    for (const example of standardizedExamples) {
      const prediction = example.features.reduce(
        (score, value, index) => score + value * weights[index],
        bias
      );
      const error = prediction - example.target;
      const huberGradient = Math.max(-5, Math.min(5, error));
      biasGradient += huberGradient;
      for (let index = 0; index < weights.length; index += 1) {
        gradient[index] += huberGradient * example.features[index];
      }
    }
    const learningRate = 0.05 / Math.sqrt(1 + epoch / 40);
    bias -= learningRate * biasGradient / examples.length;
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -= learningRate * (gradient[index] / examples.length + l2 * weights[index]);
    }
  }
  return { means, scales, weights, bias };
};

export const upPriceDeltaPredictions = (
  examples: UpPriceExample[],
  model: FittedUpPriceRegression
) => examples.map((example) => {
  const standardized = standardize(example.features, model.means, model.scales);
  return standardized.reduce(
    (score, value, index) => score + value * model.weights[index],
    model.bias
  );
});

const movementBucket = (deltaCents: number) =>
  deltaCents > 0.5 ? 1 : deltaCents < -0.5 ? -1 : 0;

export const evaluateUpPricePredictions = (
  examples: UpPriceExample[],
  predictedDeltas: number[]
): UpPriceMetrics => {
  let absoluteError = 0;
  let squaredError = 0;
  let baselineAbsoluteError = 0;
  let correctDirection = 0;
  const targetMean = examples.reduce((sum, example) => sum + example.targetDeltaCents, 0) /
    Math.max(1, examples.length);
  let totalTargetVariance = 0;
  examples.forEach((example, index) => {
    const predictedPrice = clampContractPrice(example.currentUpAsk + predictedDeltas[index] / 100);
    const predictedDelta = (predictedPrice - example.currentUpAsk) * 100;
    const error = (predictedPrice - example.futureUpAsk) * 100;
    absoluteError += Math.abs(error);
    squaredError += error ** 2;
    baselineAbsoluteError += Math.abs(example.targetDeltaCents);
    correctDirection += movementBucket(predictedDelta) === movementBucket(example.targetDeltaCents) ? 1 : 0;
    totalTargetVariance += (example.targetDeltaCents - targetMean) ** 2;
  });
  const count = Math.max(1, examples.length);
  return {
    maeCents: absoluteError / count,
    rmseCents: Math.sqrt(squaredError / count),
    baselineMaeCents: baselineAbsoluteError / count,
    directionAccuracy: correctDirection / count,
    rSquared: totalTargetVariance > 0 ? 1 - squaredError / totalTargetVariance : 0,
  };
};
