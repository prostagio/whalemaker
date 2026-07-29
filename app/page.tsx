"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  outcomeFeaturesFromValues,
  predictOutcomeProbability,
  type StoredOutcomeModel,
} from "../lib/outcome-model";

type Side = "UP" | "DOWN";
type EntryMode = "VALUE" | "MOMENTUM";
type Bet = {
  id: number;
  condition_id: string;
  market_slug: string;
  market_title: string;
  market_end_ms: number;
  side: Side;
  stake: number;
  shares: number | null;
  entry_price: number;
  edge: number;
  entry_mode: EntryMode;
  entry_reason: string;
  status: "OPEN" | "WON" | "LOST" | "EXITED" | "VOID";
  settlement_outcome: string | null;
  payout: number | null;
  pnl: number | null;
  placed_at: number;
  settled_at: number | null;
};
type QuoteTick = {
  marketSlug: string;
  timestamp: number;
  upMid: number;
  downMid: number;
  upBid: number;
  downBid: number;
};
type TransactionFilter = "all" | "buy" | "sell";
type AppTab = "engine" | "analytics" | "positions" | "ledger";
type ShareTransaction = {
  id: string;
  positionId: number;
  action: "BUY" | "SELL";
  time: number;
  side: Side;
  settlementSide: Side | null;
  exitedEarly: boolean;
  shares: number;
  price: number;
  cashFlow: number;
  pnl: number | null;
  description: string;
};
type LiveMarket = {
  conditionId: string;
  eventTitle: string;
  slug: string;
  marketUrl: string;
  acceptingOrders: boolean;
  windowStart: number;
  windowEnd: number;
  secondsLeft: number;
  strike: number;
  upAsk: number;
  upBid: number;
  downAsk: number;
  downBid: number;
  upAskSize: number;
  upBidSize: number;
  downAskSize: number;
  downBidSize: number;
  fetchedAt: number;
};
type ChartSample = {
  marketSlug: string;
  timestamp: number;
  btc: number;
  strike: number;
  marketUp: number;
  rawUp: number;
  calibratedUp: number;
  outcomeUpProbability: number;
  upAsk: number;
  upBid: number;
  downAsk: number;
  downBid: number;
  upEdge: number;
  downEdge: number;
  selectedEdge: number;
  valueEdge: number;
  momentum15: number;
  momentum30: number;
  momentum60: number;
  upMove15: number;
  downMove15: number;
  upMove30: number;
  downMove30: number;
  upSpread: number;
  downSpread: number;
  selectedSpread: number;
  upDepth: number;
  downDepth: number;
  selectedDepth: number;
  choppiness: number;
  variance: number;
  qUsed: number;
  sigmaBps: number;
  z: number;
  distanceBps: number;
  secondsLeft: number;
  dataAgeSeconds: number;
  selectedAsk: number;
  orderCost: number;
  marketConfidence: number;
  favoriteConfidence: number;
  bankroll: number;
  realizedPnl: number;
  openStake: number;
};
type ChartFormat = "usd" | "dollars" | "cents" | "percent" | "bps" | "number" | "seconds" | "scientific";
type ChartSeries = {
  key: keyof ChartSample;
  label: string;
  color: "green" | "red" | "amber" | "blue" | "purple" | "cyan";
  style?: "solid" | "dashed" | "dotted";
  fill?: boolean;
};
type ChartReferenceLine = {
  value: number;
  label: string;
  color: ChartSeries["color"];
};
type ChartProjection = {
  fromTimestamp: number;
  fromValue: number;
  toTimestamp: number;
  toValue: number;
  label: string;
  color: ChartSeries["color"];
};
type ChartScale = "auto" | "contract";

const VARIANCE_FLOOR = 2.3020308442843487e-9;
const FIXED_SHARES = 5;
const MAX_DATA_AGE_MS = 3_000;
const MIN_HISTORY_MS = 60_000;
const ENTRY_WINDOW_MIN_SECONDS = 60;
const ENTRY_WINDOW_MAX_SECONDS = 210;
const MIN_CONSENSUS = 0.55;
const MIN_FAVORITE_PRICE = 0.55;
const MAX_FAVORITE_PRICE = 0.90;
const MIN_VALUE_EDGE = 0.015;
const MIN_MOMENTUM_PRICE = 0.45;
const MAX_MOMENTUM_PRICE = 0.85;
const MIN_MARKET_SUPPORT = 0.45;
const MIN_QUOTE_HISTORY_MS = 30_000;
const MIN_MOVE_15 = 0.02;
const MIN_MOVE_30 = 0.03;
const MAX_ENTRY_SPREAD = 0.02;
const MIN_ENTRY_DEPTH = 10;
const HARD_STOP_FRACTION = 0.20;
const TRAIL_ACTIVATION = 0.06;
const TRAIL_GIVEBACK = 0.04;
const normalCdf = (x: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? p : 1 - p;
};
const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const formatChartValue = (value: number, format: ChartFormat) => {
  if (!Number.isFinite(value)) return "—";
  if (format === "usd") return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (format === "dollars") return money(value);
  if (format === "cents") return `${(value * 100).toFixed(1)}¢`;
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  if (format === "bps") return `${value.toFixed(2)} bps`;
  if (format === "seconds") return `${value.toFixed(1)}s`;
  if (format === "scientific") return value.toExponential(2);
  return value.toFixed(Math.abs(value) < 10 ? 3 : 1);
};
const niceChartStep = (range: number, targetTicks = 5) => {
  if (!Number.isFinite(range) || range <= 0) return 1;
  const roughStep = range / Math.max(1, targetTicks - 1);
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
};

function MetricChart({
  title,
  description,
  samples,
  series,
  format,
  referenceLines = [],
  scale = "auto",
  featured = false,
  projection,
}: {
  title: string;
  description: string;
  samples: ChartSample[];
  series: ChartSeries[];
  format: ChartFormat;
  referenceLines?: ChartReferenceLine[];
  scale?: ChartScale;
  featured?: boolean;
  projection?: ChartProjection;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seriesKey = series.map((item) => `${String(item.key)}-${item.color}-${item.style}-${item.fill}`).join("|");
  const referenceKey = referenceLines.map((item) => `${item.value}-${item.label}-${item.color}`).join("|");
  const projectionKey = projection
    ? `${projection.fromTimestamp}-${projection.fromValue}-${projection.toTimestamp}-${projection.toValue}-${projection.color}`
    : "";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const context = canvas.getContext("2d");
      if (!context) return;
      const width = Math.max(280, canvas.clientWidth);
      const height = Math.max(170, canvas.clientHeight || (featured ? 250 : 190));
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const styles = getComputedStyle(document.documentElement);
      const muted = styles.getPropertyValue("--muted").trim();
      const line = styles.getPropertyValue("--line").trim();
      const colors: Record<ChartSeries["color"], string> = {
        green: styles.getPropertyValue("--green").trim(),
        red: styles.getPropertyValue("--red").trim(),
        amber: styles.getPropertyValue("--amber").trim(),
        blue: styles.getPropertyValue("--blue").trim(),
        purple: styles.getPropertyValue("--purple").trim(),
        cyan: styles.getPropertyValue("--cyan").trim(),
      };
      const left = 62;
      const right = 16;
      const top = 16;
      const bottom = 30;
      const plotWidth = width - left - right;
      const plotHeight = height - top - bottom;
      const values = samples.flatMap((sample) =>
        series.map((item) => Number(sample[item.key])).filter(Number.isFinite)
      );
      values.push(...referenceLines.map((item) => item.value));
      if (projection) values.push(projection.fromValue, projection.toValue);
      let minimum = Math.min(...values);
      let maximum = Math.max(...values);
      let tickStep = 0.25;
      if (!values.length) {
        minimum = 0;
        maximum = 1;
      } else if (scale === "contract") {
        const rawMinimum = Math.max(0, minimum);
        const rawMaximum = Math.min(1, maximum);
        const center = (rawMinimum + rawMaximum) / 2;
        const dataRange = rawMaximum - rawMinimum;
        const visibleRange = Math.max(0.20, dataRange * 1.28);
        let lower = Math.max(0, center - visibleRange / 2);
        let upper = Math.min(1, center + visibleRange / 2);
        if (upper - lower < Math.min(0.20, visibleRange)) {
          if (lower === 0) upper = Math.min(1, lower + visibleRange);
          else lower = Math.max(0, upper - visibleRange);
        }
        tickStep = Math.max(0.05, niceChartStep(upper - lower));
        minimum = Math.max(0, Math.floor(lower / tickStep) * tickStep);
        maximum = Math.min(1, Math.ceil(upper / tickStep) * tickStep);
      } else if (minimum === maximum) {
        const padding = Math.abs(minimum) > 0 ? Math.abs(minimum) * 0.08 : 1;
        tickStep = niceChartStep(padding * 2);
        minimum = Math.floor((minimum - padding) / tickStep) * tickStep;
        maximum = Math.ceil((maximum + padding) / tickStep) * tickStep;
      } else {
        const padding = (maximum - minimum) * 0.08;
        tickStep = niceChartStep(maximum - minimum + padding * 2);
        minimum = Math.floor((minimum - padding) / tickStep) * tickStep;
        maximum = Math.ceil((maximum + padding) / tickStep) * tickStep;
      }
      if (maximum <= minimum) {
        maximum = minimum + tickStep;
      }

      const yTicks: number[] = [];
      for (let value = minimum; value <= maximum + tickStep / 2; value += tickStep) {
        yTicks.push(Number(value.toFixed(12)));
      }

      context.save();
      const plotBackground = context.createLinearGradient(0, top, 0, top + plotHeight);
      plotBackground.addColorStop(0, styles.getPropertyValue("--surface-2").trim());
      plotBackground.addColorStop(1, styles.getPropertyValue("--surface").trim());
      context.globalAlpha = featured ? 0.5 : 0.26;
      context.fillStyle = plotBackground;
      context.fillRect(left, top, plotWidth, plotHeight);
      context.restore();

      context.font = featured ? "11px Arial" : "10px Arial";
      context.lineWidth = 1;
      const yFor = (value: number) => top + ((maximum - value) / (maximum - minimum)) * plotHeight;
      yTicks.forEach((value) => {
        const y = yFor(value);
        context.save();
        context.globalAlpha = 0.72;
        context.strokeStyle = line;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(width - right, y);
        context.stroke();
        context.restore();
        context.fillStyle = muted;
        context.textAlign = "right";
        context.textBaseline = "middle";
        context.fillText(formatChartValue(value, format), left - 8, y);
      });

      if (samples.length < 2) {
        context.fillStyle = muted;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText("Collecting live samples…", left + plotWidth / 2, top + plotHeight / 2);
        return;
      }

      const start = samples[0].timestamp;
      const latestSampleTimestamp = samples.at(-1)?.timestamp ?? start + 1;
      const end = Math.max(latestSampleTimestamp, projection?.toTimestamp ?? latestSampleTimestamp);
      const xFor = (timestamp: number) => left + ((timestamp - start) / Math.max(1, end - start)) * plotWidth;
      const xTickCount = width < 440 ? 2 : 5;
      for (let index = 0; index < xTickCount; index += 1) {
        const fraction = index / Math.max(1, xTickCount - 1);
        const timestamp = start + (end - start) * fraction;
        const x = xFor(timestamp);
        context.save();
        context.globalAlpha = 0.45;
        context.strokeStyle = line;
        context.beginPath();
        context.moveTo(x, top);
        context.lineTo(x, top + plotHeight);
        context.stroke();
        context.restore();
        context.fillStyle = muted;
        context.textBaseline = "bottom";
        context.textAlign = index === 0 ? "left" : index === xTickCount - 1 ? "right" : "center";
        context.fillText(new Date(timestamp).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }), x, height);
      }

      if (projection) {
        const forecastStartX = xFor(projection.fromTimestamp);
        context.save();
        const futureFill = context.createLinearGradient(forecastStartX, 0, width - right, 0);
        futureFill.addColorStop(0, "transparent");
        futureFill.addColorStop(1, colors[projection.color]);
        context.globalAlpha = 0.08;
        context.fillStyle = futureFill;
        context.fillRect(forecastStartX, top, width - right - forecastStartX, plotHeight);
        context.restore();
        context.save();
        context.globalAlpha = 0.65;
        context.setLineDash([3, 5]);
        context.strokeStyle = colors[projection.color];
        context.beginPath();
        context.moveTo(forecastStartX, top);
        context.lineTo(forecastStartX, top + plotHeight);
        context.stroke();
        context.restore();
        context.fillStyle = colors[projection.color];
        context.textAlign = "right";
        context.textBaseline = "top";
        context.fillText("+10s projection", width - right - 5, top + 6);
      }

      referenceLines.forEach((item) => {
        const y = yFor(item.value);
        context.save();
        context.setLineDash([4, 4]);
        context.strokeStyle = colors[item.color];
        context.globalAlpha = 0.72;
        context.beginPath();
        context.moveTo(left, y);
        context.lineTo(width - right, y);
        context.stroke();
        context.restore();
        context.fillStyle = colors[item.color];
        context.textAlign = "left";
        context.textBaseline = "bottom";
        context.fillText(item.label, left + 5, y - 3);
      });

      series.forEach((item) => {
        if (item.fill) {
          const finiteSamples = samples.filter((sample) =>
            Number.isFinite(Number(sample[item.key]))
          );
          if (finiteSamples.length > 1) {
            const gradient = context.createLinearGradient(0, top, 0, top + plotHeight);
            gradient.addColorStop(0, colors[item.color]);
            gradient.addColorStop(1, "transparent");
            context.save();
            context.globalAlpha = 0.13;
            context.fillStyle = gradient;
            context.beginPath();
            context.moveTo(xFor(finiteSamples[0].timestamp), top + plotHeight);
            finiteSamples.forEach((sample) => {
              context.lineTo(xFor(sample.timestamp), yFor(Number(sample[item.key])));
            });
            context.lineTo(xFor(finiteSamples.at(-1)!.timestamp), top + plotHeight);
            context.closePath();
            context.fill();
            context.restore();
          }
        }

        context.save();
        context.strokeStyle = colors[item.color];
        context.lineWidth = item.fill ? 2.8 : 2;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.setLineDash(item.style === "dashed" ? [8, 5] : item.style === "dotted" ? [2, 5] : []);
        context.shadowColor = item.fill ? colors[item.color] : "transparent";
        context.shadowBlur = item.fill ? 7 : 0;
        context.beginPath();
        let started = false;
        samples.forEach((sample) => {
          const value = Number(sample[item.key]);
          if (!Number.isFinite(value)) {
            started = false;
            return;
          }
          const x = xFor(sample.timestamp);
          const y = yFor(value);
          if (!started) context.moveTo(x, y);
          else context.lineTo(x, y);
          started = true;
        });
        context.stroke();
        context.restore();
        const latest = [...samples].reverse().find((sample) =>
          Number.isFinite(Number(sample[item.key]))
        );
        if (latest) {
          context.save();
          context.fillStyle = colors[item.color];
          context.strokeStyle = styles.getPropertyValue("--surface").trim();
          context.lineWidth = 2;
          context.beginPath();
          context.arc(xFor(latest.timestamp), yFor(Number(latest[item.key])), item.fill ? 4 : 3, 0, Math.PI * 2);
          context.fill();
          context.stroke();
          context.restore();
        }
      });

      if (projection) {
        context.save();
        context.strokeStyle = colors[projection.color];
        context.lineWidth = 3;
        context.setLineDash([9, 6]);
        context.lineCap = "round";
        context.shadowColor = colors[projection.color];
        context.shadowBlur = 10;
        context.beginPath();
        context.moveTo(xFor(projection.fromTimestamp), yFor(projection.fromValue));
        context.lineTo(xFor(projection.toTimestamp), yFor(projection.toValue));
        context.stroke();
        context.restore();
        context.save();
        context.fillStyle = colors[projection.color];
        context.strokeStyle = styles.getPropertyValue("--surface").trim();
        context.lineWidth = 2;
        context.beginPath();
        context.arc(xFor(projection.toTimestamp), yFor(projection.toValue), 5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.restore();
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
    // Inline chart declarations are represented by stable keys so they do not redraw on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featured, format, projectionKey, samples, scale, seriesKey, referenceKey]);

  return (
    <article className={`chart-card${featured ? " featured" : ""}`}>
      <div className="chart-heading">
        <div><h3>{title}</h3><p>{description}</p></div>
        <span>{samples.length} samples</span>
      </div>
      <canvas ref={canvasRef} className="chart-canvas" role="img" aria-label={`${title} live history chart`}>
        Live chart for {title}
      </canvas>
      <div className="chart-legend">
        {series.map((item) => {
          const latest = [...samples].reverse().find((sample) =>
            Number.isFinite(Number(sample[item.key]))
          );
          return (
            <span key={String(item.key)}><i className={`chart-key ${item.color} ${item.style ?? "solid"}`} /><b>{item.label}</b> {latest ? formatChartValue(Number(latest[item.key]), format) : "—"}</span>
          );
        })}
        {projection && (
          <span><i className={`chart-key ${projection.color} dashed`} /><b>{projection.label}</b> {formatChartValue(projection.toValue, format)}</span>
        )}
      </div>
    </article>
  );
}

export default function Home() {
  const [live, setLive] = useState<LiveMarket | null>(null);
  const [chainlink, setChainlink] = useState<{ price: number; timestamp: number } | null>(null);
  const [dataError, setDataError] = useState("");
  const [feedStatus, setFeedStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [variance, setVariance] = useState(VARIANCE_FLOOR);
  const [bankroll, setBankroll] = useState(100);
  const [startingBalance, setStartingBalance] = useState(100);
  const [bets, setBets] = useState<Bet[]>([]);
  const [ledgerError, setLedgerError] = useState("");
  const [placing, setPlacing] = useState(false);
  const [recoveringBetId, setRecoveringBetId] = useState<number | null>(null);
  const [stats, setStats] = useState({ total: 0, open_count: 0, wins: 0, losses: 0, recoveries: 0, open_stake: 0, realized_pnl: 0 });
  const [snapshotCount, setSnapshotCount] = useState(0);
  const [outcomeModel, setOutcomeModel] = useState<StoredOutcomeModel | null>(null);
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>("all");
  const [activeTab, setActiveTab] = useState<AppTab>("engine");
  const [chartHistory, setChartHistory] = useState<ChartSample[]>([]);
  const [lastBetAt, setLastBetAt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [tickHistory, setTickHistory] = useState<{ price: number; timestamp: number }[]>([]);
  const [quoteHistory, setQuoteHistory] = useState<QuoteTick[]>([]);
  const previousTick = useRef<{ price: number; timestamp: number } | null>(null);
  const lastSnapshotAt = useRef(0);

  const applyLedger = (payload: {
    account?: { balance?: number; starting_balance?: number };
    bets?: Bet[];
    stats?: typeof stats;
    snapshotCount?: number;
    outcomeModel?: StoredOutcomeModel | null;
  }) => {
    if (typeof payload.account?.balance === "number") setBankroll(payload.account.balance);
    if (typeof payload.account?.starting_balance === "number") setStartingBalance(payload.account.starting_balance);
    if (payload.bets) setBets(payload.bets);
    if (payload.stats) setStats(payload.stats);
    if (typeof payload.snapshotCount === "number") setSnapshotCount(payload.snapshotCount);
    if (payload.outcomeModel !== undefined) setOutcomeModel(payload.outcomeModel);
  };

  const syncLedger = async () => {
    try {
      const response = await fetch("/api/paper", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Paper database failed.");
      applyLedger(payload);
      setLedgerError("");
    } catch (error) {
      setLedgerError(error instanceof Error ? error.message : "Paper database failed.");
    }
  };

  useEffect(() => {
    let active = true;
    let poller: number | undefined;
    const load = async () => {
      let nextPollMs = 1_500;
      try {
        const response = await fetch("/api/polymarket", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Live market data failed.");
        if (active) {
          const nextLive = payload as LiveMarket;
          setQuoteHistory((history) => {
            const currentMarket = history.filter((quote) =>
              quote.marketSlug === nextLive.slug &&
              quote.timestamp >= nextLive.fetchedAt - 240_000
            );
            if (currentMarket.at(-1)?.timestamp === nextLive.fetchedAt) return currentMarket;
            return [...currentMarket, {
              marketSlug: nextLive.slug,
              timestamp: nextLive.fetchedAt,
              upMid: (nextLive.upAsk + nextLive.upBid) / 2,
              downMid: (nextLive.downAsk + nextLive.downBid) / 2,
              upBid: nextLive.upBid,
              downBid: nextLive.downBid,
            }];
          });
          setLive(nextLive);
          setDataError("");
        }
      } catch (error) {
        nextPollMs = 5_000;
        if (active) setDataError(error instanceof Error ? error.message : "Live market data failed.");
      } finally {
        if (active) poller = window.setTimeout(load, nextPollMs);
      }
    };
    load();
    const ticker = window.setInterval(() => setClock(Date.now()), 250);
    return () => {
      active = false;
      if (poller) window.clearTimeout(poller);
      window.clearInterval(ticker);
    };
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(syncLedger, 0);
    const poller = window.setInterval(syncLedger, 5_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(poller);
    };
    // The ledger synchronizer has no external configuration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnect: number | undefined;
    let closed = false;

    const connect = () => {
      setFeedStatus("connecting");
      socket = new WebSocket("wss://ws-live-data.polymarket.com");
      socket.onopen = () => {
        setFeedStatus("live");
        socket?.send(JSON.stringify({
          action: "subscribe",
          subscriptions: [{ topic: "crypto_prices_chainlink", type: "update" }],
        }));
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data));
          const payload = message?.payload;
          if (
            message?.topic === "crypto_prices_chainlink" &&
            payload?.symbol === "btc/usd" &&
            Number.isFinite(Number(payload.value))
          ) {
            const tick = {
              price: Number(payload.value),
              timestamp: Number(payload.timestamp) || Number(message.timestamp) || Date.now(),
            };
            setTickHistory((history) => [
              ...history.filter((item) => item.timestamp >= tick.timestamp - 125_000),
              tick,
            ]);
            setChainlink(tick);
            setFeedStatus("live");
          }
        } catch {
          // Ignore non-JSON heartbeat frames.
        }
      };
      socket.onerror = () => setFeedStatus("offline");
      socket.onclose = () => {
        if (!closed) {
          setFeedStatus("offline");
          reconnect = window.setTimeout(connect, 2_000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnect) window.clearTimeout(reconnect);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    if (!chainlink?.price || !chainlink.timestamp) return;
    const previous = previousTick.current;
    if (previous && chainlink.timestamp > previous.timestamp && chainlink.price !== previous.price) {
      const elapsed = Math.max(1, (chainlink.timestamp - previous.timestamp) / 1_000);
      const oneSecondVariance = Math.pow(Math.log(chainlink.price / previous.price), 2) / elapsed;
      const decay = Math.pow(0.97, elapsed);
      setVariance((value) => decay * value + (1 - decay) * oneSecondVariance);
    }
    previousTick.current = chainlink;
  }, [chainlink]);

  const seconds = live ? Math.max(0, Math.ceil((live.windowEnd - clock) / 1_000)) : 0;
  const btc = chainlink?.price ?? 0;
  const strike = live?.strike ?? 0;
  const dataAge = chainlink ? Math.max(0, clock - chainlink.timestamp) : Infinity;
  const spread = live ? Math.max(live.upAsk - live.upBid, live.downAsk - live.downBid) : 1;
  const depth = live ? Math.min(live.upAskSize, live.downAskSize) : 0;
  const upMidpoint = live ? (live.upAsk + live.upBid) / 2 : 0.5;
  const downMidpoint = live ? (live.downAsk + live.downBid) / 2 : 0.5;
  const midpointTotal = upMidpoint + downMidpoint;
  const marketUp = midpointTotal > 0 ? upMidpoint / midpointTotal : 0.5;
  const momentum = (lookbackSeconds: number) => {
    const history = tickHistory;
    const latest = history[history.length - 1];
    if (!latest) return 0;
    const target = latest.timestamp - lookbackSeconds * 1_000;
    const previous = [...history].reverse().find((tick) => tick.timestamp <= target);
    return previous ? Math.log(latest.price / previous.price) * 10_000 : 0;
  };
  const momentum15 = momentum(15);
  const momentum30 = momentum(30);
  const momentum60 = momentum(60);
  const recentTicks = tickHistory.filter((tick) => tick.timestamp >= clock - 60_000);
  const signs = recentTicks
    .slice(1)
    .map((tick, index) => Math.sign(tick.price - recentTicks[index].price))
    .filter(Boolean);
  const signFlips = signs.slice(1).filter((sign, index) => sign !== signs[index]).length;
  const choppiness60 = signs.length > 1 ? signFlips / (signs.length - 1) : 0;
  const historySpanMs = tickHistory.length > 1
    ? tickHistory[tickHistory.length - 1].timestamp - tickHistory[0].timestamp
    : 0;
  const latestQuote = quoteHistory.at(-1);
  const quoteHistorySpanMs = quoteHistory.length > 1
    ? quoteHistory[quoteHistory.length - 1].timestamp - quoteHistory[0].timestamp
    : 0;
  const quoteMove = (side: Side, lookbackSeconds: number, useBid = false) => {
    if (!latestQuote) return 0;
    const target = latestQuote.timestamp - lookbackSeconds * 1_000;
    const previous = [...quoteHistory].reverse().find((quote) => quote.timestamp <= target);
    if (!previous) return 0;
    const currentValue = side === "UP"
      ? useBid ? latestQuote.upBid : latestQuote.upMid
      : useBid ? latestQuote.downBid : latestQuote.downMid;
    const previousValue = side === "UP"
      ? useBid ? previous.upBid : previous.upMid
      : useBid ? previous.downBid : previous.downMid;
    return currentValue - previousValue;
  };
  const upMove15 = quoteMove("UP", 15);
  const downMove15 = quoteMove("DOWN", 15);
  const upMove30 = quoteMove("UP", 30);
  const downMove30 = quoteMove("DOWN", 30);
  const upBidMove15 = quoteMove("UP", 15, true);
  const downBidMove15 = quoteMove("DOWN", 15, true);
  const peakBidFor = (bet: Bet, currentBid: number | null) =>
    quoteHistory.reduce((peak, quote) => {
      if (quote.marketSlug !== bet.market_slug || quote.timestamp < bet.placed_at) return peak;
      return Math.max(peak, bet.side === "UP" ? quote.upBid : quote.downBid);
    }, Math.max(bet.entry_price, currentBid ?? 0));

  const model = useMemo(() => {
    const qUsed = Math.max(variance, VARIANCE_FLOOR);
    const distance = btc > 0 && strike > 0 ? Math.log(btc / strike) : 0;
    const z = seconds > 0 ? distance / Math.sqrt(qUsed * seconds) : 0;
    const raw = normalCdf(z);
    const calibrated = Math.min(0.99, Math.max(0.01, raw * 0.5 + marketUp * 0.5));
    const upAsk = live?.upAsk ?? 1;
    const downAsk = live?.downAsk ?? 1;
    const upSpread = live ? live.upAsk - live.upBid : 1;
    const downSpread = live ? live.downAsk - live.downBid : 1;
    const upFeePerShare = 0.07 * upAsk * (1 - upAsk);
    const downFeePerShare = 0.07 * downAsk * (1 - downAsk);
    const upEdge = calibrated - upAsk - upFeePerShare - 0.01 - 0.5 * upSpread;
    const downEdge = 1 - calibrated - downAsk - downFeePerShare - 0.01 - 0.5 * downSpread;
    const marketFavoriteSide: Side = marketUp >= 0.5 ? "UP" : "DOWN";
    const favoriteConfidence = marketFavoriteSide === "UP" ? marketUp : 1 - marketUp;
    const modelSide: Side = raw >= 0.5 ? "UP" : "DOWN";
    const strikeSide: Side = btc >= strike ? "UP" : "DOWN";
    const sigmaBpsPerSqrtSecond = Math.sqrt(qUsed) * 10_000;
    const volatilityRegime =
      sigmaBpsPerSqrtSecond < 0.5 ? "LOW" : sigmaBpsPerSqrtSecond < 1.25 ? "MEDIUM" : "HIGH";
    const alreadyTraded = Boolean(live && bets.some((bet) => bet.market_slug === live.slug));
    const detailsFor = (side: Side) => ({
      side,
      ask: side === "UP" ? upAsk : downAsk,
      spread: side === "UP" ? upSpread : downSpread,
      depth: live ? side === "UP" ? live.upAskSize : live.downAskSize : 0,
      marketProbability: side === "UP" ? marketUp : 1 - marketUp,
      edge: side === "UP" ? upEdge : downEdge,
      rawSupport: side === "UP" ? raw : 1 - raw,
      move15: side === "UP" ? upMove15 : downMove15,
      move30: side === "UP" ? upMove30 : downMove30,
      bidMove15: side === "UP" ? upBidMove15 : downBidMove15,
    });
    const directionalMomentumPass = (side: Side) => side === "UP"
      ? momentum15 >= 1 && momentum30 >= 0.5 && momentum60 > -1
      : momentum15 <= -1 && momentum30 <= -0.5 && momentum60 < 1;
    const commonReasons = (candidate: ReturnType<typeof detailsFor>) => [
      !live ? "no active Polymarket market" : "",
      !chainlink || feedStatus !== "live" ? "Chainlink feed offline" : "",
      dataError ? "market API unavailable" : "",
      ledgerError ? "paper database unavailable" : "",
      historySpanMs < MIN_HISTORY_MS ? "collecting 60 seconds of BTC history" : "",
      seconds > ENTRY_WINDOW_MAX_SECONDS ? "entry window has not opened yet" : "",
      seconds < ENTRY_WINDOW_MIN_SECONDS ? "entry window is closed for this game" : "",
      choppiness60 > 0.55 ? "60-second BTC price action is too choppy" : "",
      volatilityRegime === "HIGH" ? "volatility regime is HIGH" : "",
      alreadyTraded ? "this five-minute game already has a position" : "",
      bankroll < FIXED_SHARES * candidate.ask
        ? `balance below ${money(FIXED_SHARES * candidate.ask)} order cost`
        : "",
      candidate.spread > MAX_ENTRY_SPREAD ? `${candidate.side} spread is above 2¢` : "",
      candidate.depth < MIN_ENTRY_DEPTH ? `${candidate.side} ask depth is below 10 shares` : "",
      dataAge > MAX_DATA_AGE_MS ? "Chainlink data older than 3,000ms" : "",
      !live?.acceptingOrders ? "Polymarket is not accepting orders" : "",
    ].filter(Boolean) as string[];

    const value = detailsFor(marketFavoriteSide);
    const valueReasons = [
      ...commonReasons(value),
      favoriteConfidence < MIN_CONSENSUS ? "Polymarket has no clear 55% favorite" : "",
      value.edge < MIN_VALUE_EDGE ? "fee-adjusted value edge is below 1.5¢" : "",
      modelSide !== value.side ? "Chainlink probability disagrees with the market favorite" : "",
      strikeSide !== value.side ? "BTC is on the opposite side of the strike" : "",
      !directionalMomentumPass(value.side) ? "BTC momentum does not confirm the value entry" : "",
      value.ask < MIN_FAVORITE_PRICE ? "favorite costs less than 55¢" : "",
      value.ask > MAX_FAVORITE_PRICE ? "favorite costs more than 90¢" : "",
    ].filter(Boolean) as string[];

    const trendScoreUp = upMove15 + upMove30 + upBidMove15;
    const trendScoreDown = downMove15 + downMove30 + downBidMove15;
    const trendSide: Side = trendScoreUp >= trendScoreDown ? "UP" : "DOWN";
    const trend = detailsFor(trendSide);
    const momentumReasons = [
      ...commonReasons(trend),
      quoteHistorySpanMs < MIN_QUOTE_HISTORY_MS ? "collecting 30 seconds of Polymarket quote history" : "",
      trend.marketProbability < MIN_MARKET_SUPPORT ? `${trend.side} has less than 45% market support` : "",
      trend.move15 < MIN_MOVE_15 ? `${trend.side} contract has not risen 2¢ in 15 seconds` : "",
      trend.move30 < MIN_MOVE_30 ? `${trend.side} contract has not risen 3¢ in 30 seconds` : "",
      trend.bidMove15 < 0.01 ? `${trend.side} best bid is not rising with the contract` : "",
      !directionalMomentumPass(trend.side) ? "BTC momentum does not confirm the contract breakout" : "",
      trend.rawSupport < 0.40 ? "Chainlink probability support is below 40%" : "",
      trend.ask < MIN_MOMENTUM_PRICE ? "breakout contract costs less than 45¢" : "",
      trend.ask > MAX_MOMENTUM_PRICE ? "breakout contract costs more than 85¢" : "",
    ].filter(Boolean) as string[];

    const valuePass = valueReasons.length === 0;
    const momentumEntryPass = momentumReasons.length === 0;
    const useValue = valuePass || (!momentumEntryPass && valueReasons.length <= momentumReasons.length);
    const selected = useValue ? value : trend;
    const entryMode: EntryMode = useValue ? "VALUE" : "MOMENTUM";
    const blockedReasons = useValue ? valueReasons : momentumReasons;
    const blocked = !valuePass && !momentumEntryPass;
    const selectedAsk = selected.ask;
    const selectedSpread = selected.spread;
    const selectedDepth = selected.depth;
    const marketConfidence = selected.marketProbability;
    const orderCost = FIXED_SHARES * selectedAsk;
    const momentumPass = directionalMomentumPass(selected.side);
    const entryReason = entryMode === "VALUE"
      ? `${selected.side} is the market favorite with ${(selected.edge * 100).toFixed(1)}¢ fee-adjusted value edge`
      : `${selected.side} contract rose ${(selected.move15 * 100).toFixed(1)}¢/15s and ${(selected.move30 * 100).toFixed(1)}¢/30s with its bid rising`;
    return {
      qUsed, distance, z, raw, calibrated, upAsk, downAsk, upEdge, downEdge,
      side: selected.side, blocked, blockedReasons, volatilityRegime,
      selectedAsk, selectedSpread, selectedDepth, orderCost, marketConfidence, modelSide, momentumPass,
      entryMode, entryReason, marketFavoriteSide, favoriteConfidence,
      contractMove15: selected.move15, contractMove30: selected.move30,
      selectedEdge: selected.edge, valueEdge: value.edge, valuePass, momentumEntryPass,
    };
  }, [bankroll, bets, btc, chainlink, choppiness60, dataAge, dataError, downBidMove15, downMove15, downMove30, feedStatus, historySpanMs, ledgerError, live, marketUp, momentum15, momentum30, momentum60, quoteHistorySpanMs, seconds, strike, upBidMove15, upMove15, upMove30, variance]);

  const outcomeFeatures = outcomeFeaturesFromValues({
    btcPrice: btc,
    strikePrice: strike,
    secondsLeft: seconds,
    variance,
    rawProbability: model.raw,
    marketUp,
    upBid: live?.upBid ?? 0.5,
    upAsk: live?.upAsk ?? 0.5,
    downBid: live?.downBid ?? 0.5,
    downAsk: live?.downAsk ?? 0.5,
    upAskSize: live?.upAskSize ?? 0,
    upBidSize: live?.upBidSize ?? 0,
    downAskSize: live?.downAskSize ?? 0,
    downBidSize: live?.downBidSize ?? 0,
    momentum15Bps: momentum15,
    momentum30Bps: momentum30,
    momentum60Bps: momentum60,
    upContractMove15: upMove15,
    downContractMove15: downMove15,
    upContractMove30: upMove30,
    downContractMove30: downMove30,
    choppiness60,
    dataAgeMs: dataAge,
  });
  const outcomeUpProbability = outcomeModel && live
    ? predictOutcomeProbability(outcomeModel, outcomeFeatures, marketUp)
    : null;

  const placeBet = async (side = model.side) => {
    if (bankroll < model.orderCost || model.blocked || !live || placing) return;
    const edge = side === model.side
      ? model.selectedEdge
      : side === "UP" ? model.upEdge : model.downEdge;
    const price = side === "UP" ? model.upAsk : model.downAsk;
    setLastBetAt(Date.now());
    setPlacing(true);
    try {
      const response = await fetch("/api/paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "place",
          conditionId: live.conditionId,
          marketSlug: live.slug,
          marketTitle: live.eventTitle,
          marketEndMs: live.windowEnd,
          side,
          shares: FIXED_SHARES,
          entryPrice: price,
          fairProbability: model.marketConfidence,
          edge,
          entryMode: model.entryMode,
          entryReason: model.entryReason,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Paper bet failed.");
      applyLedger(payload);
      setLedgerError("");
    } catch (error) {
      setLedgerError(error instanceof Error ? error.message : "Paper bet failed.");
    } finally {
      setPlacing(false);
    }
  };

  const recoveryCandidate = useMemo(() => {
    if (!live || !chainlink || dataAge > MAX_DATA_AGE_MS || seconds <= 3) return null;
    const candidates = bets
      .filter((bet) =>
        bet.status === "OPEN" &&
        bet.market_slug === live.slug &&
        clock - bet.placed_at >= 8_000
      )
      .map((bet) => {
        const currentBid = bet.side === "UP" ? live.upBid : live.downBid;
        const bidSize = bet.side === "UP" ? live.upBidSize : live.downBidSize;
        const sideSpread = bet.side === "UP"
          ? live.upAsk - live.upBid
          : live.downAsk - live.downBid;
        const shares = bet.shares ?? bet.stake / bet.entry_price;
        const unrealizedPnl = shares * currentBid - bet.stake;
        const marketSupport = bet.side === "UP" ? marketUp : 1 - marketUp;
        const rawSupport = bet.side === "UP" ? model.raw : 1 - model.raw;
        const crowdAgainst = model.marketFavoriteSide !== bet.side;
        const modelAgainst = model.modelSide !== bet.side;
        const strikeAgainst = bet.side === "UP" ? btc < strike : btc >= strike;
        const contractMove15 = bet.side === "UP" ? upMove15 : downMove15;
        const adverseMomentum = [momentum15, momentum30, momentum60].filter((value) =>
          bet.side === "UP" ? value <= -0.5 : value >= 0.5
        ).length;
        const peakBid = quoteHistory.reduce((peak, quote) => {
          if (quote.marketSlug !== bet.market_slug || quote.timestamp < bet.placed_at) return peak;
          return Math.max(peak, bet.side === "UP" ? quote.upBid : quote.downBid);
        }, Math.max(bet.entry_price, currentBid));
        const lossLimit = -bet.stake * HARD_STOP_FRACTION;
        const hardLoss = unrealizedPnl <= lossLimit;
        const trailingStop =
          peakBid - bet.entry_price >= TRAIL_ACTIVATION &&
          peakBid - currentBid >= TRAIL_GIVEBACK &&
          currentBid >= bet.entry_price + 0.01;
        const breakEvenProtection =
          peakBid - bet.entry_price >= 0.04 &&
          currentBid <= bet.entry_price + 0.005 &&
          currentBid >= bet.entry_price;
        const thesisInvalidated =
          crowdAgainst &&
          modelAgainst &&
          marketSupport < 0.47 &&
          adverseMomentum >= 2 &&
          contractMove15 <= -0.02;
        const fastReversal =
          currentBid <= bet.entry_price - 0.05 &&
          marketSupport < 0.45 &&
          adverseMomentum >= 1;
        const lateDefense =
          seconds <= 40 &&
          currentBid < bet.entry_price &&
          (crowdAgainst || modelAgainst || adverseMomentum >= 2);
        const score =
          (crowdAgainst ? 2 : 0) +
          (modelAgainst ? 2 : 0) +
          (strikeAgainst ? 2 : 0) +
          (marketSupport < 0.45 ? 2 : 0) +
          (rawSupport < 0.4 ? 1 : 0) +
          (adverseMomentum >= 2 ? 2 : 0) +
          (hardLoss ? 2 : 0) +
          (contractMove15 <= -0.02 ? 1 : 0) +
          (seconds <= 40 ? 1 : 0);
        const liquidExit =
          live.acceptingOrders &&
          currentBid > 0 &&
          bidSize >= shares &&
          sideSpread <= 0.04;
        const exitType = hardLoss
          ? "20% hard-loss stop"
          : trailingStop
            ? "profit trailing stop"
            : breakEvenProtection
              ? "break-even protection"
              : thesisInvalidated
                ? "entry thesis invalidated"
                : fastReversal
                  ? "fast market reversal"
                  : "late-window defense";
        return {
          bet,
          currentBid,
          unrealizedPnl,
          score,
          marketSupport,
          adverseMomentum,
          peakBid,
          liquidExit,
          shouldExit: liquidExit && (
            hardLoss ||
            trailingStop ||
            breakEvenProtection ||
            thesisInvalidated ||
            fastReversal ||
            lateDefense
          ),
          reason: `${exitType}; score ${score}; market support ${(marketSupport * 100).toFixed(1)}%; peak ${(peakBid * 100).toFixed(1)}¢; bid ${(currentBid * 100).toFixed(1)}¢; adverse momentum ${adverseMomentum}/3`,
        };
      })
      .filter((candidate) => candidate.shouldExit)
      .sort((a, b) => a.unrealizedPnl - b.unrealizedPnl);
    return candidates[0] ?? null;
  }, [bets, btc, chainlink, clock, dataAge, downMove15, live, marketUp, model.marketFavoriteSide, model.modelSide, model.raw, momentum15, momentum30, momentum60, quoteHistory, seconds, strike, upMove15]);

  const recoverBet = async () => {
    if (!recoveryCandidate || recoveringBetId != null) return;
    setRecoveringBetId(recoveryCandidate.bet.id);
    try {
      const response = await fetch("/api/paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "recover",
          betId: recoveryCandidate.bet.id,
          exitPrice: recoveryCandidate.currentBid,
          reason: recoveryCandidate.reason,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Recovery exit failed.");
      applyLedger(payload);
      setLedgerError("");
    } catch (error) {
      setLedgerError(error instanceof Error ? error.message : "Recovery exit failed.");
    } finally {
      setRecoveringBetId(null);
    }
  };

  useEffect(() => {
    if (!recoveryCandidate || recoveringBetId != null) return;
    const pending = window.setTimeout(recoverBet, 0);
    return () => window.clearTimeout(pending);
    // Recovery deliberately reacts to the latest confirmed candidate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryCandidate, recoveringBetId]);

  useEffect(() => {
    if (model.blocked || placing || recoveringBetId != null || recoveryCandidate || clock - lastBetAt <= 20_000) return;
    const pending = window.setTimeout(() => placeBet(), 0);
    return () => window.clearTimeout(pending);
    // The live model intentionally controls this effect cadence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock, model.blocked, model.side, placing, recoveringBetId, recoveryCandidate]);

  const reset = async () => {
    setLastBetAt(0);
    try {
      const response = await fetch("/api/paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset" }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Reset failed.");
      applyLedger(payload);
      setLedgerError("");
    } catch (error) {
      setLedgerError(error instanceof Error ? error.message : "Reset failed.");
    }
  };

  const confidence = Math.round(model.marketConfidence * 100);
  const signalLabel = model.blocked ? "WAIT" : `${model.entryMode} · BUY ${model.side}`;
  const freshness = dataAge <= MAX_DATA_AGE_MS ? "LIVE" : dataAge < Infinity ? "STALE" : feedStatus.toUpperCase();
  const qualityCount = [
    model.valuePass || model.momentumEntryPass,
    model.entryMode === "VALUE"
      ? model.selectedEdge >= MIN_VALUE_EDGE
      : model.contractMove15 >= MIN_MOVE_15 && model.contractMove30 >= MIN_MOVE_30,
    model.momentumPass,
    model.selectedSpread <= MAX_ENTRY_SPREAD,
    model.selectedDepth >= MIN_ENTRY_DEPTH,
    dataAge <= MAX_DATA_AGE_MS,
  ].filter(Boolean).length;
  const settledBalance = startingBalance + stats.realized_pnl;
  const transactions = bets.flatMap<ShareTransaction>((bet) => {
    const shares = bet.shares ?? bet.stake / bet.entry_price;
    const rows: ShareTransaction[] = [{
      id: `buy-${bet.id}`,
      positionId: bet.id,
      action: "BUY",
      time: bet.placed_at,
      side: bet.side,
      settlementSide: bet.settlement_outcome === "UP" || bet.settlement_outcome === "DOWN"
        ? bet.settlement_outcome
        : null,
      exitedEarly: bet.status === "EXITED",
      shares,
      price: bet.entry_price,
      cashFlow: -bet.stake,
      pnl: null,
      description: `${shares.toFixed(2)} ${bet.side} shares · ${(bet.entry_mode ?? "VALUE").toLowerCase()}: ${bet.entry_reason ?? "legacy entry"}`,
    }];
    if (bet.status !== "OPEN" && bet.status !== "VOID" && bet.settled_at != null) {
      const cashReceived = bet.payout ?? 0;
      rows.push({
        id: `sell-${bet.id}`,
        positionId: bet.id,
        action: "SELL",
        time: bet.settled_at,
        side: bet.side,
        settlementSide: bet.settlement_outcome === "UP" || bet.settlement_outcome === "DOWN"
          ? bet.settlement_outcome
          : null,
        exitedEarly: bet.status === "EXITED",
        shares,
        price: shares > 0 ? cashReceived / shares : 0,
        cashFlow: cashReceived,
        pnl: bet.pnl,
        description: bet.status === "EXITED"
          ? `${shares.toFixed(2)} ${bet.side} shares · recovery`
          : `${shares.toFixed(2)} ${bet.side} shares · market close`,
      });
    }
    return rows;
  }).sort((a, b) => b.time - a.time);
  const buyCount = transactions.filter((transaction) => transaction.action === "BUY").length;
  const sellCount = transactions.filter((transaction) => transaction.action === "SELL").length;
  const visibleTransactions = transactionFilter === "all"
    ? transactions
    : transactions.filter((transaction) => transaction.action === transactionFilter.toUpperCase());
  const sharesHeld = bets
    .filter((bet) => bet.status === "OPEN")
    .reduce((sum, bet) => sum + (bet.shares ?? bet.stake / bet.entry_price), 0);
  const cashPaid = transactions
    .filter((transaction) => transaction.action === "BUY")
    .reduce((sum, transaction) => sum - transaction.cashFlow, 0);
  const cashReceived = transactions
    .filter((transaction) => transaction.action === "SELL")
    .reduce((sum, transaction) => sum + transaction.cashFlow, 0);
  const ongoingBets = bets
    .filter((bet) => bet.status === "OPEN")
    .map((bet) => {
      const shares = bet.shares ?? bet.stake / bet.entry_price;
      const currentBid = live?.slug === bet.market_slug
        ? bet.side === "UP" ? live.upBid : live.downBid
        : null;
      const currentValue = currentBid != null ? shares * currentBid : null;
      const peakBid = peakBidFor(bet, currentBid);
      return {
        ...bet,
        shares,
        currentBid,
        currentValue,
        peakBid,
        hardStopBid: bet.entry_price * (1 - HARD_STOP_FRACTION),
        unrealizedPnl: currentValue != null ? currentValue - bet.stake : null,
      };
    })
    .sort((a, b) => b.placed_at - a.placed_at);
  const gameTotals = Array.from(bets.reduce((games, bet) => {
    const existing = games.get(bet.market_slug) ?? {
      slug: bet.market_slug,
      title: bet.market_title,
      endTime: bet.market_end_ms,
      totalBet: 0,
      totalReturn: 0,
      realizedPnl: 0,
      positions: 0,
      openPositions: 0,
    };
    existing.totalBet += bet.stake;
    existing.totalReturn += bet.payout ?? 0;
    existing.realizedPnl += bet.pnl ?? 0;
    existing.positions += 1;
    existing.openPositions += bet.status === "OPEN" ? 1 : 0;
    games.set(bet.market_slug, existing);
    return games;
  }, new Map<string, {
    slug: string;
    title: string;
    endTime: number;
    totalBet: number;
    totalReturn: number;
    realizedPnl: number;
    positions: number;
    openPositions: number;
  }>()).values()).sort((a, b) => b.endTime - a.endTime);

  const currentChartSample = live && chainlink ? {
    marketSlug: live.slug,
    timestamp: live.fetchedAt,
    btc,
    strike,
    marketUp,
    rawUp: model.raw,
    calibratedUp: model.calibrated,
    outcomeUpProbability: outcomeUpProbability ?? Number.NaN,
    upAsk: live.upAsk,
    upBid: live.upBid,
    downAsk: live.downAsk,
    downBid: live.downBid,
    upEdge: model.upEdge,
    downEdge: model.downEdge,
    selectedEdge: model.selectedEdge,
    valueEdge: model.valueEdge,
    momentum15,
    momentum30,
    momentum60,
    upMove15,
    downMove15,
    upMove30,
    downMove30,
    upSpread: live.upAsk - live.upBid,
    downSpread: live.downAsk - live.downBid,
    selectedSpread: model.selectedSpread,
    upDepth: live.upAskSize,
    downDepth: live.downAskSize,
    selectedDepth: model.selectedDepth,
    choppiness: choppiness60,
    variance,
    qUsed: model.qUsed,
    sigmaBps: Math.sqrt(model.qUsed) * 10_000,
    z: model.z,
    distanceBps: model.distance * 10_000,
    secondsLeft: seconds,
    dataAgeSeconds: dataAge / 1_000,
    selectedAsk: model.selectedAsk,
    orderCost: model.orderCost,
    marketConfidence: model.marketConfidence,
    favoriteConfidence: model.favoriteConfidence,
    bankroll,
    realizedPnl: stats.realized_pnl,
    openStake: stats.open_stake,
  } satisfies ChartSample : null;

  useEffect(() => {
    if (!currentChartSample) return;
    const sample = currentChartSample;
    const pending = window.setTimeout(() => {
      setChartHistory((history) => {
        const currentMarket = history.filter((item) =>
          item.marketSlug === sample.marketSlug &&
          item.timestamp >= sample.timestamp - 240_000
        );
        if (currentMarket.at(-1)?.timestamp === sample.timestamp) return currentMarket;
        return [...currentMarket, sample];
      });
    }, 0);
    return () => window.clearTimeout(pending);
    // Chart history intentionally samples each new Polymarket quote after all model values are computed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.fetchedAt]);

  const outcomeChartHistory = useMemo(() => {
    const latestTimestamp = chartHistory.at(-1)?.timestamp ?? 0;
    return chartHistory.filter((sample) => sample.timestamp >= latestTimestamp - 60_000);
  }, [chartHistory]);

  const currentSnapshot = live && chainlink ? {
    action: "snapshot",
    marketSlug: live.slug,
    btcPrice: btc,
    strikePrice: strike,
    secondsLeft: seconds,
    variance,
    rawProbability: model.raw,
    calibratedProbability: model.calibrated,
    upBid: live.upBid,
    upAsk: live.upAsk,
    downBid: live.downBid,
    downAsk: live.downAsk,
    upAskSize: live.upAskSize,
    upBidSize: live.upBidSize,
    downAskSize: live.downAskSize,
    downBidSize: live.downBidSize,
    spread,
    topDepth: depth,
    dataAgeMs: Math.round(dataAge),
    momentum15Bps: momentum15,
    momentum30Bps: momentum30,
    momentum60Bps: momentum60,
    upContractMove15: upMove15,
    downContractMove15: downMove15,
    upContractMove30: upMove30,
    downContractMove30: downMove30,
    choppiness60,
    volatilityRegime: model.volatilityRegime,
    entryMode: model.blocked ? "WAIT" : model.entryMode,
    requiredEdge: 0,
    signal: model.blocked ? "WAIT" : `BET_${model.entryMode}_${model.side}`,
    blockedReason: model.blockedReasons.join("; "),
  } : null;

  useEffect(() => {
    if (!currentSnapshot || clock - lastSnapshotAt.current < 5_000) return;
    lastSnapshotAt.current = clock;
    const record = async () => {
      try {
        const response = await fetch("/api/paper", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(currentSnapshot),
        });
        if (response.ok) applyLedger(await response.json());
      } catch {
        // Snapshot recording retries after the five-second interval.
      }
    };
    const pending = window.setTimeout(record, 0);
    return () => window.clearTimeout(pending);
    // The recorder intentionally samples the latest complete model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock]);

  return (
    <main>
      <header className="topbar">
        <div className="brand"><div className="mark">W</div><div><strong>WhaleMaker</strong><span>5-minute BTC edge engine</span></div></div>
        <div className="source-pill"><i /> POLYMARKET · CHAINLINK</div>
        <div className="paper-pill"><i /> PAPER TRADING</div>
      </header>

      <section className="shell">
        {(dataError || ledgerError) && <div className="error-banner"><b>Engine paused.</b> {dataError || ledgerError} No bet will be recorded until it recovers.</div>}
        <div className="test-banner"><b>Testing settlement is active.</b> At each five-minute close, the app calculates UP or DOWN from Polymarket&apos;s Chainlink close versus the strike and updates results and balance immediately.</div>
        <div className="status-row">
          <div>
            <p className="eyebrow">BTC UP OR DOWN · 5 MIN</p>
            <h1>Market command center</h1>
            <p className="subtle">{live?.eventTitle ?? "Connecting to the active Polymarket window…"} · Polymarket close in <b>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</b>{live ? ` · ${new Date(live.windowEnd).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}</p>
            {live && <a className="market-link" href={live.marketUrl} target="_blank" rel="noreferrer">View active market on Polymarket ↗</a>}
          </div>
          <div className="controls">
            <span className="engine-lock"><i /> ENGINE ALWAYS ON</span>
            <button className="secondary" onClick={reset}>Reset ledger</button>
          </div>
        </div>

        <nav className="app-tabs" role="tablist" aria-label="WhaleMaker dashboard sections">
          {([
            ["engine", "Live engine", signalLabel],
            ["analytics", "Analytics", `${chartHistory.length} samples`],
            ["positions", "Positions", `${ongoingBets.length} open`],
            ["ledger", "Ledger", `${transactions.length} trades`],
          ] as [AppTab, string, string][]).map(([tab, label, badge]) => (
            <button
              type="button"
              role="tab"
              id={`${tab}-tab`}
              aria-controls={`${tab}-panel`}
              aria-selected={activeTab === tab}
              className={activeTab === tab ? "active" : ""}
              onClick={() => setActiveTab(tab)}
              key={tab}
            >
              <span>{label}</span><b>{badge}</b>
            </button>
          ))}
        </nav>

        {activeTab === "engine" && (
        <div className="tab-panel" id="engine-panel" role="tabpanel" aria-labelledby="engine-tab">
        <section className="market-prices" aria-label="Live Polymarket outcome prices">
          <article className="outcome-price up-price">
            <div>
              <span className="outcome-label"><i /> UP price</span>
              <strong>{live ? `${(live.upAsk * 100).toFixed(1)}¢` : "—"}</strong>
            </div>
            <small>{live ? `${pct(live.upAsk)} implied · ${((live.upBid) * 100).toFixed(1)}¢ bid` : "Waiting for live market"}</small>
          </article>
          <article className="outcome-price down-price">
            <div>
              <span className="outcome-label"><i /> DOWN price</span>
              <strong>{live ? `${(live.downAsk * 100).toFixed(1)}¢` : "—"}</strong>
            </div>
            <small>{live ? `${pct(live.downAsk)} implied · ${((live.downBid) * 100).toFixed(1)}¢ bid` : "Waiting for live market"}</small>
          </article>
        </section>

        <section className="metrics">
          <article><span>Available balance</span><strong>{money(bankroll)}</strong><small>{money(settledBalance)} after results · {money(stats.open_stake)} in open bets</small></article>
          <article><span>Fixed order size</span><strong>5 shares</strong><small>{money(model.orderCost)} at the selected ask · {model.orderCost > 0 ? Math.floor(bankroll / model.orderCost) : 0} orders available</small></article>
          <article><span>Chainlink BTC/USD</span><strong>{btc ? `$${btc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</strong><small className={btc >= strike ? "positive" : "negative"}>{btc && strike ? `${btc >= strike ? "▲" : "▼"} ${Math.abs((btc / strike - 1) * 10000).toFixed(1)} bps vs $${strike.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "Waiting for Polymarket"}</small></article>
          <article><span>Engine state</span><strong className="positive">Always on</strong><small>{freshness} · {dataAge < Infinity ? `${Math.round(dataAge)}ms data age` : "No data yet"}</small></article>
        </section>

        <div className="grid">
          <section className="card signal-card">
            <div className="card-head"><div><p className="eyebrow">CURRENT DECISION</p><h2>Signal</h2></div><span className={`signal ${model.blocked ? "wait" : model.side.toLowerCase()}`}>{signalLabel}</span></div>
            <div className="fair">
              <div className="ring" style={{ "--p": `${marketUp * 360}deg` } as React.CSSProperties}><div><strong>{pct(marketUp)}</strong><span>Market UP</span></div></div>
              <div className="fair-copy">
                <span>Selected contract support</span><strong>{confidence}/100</strong><div className="bar"><i style={{ width: `${confidence}%` }} /></div>
                <p>{model.blocked ? `Waiting: ${model.blockedReasons[0] ?? "confirmation gates do not pass"}.` : `${model.entryMode} entry: ${model.entryReason}.`}</p>
              </div>
            </div>
            <div className="comparison">
              <div><span>Entry method</span><b>{live ? model.entryMode : "—"}</b></div>
              <div><span>Selected ask</span><b>{live ? pct(model.selectedAsk) : "—"}</b></div>
              <div><span>Contract price trend</span><b className={model.contractMove15 >= MIN_MOVE_15 ? "positive" : ""}>{live ? `${model.contractMove15 >= 0 ? "+" : ""}${(model.contractMove15 * 100).toFixed(1)}¢ / 15s` : "—"}</b></div>
            </div>
            <button className="bet-button" disabled={model.blocked || bankroll < model.orderCost || placing || recoveringBetId != null} onClick={() => placeBet()}>{placing ? "Recording paper order…" : recoveringBetId != null ? "Executing recovery exit…" : `Buy 5 ${model.side} shares for ${money(model.orderCost)}`}</button>
            <div className="always-on-row"><span><b>Automatic execution and recovery are locked on</b><small>Value and breakout signals run continuously. Hard stops, thesis invalidation, and trailing profit protection sell at the executable bid.</small></span><strong>ACTIVE</strong></div>
          </section>

          <section className="card">
            <div className="card-head"><div><p className="eyebrow">WHY THE ENGINE DECIDED</p><h2>Dual-strategy health</h2></div><span className={qualityCount === 6 ? "healthy" : "unhealthy"}>● {qualityCount}/6 healthy</span></div>
            <div className="health-list">
              <div><span className="health-icon">↕</span><p><b>Distance from strike</b><small>{live ? `${model.distance >= 0 ? "Above" : "Below"} by ${Math.abs(model.distance * 10000).toFixed(2)} bps` : "Waiting for Chainlink"}</small></p><strong>{live ? model.distance >= 0 ? "UP" : "DOWN" : "WAIT"}</strong></div>
              <div><span className="health-icon">◎</span><p><b>Value setup</b><small>{live ? `${model.marketFavoriteSide} favorite · ${(model.valueEdge * 100).toFixed(1)}¢ fee-adjusted edge` : "Waiting for market"}</small></p><strong>{model.valuePass ? "READY" : "WAIT"}</strong></div>
              <div><span className="health-icon">↑</span><p><b>Contract breakout</b><small>Selected move: {(model.contractMove15 * 100).toFixed(1)}¢ / 15s · {(model.contractMove30 * 100).toFixed(1)}¢ / 30s</small></p><strong>{model.momentumEntryPass ? "READY" : "WAIT"}</strong></div>
              <div><span className="health-icon">↗</span><p><b>Momentum confirmation</b><small>15/30/60s: {momentum15.toFixed(2)} / {momentum30.toFixed(2)} / {momentum60.toFixed(2)} bps</small></p><strong>{model.momentumPass ? "PASS" : "BLOCK"}</strong></div>
              <div><span className="health-icon">≈</span><p><b>Polymarket spread</b><small>UP {live ? `${((live.upAsk - live.upBid) * 100).toFixed(1)}¢` : "—"} · DOWN {live ? `${((live.downAsk - live.downBid) * 100).toFixed(1)}¢` : "—"}</small></p><strong>{model.selectedSpread <= MAX_ENTRY_SPREAD ? "PASS" : "BLOCK"}</strong></div>
              <div><span className="health-icon">◷</span><p><b>Chainlink freshness</b><small>{dataAge < Infinity ? `${Math.round(dataAge)}ms old · 3,000ms limit` : "Connecting"}</small></p><strong>{dataAge <= MAX_DATA_AGE_MS ? "LIVE" : "BLOCK"}</strong></div>
              <div><span className="health-icon">⌁</span><p><b>Selected-side depth</b><small>{model.selectedDepth ? `${model.selectedDepth.toFixed(1)} shares at the top ask` : "No top-of-book depth"}</small></p><strong>{model.selectedDepth >= MIN_ENTRY_DEPTH ? "PASS" : "BLOCK"}</strong></div>
            </div>
            <details>
              <summary>View calculation details <span>⌄</span></summary>
              <div className="formula"><code>Entry = consensus-confirmed value OR rising contract price</code><p>Value route: favorite <b>{model.marketFavoriteSide}</b> at <b>{pct(model.favoriteConfidence)}</b> · needs <b>1.5¢ fee-adjusted edge</b></p><p>Momentum route: <b>2¢/15s + 3¢/30s</b> contract rise, rising bid, ≥45% market support, and matching BTC momentum</p><p>Selected route: <b>{model.entryMode}</b> · side <b>{model.side}</b> · ask <b>{(model.selectedAsk * 100).toFixed(1)}¢</b></p><p>Chainlink model: <b>{model.modelSide}</b> · z-score <b>{model.z.toFixed(3)}</b> · raw UP <b>{pct(model.raw)}</b></p><p>Momentum 15/30/60s: <b>{momentum15.toFixed(2)} / {momentum30.toFixed(2)} / {momentum60.toFixed(2)} bps</b></p><p>Choppiness: <b>{choppiness60.toFixed(2)} / 0.55 max</b> · volatility: <b>{model.volatilityRegime}</b></p><p>Entry window: <b>60–210 seconds</b> · BTC history <b>{Math.floor(historySpanMs / 1_000)}s</b> · quote history <b>{Math.floor(quoteHistorySpanMs / 1_000)}s</b></p><p>Position limit: <b>one per five-minute game</b></p><p>Recovery: <b>{recoveringBetId != null ? "EXITING" : recoveryCandidate ? `TRIGGERED · score ${recoveryCandidate.score}` : "20% hard stop + thesis exit + trailing profit protection"}</b></p></div>
            </details>
          </section>
        </div>
        </div>
        )}

        {activeTab === "analytics" && (
          <section className="tab-panel analytics-panel" id="analytics-panel" role="tabpanel" aria-labelledby="analytics-tab">
            <div className="analytics-head">
              <div>
                <p className="eyebrow">LIVE MODEL TELEMETRY</p>
                <h2>Every numeric input and decision variable</h2>
                <p>Rolling four-minute history sampled from the active Polymarket market. Charts continue collecting while you use the other tabs.</p>
              </div>
              <div className="analytics-status">
                <span><small>Signal</small><b>{signalLabel}</b></span>
                <span><small>Regime</small><b>{model.volatilityRegime}</b></span>
                <span><small>Route</small><b>{model.entryMode}</b></span>
                <span><small>Gate health</small><b>{qualityCount}/6</b></span>
              </div>
            </div>
            <section className="ml-direction-card" aria-labelledby="ml-direction-title">
              <div className="ml-prediction">
                <p className="eyebrow">MARKET OUTCOME FORECAST</p>
                <h3 id="ml-direction-title">Probability this five-minute market settles UP</h3>
                {outcomeModel?.status === "TRAINED" && outcomeUpProbability != null ? (
                  <>
                    <strong className={outcomeUpProbability >= 0.5 ? "positive" : "negative"}>
                      {outcomeUpProbability >= 0.5 ? "UP" : "DOWN"} · {(outcomeUpProbability * 100).toFixed(1)}% UP probability
                    </strong>
                    <div className="ml-probability-bar" aria-label={`Model UP outcome probability ${(outcomeUpProbability * 100).toFixed(1)} percent`}>
                      <i style={{ width: `${outcomeUpProbability * 100}%` }} />
                    </div>
                    <small>CLOB baseline {(marketUp * 100).toFixed(1)}% · model adjustment {outcomeUpProbability - marketUp >= 0 ? "+" : ""}{((outcomeUpProbability - marketUp) * 100).toFixed(1)} points</small>
                  </>
                ) : (
                  <>
                    <strong className="pending-pnl">COLLECTING SETTLED MARKETS</strong>
                    <div className="ml-probability-bar collecting"><i /></div>
                    <small>{outcomeModel?.message ?? "The nonlinear outcome model trains automatically after enough five-minute markets settle."}</small>
                  </>
                )}
              </div>
              <div className="ml-validation">
                <div><span>Held-out log loss</span><b>{outcomeModel?.logLoss == null ? "—" : outcomeModel.logLoss.toFixed(3)}</b></div>
                <div><span>CLOB log loss</span><b>{outcomeModel?.baselineLogLoss == null ? "—" : outcomeModel.baselineLogLoss.toFixed(3)}</b></div>
                <div><span>Brier score</span><b>{outcomeModel?.brierScore == null ? "—" : outcomeModel.brierScore.toFixed(3)}</b></div>
                <div><span>Accuracy</span><b>{outcomeModel?.accuracy == null ? "—" : pct(outcomeModel.accuracy)}</b></div>
                <div><span>Balanced accuracy</span><b>{outcomeModel?.balancedAccuracy == null ? "—" : pct(outcomeModel.balancedAccuracy)}</b></div>
                <div><span>ROC AUC</span><b>{outcomeModel?.auc == null ? "—" : outcomeModel.auc.toFixed(3)}</b></div>
                <p>{outcomeModel?.message ?? "Waiting for settled Polymarket outcomes."} {outcomeModel?.exampleCount ?? 0} labeled snapshots across {outcomeModel?.marketCount ?? 0} markets; {outcomeModel?.testCount ?? 0} later snapshots are held out.</p>
              </div>
            </section>
            <div className="chart-section-head"><span>CORE SIGNALS</span><p>CLOB consensus compared directly with the engine’s BTC calculation, momentum, chop, and volatility.</p></div>
            <div className="chart-grid">
              <MetricChart featured scale="contract" title="UP outcome probability: market, fair & ML" description="The executable UP ask represents the crowd, fair price is the engine calculation, and the nonlinear ML line estimates the probability that the market ultimately settles UP." samples={outcomeChartHistory} format="cents" series={[
                { key: "upAsk", label: "Current UP ask", color: "blue", fill: true },
                { key: "calibratedUp", label: "Fair price", color: "green", style: "dotted" },
                { key: "outcomeUpProbability", label: "ML settlement probability", color: "purple", style: "dashed" },
              ]} />
              <MetricChart title="BTC momentum" description="Log-return momentum across the engine’s 15, 30, and 60-second lookbacks." samples={chartHistory} format="bps" series={[
                { key: "momentum15", label: "15 seconds", color: "green" },
                { key: "momentum30", label: "30 seconds", color: "blue" },
                { key: "momentum60", label: "60 seconds", color: "purple" },
              ]} />
              <MetricChart title="Choppiness" description="Fraction of recent BTC direction changes. The engine blocks entries above the ceiling." samples={chartHistory} format="number" referenceLines={[
                { value: 0.55, label: "0.55 entry ceiling", color: "amber" },
              ]} series={[
                { key: "choppiness", label: "60s choppiness", color: "amber" },
              ]} />
              <MetricChart title="Instant volatility" description="Standard deviation in basis points per square-root second, with the engine’s regime boundaries." samples={chartHistory} format="bps" referenceLines={[
                { value: 0.5, label: "MEDIUM begins", color: "amber" },
                { value: 1.25, label: "HIGH begins", color: "red" },
              ]} series={[
                { key: "sigmaBps", label: "Sigma", color: "red" },
              ]} />
            </div>

            <div className="chart-section-head"><span>MARKET &amp; MODEL</span><p>Reference price, crowd probability, model probability, quotes, and edge.</p></div>
            <div className="chart-grid">
              <MetricChart title="BTC reference vs strike" description="Chainlink BTC/USD and this game’s Polymarket strike." samples={chartHistory} format="usd" series={[
                { key: "btc", label: "BTC", color: "green" },
                { key: "strike", label: "Strike", color: "amber" },
              ]} />
              <MetricChart title="UP probability" description="Crowd midpoint, standalone Chainlink model, and blended calibration." samples={chartHistory} format="percent" series={[
                { key: "marketUp", label: "Market", color: "blue" },
                { key: "rawUp", label: "Raw model", color: "purple" },
                { key: "calibratedUp", label: "Calibrated", color: "green" },
              ]} />
              <MetricChart title="Polymarket order book" description="Executable asks and bids for both outcomes." samples={chartHistory} format="cents" series={[
                { key: "upAsk", label: "UP ask", color: "green" },
                { key: "upBid", label: "UP bid", color: "cyan" },
                { key: "downAsk", label: "DOWN ask", color: "red" },
                { key: "downBid", label: "DOWN bid", color: "amber" },
              ]} />
              <MetricChart title="Fee-adjusted edge" description="Estimated edge after fees, slippage allowance, and spread penalty." samples={chartHistory} format="cents" series={[
                { key: "upEdge", label: "UP edge", color: "green" },
                { key: "downEdge", label: "DOWN edge", color: "red" },
                { key: "selectedEdge", label: "Selected", color: "blue" },
                { key: "valueEdge", label: "Value route", color: "purple" },
              ]} />
              <MetricChart title="Model z-score" description="Standardized strike distance after volatility and time remaining." samples={chartHistory} format="number" series={[
                { key: "z", label: "Z-score", color: "purple" },
              ]} />
              <MetricChart title="Distance from strike" description="Direct Chainlink BTC distance from the current strike." samples={chartHistory} format="bps" series={[
                { key: "distanceBps", label: "Distance bps", color: "amber" },
              ]} />
              <MetricChart title="Market confidence" description="Support for the selected contract and the crowd favorite." samples={chartHistory} format="percent" series={[
                { key: "marketConfidence", label: "Selected support", color: "green" },
                { key: "favoriteConfidence", label: "Favorite support", color: "blue" },
              ]} />
            </div>

            <div className="chart-section-head"><span>CONTRACT &amp; CALIBRATION</span><p>Contract-price confirmation and the variance values used by the probability model.</p></div>
            <div className="chart-grid">
              <MetricChart title="Contract movement" description="Midpoint movement used to confirm a rising contract." samples={chartHistory} format="cents" series={[
                { key: "upMove15", label: "UP 15s", color: "green" },
                { key: "upMove30", label: "UP 30s", color: "cyan" },
                { key: "downMove15", label: "DOWN 15s", color: "red" },
                { key: "downMove30", label: "DOWN 30s", color: "amber" },
              ]} />
              <MetricChart title="Variance calibration" description="Estimated one-second variance and the floored value used by the model." samples={chartHistory} format="scientific" series={[
                { key: "variance", label: "Estimated", color: "blue" },
                { key: "qUsed", label: "Used", color: "purple" },
              ]} />
            </div>

            <div className="chart-section-head"><span>EXECUTION &amp; ACCOUNT</span><p>Liquidity, timing, order cost, and paper portfolio state.</p></div>
            <div className="chart-grid">
              <MetricChart title="Top-of-book spread" description="UP, DOWN, and currently selected contract spreads." samples={chartHistory} format="cents" series={[
                { key: "upSpread", label: "UP", color: "green" },
                { key: "downSpread", label: "DOWN", color: "red" },
                { key: "selectedSpread", label: "Selected", color: "blue" },
              ]} />
              <MetricChart title="Ask-side depth" description="Shares available at the best ask, including selected-side depth." samples={chartHistory} format="number" series={[
                { key: "upDepth", label: "UP depth", color: "green" },
                { key: "downDepth", label: "DOWN depth", color: "red" },
                { key: "selectedDepth", label: "Selected", color: "blue" },
              ]} />
              <MetricChart title="Entry price" description="Selected contract ask and the resulting five-share order cost." samples={chartHistory} format="cents" series={[
                { key: "selectedAsk", label: "Selected ask", color: "green" },
              ]} />
              <MetricChart title="Five-share order cost" description="Cash required for the fixed order at the selected ask." samples={chartHistory} format="dollars" series={[
                { key: "orderCost", label: "Order cost", color: "amber" },
              ]} />
              <MetricChart title="Market clock & feed age" description="Seconds until settlement and Chainlink data age." samples={chartHistory} format="seconds" series={[
                { key: "secondsLeft", label: "Time left", color: "amber" },
                { key: "dataAgeSeconds", label: "Data age", color: "cyan" },
              ]} />
              <MetricChart title="Paper account" description="Available cash, realized P&L, and cash committed to open positions." samples={chartHistory} format="dollars" series={[
                { key: "bankroll", label: "Cash", color: "green" },
                { key: "realizedPnl", label: "Realized P&L", color: "blue" },
                { key: "openStake", label: "Open stake", color: "amber" },
              ]} />
            </div>
          </section>
        )}

        {(activeTab === "positions" || activeTab === "ledger") && (
        <section className="card ledger tab-panel" id={`${activeTab}-panel`} role="tabpanel" aria-labelledby={`${activeTab}-tab`}>
          <div className="card-head ledger-head">
            {activeTab === "positions" ? (
              <div><p className="eyebrow">POSITION CONTROL</p><h2>Open positions and game results</h2><p className="ledger-explainer">Track executable exit value, unrealized P&amp;L, stops, and total return for every five-minute game.</p></div>
            ) : (
              <div><p className="eyebrow">PERSISTENT PAPER LEDGER</p><h2>Share transactions</h2><p className="ledger-explainer">Match BUY and SELL using the position number. P&amp;L appears on the SELL row after that position closes.</p></div>
            )}
            {activeTab === "ledger" && <a className="csv-button" href="/api/paper?format=csv" download>↓ Download CSV</a>}
          </div>
          <div className="transaction-summary">
            <div><span>Available cash</span><strong>{money(bankroll)}</strong></div>
            <div><span>Shares currently held</span><strong>{sharesHeld.toFixed(2)}</strong></div>
            <div><span>Paid for buys shown</span><strong className="negative">−{money(cashPaid)}</strong></div>
            <div><span>Received from sells shown</span><strong className="positive">+{money(cashReceived)}</strong></div>
            <div><span>Total realized P&amp;L</span><strong className={stats.realized_pnl >= 0 ? "positive" : "negative"}>{stats.realized_pnl >= 0 ? "+" : "−"}{money(Math.abs(stats.realized_pnl))}</strong></div>
          </div>
          {activeTab === "positions" && (
          <>
          <section className="ongoing-bets" aria-labelledby="ongoing-bets-title">
            <div className="ongoing-head">
              <div><p className="eyebrow">LIVE POSITIONS</p><h3 id="ongoing-bets-title">Ongoing bets</h3></div>
              <span className="ongoing-count"><i /> {ongoingBets.length} OPEN</span>
            </div>
            {ongoingBets.length === 0 ? (
              <p className="game-empty">There are no ongoing bets right now.</p>
            ) : (
              <div className="ongoing-table">
                <div className="ongoing-row ongoing-header"><span>Position / game</span><span>Direction</span><span>Shares</span><span>Entry</span><span>Total bet</span><span>Current exit value</span><span>Unrealized P&amp;L</span></div>
                {ongoingBets.map((bet) => (
                  <div className="ongoing-row" key={bet.id}>
                    <span><b>#{bet.id} · ends {new Date(bet.market_end_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b><small>{bet.entry_mode ?? "VALUE"} · {bet.entry_reason ?? "legacy entry"} · {new Date(bet.placed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small></span>
                    <b className={bet.side === "UP" ? "positive" : "negative"}>{bet.side}</b>
                    <strong>{bet.shares.toFixed(2)}</strong>
                    <span>{(bet.entry_price * 100).toFixed(1)}¢</span>
                    <strong className="negative">{money(bet.stake)}</strong>
                    <span><strong>{bet.currentValue == null ? "—" : money(bet.currentValue)}</strong><small>{bet.currentBid == null ? "Waiting for live bid" : `bid ${(bet.currentBid * 100).toFixed(1)}¢ · peak ${(bet.peakBid * 100).toFixed(1)}¢ · stop ${(bet.hardStopBid * 100).toFixed(1)}¢`}</small></span>
                    <strong className={bet.unrealizedPnl == null ? "pending-pnl" : bet.unrealizedPnl >= 0 ? "positive" : "negative"}>{bet.unrealizedPnl == null ? "—" : `${bet.unrealizedPnl >= 0 ? "+" : "−"}${money(Math.abs(bet.unrealizedPnl))}`}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="game-totals" aria-labelledby="game-totals-title">
            <div className="game-totals-head">
              <div><p className="eyebrow">PER 5-MINUTE MARKET</p><h3 id="game-totals-title">Total bet and return per game</h3></div>
              <span>Return is cash received, not profit.</span>
            </div>
            {gameTotals.length === 0 ? (
              <p className="game-empty">Game totals will appear after the first purchase.</p>
            ) : (
              <div className="game-table">
                <div className="game-row game-header"><span>Game</span><span>Total bet</span><span>Total return</span><span>Realized P&amp;L</span></div>
                {gameTotals.map((game) => (
                  <div className="game-row" key={game.slug}>
                    <span><b>Ends {new Date(game.endTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b><small>{game.positions} purchase{game.positions === 1 ? "" : "s"} · {game.openPositions ? `${game.openPositions} still open` : "complete"}</small></span>
                    <strong className="negative">{money(game.totalBet)}</strong>
                    <span><strong className="positive">{money(game.totalReturn)}</strong><small>{game.openPositions ? "return so far" : "final return"}</small></span>
                    <strong className={game.realizedPnl >= 0 ? "positive" : "negative"}>{game.realizedPnl >= 0 ? "+" : "−"}{money(Math.abs(game.realizedPnl))}</strong>
                  </div>
                ))}
              </div>
            )}
          </section>
          </>
          )}
          {activeTab === "ledger" && (
          <>
          <div className="ledger-tabs" role="tablist" aria-label="Share transaction filters">
            <button type="button" role="tab" aria-selected={transactionFilter === "all"} className={transactionFilter === "all" ? "active" : ""} onClick={() => setTransactionFilter("all")}>All <b>{transactions.length}</b></button>
            <button type="button" role="tab" aria-selected={transactionFilter === "buy"} className={transactionFilter === "buy" ? "active" : ""} onClick={() => setTransactionFilter("buy")}>Buys <b>{buyCount}</b></button>
            <button type="button" role="tab" aria-selected={transactionFilter === "sell"} className={transactionFilter === "sell" ? "active" : ""} onClick={() => setTransactionFilter("sell")}>Sells <b>{sellCount}</b></button>
          </div>
          <div className="table">
            <div className="tr transaction-row header"><span>Action</span><span>Time</span><span>Position</span><span>Direction</span><span>Settlement</span><span>Price / share</span><span>Cash paid / received</span><span>Profit / loss</span></div>
            {visibleTransactions.length === 0 ? (
              <div className="empty">
                <span>◎</span>
                <b>No {transactionFilter === "all" ? "share transactions" : `${transactionFilter} transactions`} yet</b>
                <p>New purchases and sales will appear here automatically.</p>
              </div>
            ) : (
              visibleTransactions.map((transaction) => (
                <div className="tr transaction-row" key={transaction.id}>
                  <span className={`trade-action ${transaction.action.toLowerCase()}`}>{transaction.action}</span>
                  <span>{new Date(transaction.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span><b>#{transaction.positionId}</b><small>{transaction.description}</small></span>
                  <b className={transaction.side === "UP" ? "positive" : "negative"}>{transaction.side}</b>
                  <b className={transaction.settlementSide === "UP" ? "positive" : transaction.settlementSide === "DOWN" ? "negative" : "pending-pnl"}>
                    {transaction.settlementSide ?? (transaction.exitedEarly ? "Early exit" : "Pending")}
                  </b>
                  <span>{(transaction.price * 100).toFixed(1)}¢</span>
                  <strong className={transaction.action === "BUY" ? "negative" : "positive"}>{transaction.cashFlow >= 0 ? "+" : "−"}{money(Math.abs(transaction.cashFlow))}</strong>
                  <strong className={transaction.pnl == null ? "pending-pnl" : transaction.pnl >= 0 ? "positive" : "negative"}>{transaction.pnl == null ? "—" : `${transaction.pnl >= 0 ? "+" : "−"}${money(Math.abs(transaction.pnl))}`}</strong>
                </div>
              ))
            )}
          </div>
          <p className="csv-note">BUY shows what the shares cost. SELL shows what came back and the final P&amp;L versus the matching BUY. The CSV keeps the complete underlying trade record. · {snapshotCount} model samples stored.</p>
          </>
          )}
        </section>
        )}
        <footer><span>Live Polymarket data · Paper execution only · No real funds at risk</span><span>Immediate self-calculated test settlement</span></footer>
      </section>
    </main>
  );
}
