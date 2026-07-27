"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Side = "UP" | "DOWN";
type Bet = { id: number; side: Side; price: number; edge: number; result: "OPEN" };
type LiveMarket = {
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
  downAskSize: number;
  fetchedAt: number;
};

const VARIANCE_FLOOR = 2.3020308442843487e-9;
const normalCdf = (x: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? p : 1 - p;
};
const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export default function Home() {
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<LiveMarket | null>(null);
  const [chainlink, setChainlink] = useState<{ price: number; timestamp: number } | null>(null);
  const [dataError, setDataError] = useState("");
  const [feedStatus, setFeedStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const [variance, setVariance] = useState(VARIANCE_FLOOR);
  const [bankroll, setBankroll] = useState(100);
  const [bets, setBets] = useState<Bet[]>([]);
  const [autoBet, setAutoBet] = useState(true);
  const [lastBetAt, setLastBetAt] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const previousTick = useRef<{ price: number; timestamp: number } | null>(null);

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
            setChainlink({
              price: Number(payload.value),
              timestamp: Number(payload.timestamp) || Number(message.timestamp) || Date.now(),
            });
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
    const qualityPass = Boolean(live?.acceptingOrders) && spread <= 0.04 && depth >= 5 && dataAge <= 1_000;
    const blocked = !live || !chainlink || feedStatus !== "live" || Boolean(dataError) || seconds < 15 || bestEdge < 0.02 || bankroll < 5 || !qualityPass;
    return { qUsed, distance, z, raw, calibrated, upAsk, downAsk, upEdge, downEdge, side, bestEdge, blocked, qualityPass };
  }, [bankroll, btc, chainlink, dataAge, dataError, depth, feedStatus, live, marketUp, seconds, spread, strike, variance]);

  const placeBet = (side = model.side) => {
    if (bankroll < 5 || model.blocked) return;
    const edge = side === "UP" ? model.upEdge : model.downEdge;
    const price = side === "UP" ? model.upAsk : model.downAsk;
    setBankroll((value) => value - 5);
    setBets((value) => [{ id: Date.now(), side, price, edge, result: "OPEN" }, ...value].slice(0, 8));
    setLastBetAt(Date.now());
  };

  useEffect(() => {
    if (running && autoBet && !model.blocked && Date.now() - lastBetAt > 20_000) placeBet();
    // The live model intentionally controls this effect cadence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, autoBet, model.blocked, model.side]);

  const reset = () => {
    setBankroll(100);
    setBets([]);
    setRunning(false);
    setLastBetAt(0);
  };

  const confidence = Math.min(99, Math.round(Math.abs(model.calibrated - 0.5) * 120 + 42));
  const signalLabel = model.blocked ? "WAIT" : `BET ${model.side}`;
  const freshness = dataAge <= 1_000 ? "LIVE" : dataAge < Infinity ? "STALE" : feedStatus.toUpperCase();
  const qualityCount = [spread <= 0.04, depth >= 5, dataAge <= 1_000, Boolean(live?.acceptingOrders)].filter(Boolean).length;

  return (
    <main>
      <header className="topbar">
        <div className="brand"><div className="mark">W</div><div><strong>WhaleMaker</strong><span>5-minute BTC edge engine</span></div></div>
        <div className="source-pill"><i /> POLYMARKET · CHAINLINK</div>
        <div className="paper-pill"><i /> PAPER TRADING</div>
      </header>

      <section className="shell">
        {dataError && <div className="error-banner"><b>Live data paused.</b> {dataError} The engine will not bet until the feed recovers.</div>}
        <div className="status-row">
          <div>
            <p className="eyebrow">BTC UP OR DOWN · 5 MIN</p>
            <h1>Market command center</h1>
            <p className="subtle">{live?.eventTitle ?? "Connecting to the active Polymarket window…"} · Settlement in <b>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</b></p>
            {live && <a className="market-link" href={live.marketUrl} target="_blank" rel="noreferrer">View active market on Polymarket ↗</a>}
          </div>
          <div className="controls">
            <button className="secondary" onClick={reset}>Reset</button>
            <button className={running ? "stop" : "primary"} onClick={() => setRunning((value) => !value)} disabled={!live}>
              {running ? "■ Pause engine" : "▶ Start engine"}
            </button>
          </div>
        </div>

        <section className="metrics">
          <article><span>Available balance</span><strong>{money(bankroll)}</strong><small>Started with $100.00</small></article>
          <article><span>Fixed bet size</span><strong>$5.00</strong><small>{Math.floor(bankroll / 5)} bets remaining</small></article>
          <article><span>Chainlink BTC/USD</span><strong>{btc ? `$${btc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"}</strong><small className={btc >= strike ? "positive" : "negative"}>{btc && strike ? `${btc >= strike ? "▲" : "▼"} ${Math.abs((btc / strike - 1) * 10000).toFixed(1)} bps vs $${strike.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "Waiting for Polymarket"}</small></article>
          <article><span>Engine state</span><strong className={running ? "positive" : ""}>{running ? "Watching" : "Paused"}</strong><small>{freshness} · {dataAge < Infinity ? `${Math.round(dataAge)}ms data age` : "No data yet"}</small></article>
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
            <button className="bet-button" disabled={!running || model.blocked || bankroll < 5} onClick={() => placeBet()}>Place $5 paper bet on {model.side}</button>
            <label className="toggle-row"><span><b>Auto-bet qualifying signals</b><small>Maximum one paper bet every 20 seconds</small></span><input type="checkbox" checked={autoBet} onChange={(event) => setAutoBet(event.target.checked)} /></label>
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
              <div className="formula"><code>z = ln(S/K) ÷ √(q × T)</code><p>z-score <b>{model.z.toFixed(3)}</b> · raw probability <b>{pct(model.raw)}</b></p><p>50% Chainlink fair model + 50% Polymarket midpoint</p></div>
            </details>
          </section>
        </div>

        <section className="card ledger">
          <div className="card-head"><div><p className="eyebrow">PAPER LEDGER</p><h2>Recent bets</h2></div><span className="subtle">{bets.length} simulated orders</span></div>
          {bets.length === 0 ? <div className="empty"><span>◎</span><b>No bets yet</b><p>Start the engine. It will wait until live Polymarket data produces a qualifying edge.</p></div> :
            <div className="table"><div className="tr header"><span>Time</span><span>Side</span><span>Stake</span><span>Entry</span><span>Edge</span><span>Status</span></div>{bets.map((bet) => <div className="tr" key={bet.id}><span>{new Date(bet.id).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><b className={bet.side === "UP" ? "positive" : "negative"}>{bet.side}</b><span>$5.00</span><span>{pct(bet.price)}</span><span>{(bet.edge * 100).toFixed(1)}¢</span><span className="open">OPEN</span></div>)}</div>}
        </section>
        <footer><span>Live Polymarket data · Paper execution only · No real funds at risk</span><span>Chainlink BTC/USD settlement source</span></footer>
      </section>
    </main>
  );
}
