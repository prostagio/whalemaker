"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Side = "UP" | "DOWN";
type Bet = {
  id: number;
  condition_id: string;
  market_slug: string;
  side: Side;
  stake: number;
  shares: number | null;
  entry_price: number;
  edge: number;
  status: "OPEN" | "WON" | "LOST" | "EXITED" | "VOID";
  settlement_outcome: string | null;
  payout: number | null;
  pnl: number | null;
  placed_at: number;
  settled_at: number | null;
};
type TransactionFilter = "all" | "buy" | "sell";
type ShareTransaction = {
  id: string;
  positionId: number;
  action: "BUY" | "SELL";
  time: number;
  side: Side;
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

const VARIANCE_FLOOR = 2.3020308442843487e-9;
const FIXED_SHARES = 5;
const normalCdf = (x: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? p : 1 - p;
};
const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

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
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>("all");
  const [lastBetAt, setLastBetAt] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const [tickHistory, setTickHistory] = useState<{ price: number; timestamp: number }[]>([]);
  const previousTick = useRef<{ price: number; timestamp: number } | null>(null);
  const lastSnapshotAt = useRef(0);

  const applyLedger = (payload: {
    account?: { balance?: number; starting_balance?: number };
    bets?: Bet[];
    stats?: typeof stats;
    snapshotCount?: number;
  }) => {
    if (typeof payload.account?.balance === "number") setBankroll(payload.account.balance);
    if (typeof payload.account?.starting_balance === "number") setStartingBalance(payload.account.starting_balance);
    if (payload.bets) setBets(payload.bets);
    if (payload.stats) setStats(payload.stats);
    if (typeof payload.snapshotCount === "number") setSnapshotCount(payload.snapshotCount);
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
    const load = async () => {
      try {
        const response = await fetch("/api/polymarket", { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Live market data failed.");
        if (active) {
          setLive(payload);
          setDataError("");
        }
      } catch (error) {
        if (active) setDataError(error instanceof Error ? error.message : "Live market data failed.");
      }
    };
    load();
    const poller = window.setInterval(load, 1_000);
    const ticker = window.setInterval(() => setClock(Date.now()), 250);
    return () => {
      active = false;
      window.clearInterval(poller);
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
  const marketUp = live ? (live.upAsk + live.upBid) / 2 : 0.5;
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

  const model = useMemo(() => {
    const qUsed = Math.max(variance, VARIANCE_FLOOR);
    const distance = btc > 0 && strike > 0 ? Math.log(btc / strike) : 0;
    const z = seconds > 0 ? distance / Math.sqrt(qUsed * seconds) : 0;
    const raw = normalCdf(z);
    const calibrated = Math.min(0.99, Math.max(0.01, raw * 0.5 + marketUp * 0.5));
    const upAsk = live?.upAsk ?? 1;
    const downAsk = live?.downAsk ?? 1;
    const spreadPenalty = 0.5 * spread;
    const upEdge = calibrated - upAsk - 0.01 - spreadPenalty;
    const downEdge = 1 - calibrated - downAsk - 0.01 - spreadPenalty;
    const side: Side = upEdge >= downEdge ? "UP" : "DOWN";
    const bestEdge = Math.max(upEdge, downEdge);
    const orderCost = FIXED_SHARES * (side === "UP" ? upAsk : downAsk);
    const sigmaBpsPerSqrtSecond = Math.sqrt(qUsed) * 10_000;
    const volatilityRegime =
      sigmaBpsPerSqrtSecond < 0.5 ? "LOW" : sigmaBpsPerSqrtSecond < 1.25 ? "MEDIUM" : "HIGH";
    const disagreement = Math.abs(raw - marketUp);
    const sameSideLead = side === "UP" ? raw - marketUp : marketUp - raw;
    const adaptiveEligible =
      volatilityRegime !== "HIGH" && sameSideLead >= 0.0025 && disagreement <= 0.06;
    const requiredEdge = adaptiveEligible ? 0.005 : 0.02;
    const dominantPrice = Math.max(upAsk, downAsk);
    const qualityPass = Boolean(live?.acceptingOrders) && spread <= 0.04 && depth >= 5 && dataAge <= 1_000;
    const blockedReasons = [
      !live ? "no active Polymarket market" : "",
      !chainlink || feedStatus !== "live" ? "Chainlink feed offline" : "",
      dataError ? "market API unavailable" : "",
      ledgerError ? "paper database unavailable" : "",
      seconds < 15 ? "less than 15 seconds remain" : "",
      bestEdge < requiredEdge ? `edge below ${(requiredEdge * 100).toFixed(1)}¢` : "",
      dominantPrice < 0.8 ? "no outcome is at least 80¢" : "",
      bankroll < orderCost ? `balance below ${money(orderCost)} order cost` : "",
      spread > 0.04 ? "spread above 4¢" : "",
      depth < 5 ? "top depth below 5 shares" : "",
      dataAge > 1_000 ? "Chainlink data older than 1,000ms" : "",
      !live?.acceptingOrders ? "Polymarket is not accepting orders" : "",
    ].filter(Boolean);
    const blocked = blockedReasons.length > 0;
    return {
      qUsed, distance, z, raw, calibrated, upAsk, downAsk, upEdge, downEdge,
      side, bestEdge, blocked, qualityPass, blockedReasons, volatilityRegime,
      requiredEdge, adaptiveEligible, orderCost,
    };
  }, [bankroll, btc, chainlink, dataAge, dataError, depth, feedStatus, ledgerError, live, marketUp, seconds, spread, strike, variance]);

  const placeBet = async (side = model.side) => {
    if (bankroll < model.orderCost || model.blocked || !live || placing) return;
    const edge = side === "UP" ? model.upEdge : model.downEdge;
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
          fairProbability: side === "UP" ? model.calibrated : 1 - model.calibrated,
          edge,
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
    if (!live || !chainlink || dataAge > 1_000 || spread > 0.04 || seconds <= 3) return null;
    const candidates = bets
      .filter((bet) =>
        bet.status === "OPEN" &&
        bet.market_slug === live.slug &&
        clock - bet.placed_at >= 10_000
      )
      .map((bet) => {
        const currentBid = bet.side === "UP" ? live.upBid : live.downBid;
        const bidSize = bet.side === "UP" ? live.upBidSize : live.downBidSize;
        const shares = bet.shares ?? bet.stake / bet.entry_price;
        const unrealizedPnl = shares * currentBid - bet.stake;
        const originalFair = bet.side === "UP" ? model.calibrated : 1 - model.calibrated;
        const rawOriginalFair = bet.side === "UP" ? model.raw : 1 - model.raw;
        const modelFlipped = model.side !== bet.side;
        const strikeAgainst = bet.side === "UP" ? btc < strike : btc >= strike;
        const adverseMomentum = [momentum15, momentum30, momentum60].filter((value) =>
          bet.side === "UP" ? value <= -0.5 : value >= 0.5
        ).length;
        const lossLimit = -bet.stake * (
          model.volatilityRegime === "HIGH" ? 0.3 :
          model.volatilityRegime === "MEDIUM" ? 0.4 :
          0.5
        );
        const hardLoss = unrealizedPnl <= lossLimit;
        const choppy = choppiness60 > 0.65;
        const score =
          (modelFlipped ? 2 : 0) +
          (strikeAgainst ? 2 : 0) +
          (originalFair < 0.45 ? 1 : 0) +
          (rawOriginalFair < 0.4 ? 1 : 0) +
          (adverseMomentum >= 2 ? 2 : 0) +
          (adverseMomentum === 3 ? 1 : 0) +
          (hardLoss ? 2 : 0) +
          (seconds <= 60 ? 1 : 0) -
          (choppy ? 2 : 0);
        const liquidExit =
          live.acceptingOrders &&
          currentBid > 0 &&
          bidSize >= shares;
        const confirmedFlip =
          modelFlipped &&
          strikeAgainst &&
          adverseMomentum >= 2 &&
          originalFair < 0.45 &&
          !choppy &&
          score >= 6;
        const emergencyStop =
          hardLoss &&
          modelFlipped &&
          strikeAgainst &&
          score >= 5;
        const lateDefense =
          seconds <= 45 &&
          modelFlipped &&
          strikeAgainst &&
          originalFair < 0.35 &&
          adverseMomentum >= 1;
        return {
          bet,
          currentBid,
          unrealizedPnl,
          score,
          originalFair,
          adverseMomentum,
          liquidExit,
          shouldExit: liquidExit && (confirmedFlip || emergencyStop || lateDefense),
          reason: `${emergencyStop ? "volatility stop" : lateDefense ? "late-window defense" : "confirmed reversal"}; score ${score}; fair ${(originalFair * 100).toFixed(1)}%; momentum ${adverseMomentum}/3; ${model.volatilityRegime.toLowerCase()} volatility`,
        };
      })
      .filter((candidate) => candidate.shouldExit)
      .sort((a, b) => a.unrealizedPnl - b.unrealizedPnl);
    return candidates[0] ?? null;
  }, [bets, btc, chainlink, choppiness60, clock, dataAge, live, model.calibrated, model.raw, model.side, model.volatilityRegime, momentum15, momentum30, momentum60, seconds, spread, strike]);

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

  const confidence = Math.min(99, Math.round(Math.abs(model.calibrated - 0.5) * 120 + 42));
  const signalLabel = model.blocked ? "WAIT" : `BET ${model.side}`;
  const freshness = dataAge <= 1_000 ? "LIVE" : dataAge < Infinity ? "STALE" : feedStatus.toUpperCase();
  const qualityCount = [spread <= 0.04, depth >= 5, dataAge <= 1_000, Boolean(live?.acceptingOrders)].filter(Boolean).length;
  const settledBalance = startingBalance + stats.realized_pnl;
  const transactions = bets.flatMap<ShareTransaction>((bet) => {
    const shares = bet.shares ?? bet.stake / bet.entry_price;
    const rows: ShareTransaction[] = [{
      id: `buy-${bet.id}`,
      positionId: bet.id,
      action: "BUY",
      time: bet.placed_at,
      side: bet.side,
      shares,
      price: bet.entry_price,
      cashFlow: -bet.stake,
      pnl: null,
      description: `${shares.toFixed(2)} ${bet.side} shares`,
    }];
    if (bet.status !== "OPEN" && bet.status !== "VOID" && bet.settled_at != null) {
      const cashReceived = bet.payout ?? 0;
      rows.push({
        id: `sell-${bet.id}`,
        positionId: bet.id,
        action: "SELL",
        time: bet.settled_at,
        side: bet.side,
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
    spread,
    topDepth: depth,
    dataAgeMs: Math.round(dataAge),
    momentum15Bps: momentum15,
    momentum30Bps: momentum30,
    momentum60Bps: momentum60,
    choppiness60,
    volatilityRegime: model.volatilityRegime,
    requiredEdge: model.requiredEdge,
    signal: model.blocked ? "WAIT" : `BET_${model.side}`,
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
              <div className="ring" style={{ "--p": `${model.calibrated * 360}deg` } as React.CSSProperties}><div><strong>{pct(model.calibrated)}</strong><span>Fair UP</span></div></div>
              <div className="fair-copy">
                <span>Model confidence</span><strong>{confidence}/100</strong><div className="bar"><i style={{ width: `${confidence}%` }} /></div>
                <p>{model.blocked ? "The edge or a live-data safety gate does not pass. No bet will be placed." : `${model.side} clears all risk gates with ${(model.bestEdge * 100).toFixed(1)}¢ net edge.`}</p>
              </div>
            </div>
            <div className="comparison">
              <div><span>Model fair UP</span><b>{pct(model.calibrated)}</b></div>
              <div><span>Polymarket UP ask</span><b>{live ? pct(model.upAsk) : "—"}</b></div>
              <div><span>Net edge</span><b className={model.bestEdge >= 0.02 ? "positive" : ""}>{live ? `${(model.bestEdge * 100).toFixed(1)}¢` : "—"}</b></div>
            </div>
            <button className="bet-button" disabled={model.blocked || bankroll < model.orderCost || placing || recoveringBetId != null} onClick={() => placeBet()}>{placing ? "Recording paper order…" : recoveringBetId != null ? "Executing recovery exit…" : `Buy 5 ${model.side} shares for ${money(model.orderCost)}`}</button>
            <div className="always-on-row"><span><b>Automatic execution and recovery are locked on</b><small>Entry signals run continuously. Confirmed reversals exit at the executable bid instead of doubling the stake.</small></span><strong>ACTIVE</strong></div>
          </section>

          <section className="card">
            <div className="card-head"><div><p className="eyebrow">WHY THE MODEL DECIDED</p><h2>Signal health</h2></div><span className={qualityCount === 4 ? "healthy" : "unhealthy"}>● {qualityCount}/4 healthy</span></div>
            <div className="health-list">
              <div><span className="health-icon">↕</span><p><b>Distance from strike</b><small>{live ? `${model.distance >= 0 ? "Above" : "Below"} by ${Math.abs(model.distance * 10000).toFixed(2)} bps` : "Waiting for Chainlink"}</small></p><strong>{live ? model.distance >= 0 ? "UP" : "DOWN" : "WAIT"}</strong></div>
              <div><span className="health-icon">≈</span><p><b>Polymarket spread</b><small>UP {live ? `${((live.upAsk - live.upBid) * 100).toFixed(1)}¢` : "—"} · DOWN {live ? `${((live.downAsk - live.downBid) * 100).toFixed(1)}¢` : "—"}</small></p><strong>{spread <= 0.04 ? "PASS" : "BLOCK"}</strong></div>
              <div><span className="health-icon">◷</span><p><b>Chainlink freshness</b><small>{dataAge < Infinity ? `${Math.round(dataAge)}ms old` : "Connecting"}</small></p><strong>{dataAge <= 1_000 ? "LIVE" : "BLOCK"}</strong></div>
              <div><span className="health-icon">⌁</span><p><b>Executable depth</b><small>{depth ? `${depth.toFixed(1)} shares at the thinner top ask` : "No top-of-book depth"}</small></p><strong>{depth >= 5 ? "PASS" : "BLOCK"}</strong></div>
            </div>
            <details>
              <summary>View calculation details <span>⌄</span></summary>
              <div className="formula"><code>z = ln(S/K) ÷ √(q × T)</code><p>z-score <b>{model.z.toFixed(3)}</b> · raw probability <b>{pct(model.raw)}</b></p><p>50% Chainlink fair model + 50% Polymarket midpoint</p><p>Momentum 15/30/60s: <b>{momentum15.toFixed(2)} / {momentum30.toFixed(2)} / {momentum60.toFixed(2)} bps</b></p><p>Choppiness 60s: <b>{choppiness60.toFixed(2)}</b> · volatility: <b>{model.volatilityRegime}</b></p><p>Required edge: <b>{(model.requiredEdge * 100).toFixed(1)}¢</b>{model.adaptiveEligible ? " adaptive tier" : " normal tier"}</p><p>Recovery: <b>{recoveringBetId != null ? "EXITING" : recoveryCandidate ? `TRIGGERED · score ${recoveryCandidate.score}` : "MONITORING"}</b></p></div>
            </details>
          </section>
        </div>

        <section className="card ledger">
          <div className="card-head ledger-head">
            <div><p className="eyebrow">PERSISTENT PAPER LEDGER</p><h2>Share transactions</h2><p className="ledger-explainer">Match BUY and SELL using the position number. P&amp;L appears on the SELL row after that position closes.</p></div>
            <a className="csv-button" href="/api/paper?format=csv" download>↓ Download CSV</a>
          </div>
          <div className="transaction-summary">
            <div><span>Available cash</span><strong>{money(bankroll)}</strong></div>
            <div><span>Shares currently held</span><strong>{sharesHeld.toFixed(2)}</strong></div>
            <div><span>Paid for buys shown</span><strong className="negative">−{money(cashPaid)}</strong></div>
            <div><span>Received from sells shown</span><strong className="positive">+{money(cashReceived)}</strong></div>
            <div><span>Total realized P&amp;L</span><strong className={stats.realized_pnl >= 0 ? "positive" : "negative"}>{stats.realized_pnl >= 0 ? "+" : "−"}{money(Math.abs(stats.realized_pnl))}</strong></div>
          </div>
          <div className="ledger-tabs" role="tablist" aria-label="Share transaction filters">
            <button type="button" role="tab" aria-selected={transactionFilter === "all"} className={transactionFilter === "all" ? "active" : ""} onClick={() => setTransactionFilter("all")}>All <b>{transactions.length}</b></button>
            <button type="button" role="tab" aria-selected={transactionFilter === "buy"} className={transactionFilter === "buy" ? "active" : ""} onClick={() => setTransactionFilter("buy")}>Buys <b>{buyCount}</b></button>
            <button type="button" role="tab" aria-selected={transactionFilter === "sell"} className={transactionFilter === "sell" ? "active" : ""} onClick={() => setTransactionFilter("sell")}>Sells <b>{sellCount}</b></button>
          </div>
          {visibleTransactions.length === 0 ? (
            <div className="empty">
              <span>◎</span>
              <b>No {transactionFilter === "all" ? "share transactions" : `${transactionFilter} transactions`} yet</b>
              <p>New purchases and sales will appear here automatically.</p>
            </div>
          ) : (
            <div className="table">
              <div className="tr transaction-row header"><span>Action</span><span>Time</span><span>Position</span><span>Direction</span><span>Price / share</span><span>Cash paid / received</span><span>Profit / loss</span></div>
              {visibleTransactions.map((transaction) => (
                <div className="tr transaction-row" key={transaction.id}>
                  <span className={`trade-action ${transaction.action.toLowerCase()}`}>{transaction.action}</span>
                  <span>{new Date(transaction.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <span><b>#{transaction.positionId}</b><small>{transaction.description}</small></span>
                  <b className={transaction.side === "UP" ? "positive" : "negative"}>{transaction.side}</b>
                  <span>{(transaction.price * 100).toFixed(1)}¢</span>
                  <strong className={transaction.action === "BUY" ? "negative" : "positive"}>{transaction.cashFlow >= 0 ? "+" : "−"}{money(Math.abs(transaction.cashFlow))}</strong>
                  <strong className={transaction.pnl == null ? "pending-pnl" : transaction.pnl >= 0 ? "positive" : "negative"}>{transaction.pnl == null ? "—" : `${transaction.pnl >= 0 ? "+" : "−"}${money(Math.abs(transaction.pnl))}`}</strong>
                </div>
              ))}
            </div>
          )}
          <p className="csv-note">BUY shows what the shares cost. SELL shows what came back and the final P&amp;L versus the matching BUY. The CSV keeps the complete underlying trade record. · {snapshotCount} model samples stored.</p>
        </section>
        <footer><span>Live Polymarket data · Paper execution only · No real funds at risk</span><span>Immediate self-calculated test settlement</span></footer>
      </section>
    </main>
  );
}
