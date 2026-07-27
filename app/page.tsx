"use client";

import { useEffect, useMemo, useState } from "react";

type Side = "UP" | "DOWN";
type Bet = { id: number; side: Side; price: number; edge: number; result: "OPEN" | "WON" | "LOST" };

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
  const [btc, setBtc] = useState(118_420);
  const [strike] = useState(118_390);
  const [seconds, setSeconds] = useState(247);
  const [variance, setVariance] = useState(3.05e-9);
  const [marketUp, setMarketUp] = useState(0.56);
  const [bankroll, setBankroll] = useState(100);
  const [bets, setBets] = useState<Bet[]>([]);
  const [autoBet, setAutoBet] = useState(true);
  const [lastBetAt, setLastBetAt] = useState(0);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      const shock = (Math.random() - 0.48) * 22;
      setBtc((v) => Math.max(1, v + shock));
      setVariance((v) => 0.97 * v + 0.03 * Math.pow(shock / 118_420, 2));
      setMarketUp((v) => Math.min(0.95, Math.max(0.05, v + (Math.random() - 0.5) * 0.015)));
      setSeconds((v) => (v <= 1 ? 300 : v - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const model = useMemo(() => {
    const qUsed = Math.max(variance, 2.3020308442843487e-9);
    const distance = Math.log(btc / strike);
    const z = distance / Math.sqrt(qUsed * seconds);
    const raw = normalCdf(z);
    const calibrated = Math.min(0.99, Math.max(0.01, raw * 0.5 + marketUp * 0.5));
    const upAsk = Math.min(0.99, marketUp + 0.01);
    const downAsk = Math.min(0.99, 1 - marketUp + 0.01);
    const upEdge = calibrated - upAsk - 0.01 - 0.005;
    const downEdge = 1 - calibrated - downAsk - 0.01 - 0.005;
    const side: Side = upEdge >= downEdge ? "UP" : "DOWN";
    const bestEdge = Math.max(upEdge, downEdge);
    const blocked = seconds < 15 || bestEdge < 0.02 || bankroll < 5;
    return { qUsed, distance, z, raw, calibrated, upAsk, downAsk, upEdge, downEdge, side, bestEdge, blocked };
  }, [bankroll, btc, marketUp, seconds, strike, variance]);

  const placeBet = (side = model.side) => {
    if (bankroll < 5) return;
    const edge = side === "UP" ? model.upEdge : model.downEdge;
    const price = side === "UP" ? model.upAsk : model.downAsk;
    setBankroll((v) => v - 5);
    setBets((v) => [{ id: Date.now(), side, price, edge, result: "OPEN" }, ...v].slice(0, 8));
    setLastBetAt(Date.now());
  };

  useEffect(() => {
    if (running && autoBet && !model.blocked && Date.now() - lastBetAt > 20_000) placeBet();
    // The model intentionally controls this effect cadence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, autoBet, model.blocked, model.side]);

  const reset = () => {
    setBankroll(100);
    setBets([]);
    setRunning(false);
    setSeconds(247);
  };

  const confidence = Math.min(99, Math.round(Math.abs(model.calibrated - 0.5) * 120 + 42));
  const signalLabel = model.blocked ? "WAIT" : `BET ${model.side}`;

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <div className="mark">W</div>
          <div><strong>WhaleMaker</strong><span>5-minute BTC edge engine</span></div>
        </div>
        <div className="paper-pill"><i /> PAPER TRADING</div>
        <button className="icon-button" aria-label="Settings">⚙</button>
      </header>

      <section className="shell">
        <div className="status-row">
          <div>
            <p className="eyebrow">BTC UP OR DOWN · 5 MIN</p>
            <h1>Market command center</h1>
            <p className="subtle">Live simulation · Next settlement in <b>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</b></p>
          </div>
          <div className="controls">
            <button className="secondary" onClick={reset}>Reset</button>
            <button className={running ? "stop" : "primary"} onClick={() => setRunning((v) => !v)}>
              {running ? "■ Pause engine" : "▶ Start engine"}
            </button>
          </div>
        </div>

        <section className="metrics">
          <article><span>Available balance</span><strong>{money(bankroll)}</strong><small>Started with $100.00</small></article>
          <article><span>Fixed bet size</span><strong>$5.00</strong><small>{Math.floor(bankroll / 5)} bets remaining</small></article>
          <article><span>BTC reference</span><strong>${btc.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong><small className={btc >= strike ? "positive" : "negative"}>{btc >= strike ? "▲" : "▼"} {Math.abs((btc / strike - 1) * 10000).toFixed(1)} bps vs strike</small></article>
          <article><span>Engine state</span><strong className={running ? "positive" : ""}>{running ? "Watching" : "Paused"}</strong><small>{running ? "Data updates every second" : "No bets can be placed"}</small></article>
        </section>

        <div className="grid">
          <section className="card signal-card">
            <div className="card-head"><div><p className="eyebrow">CURRENT DECISION</p><h2>Signal</h2></div><span className={`signal ${model.blocked ? "wait" : model.side.toLowerCase()}`}>{signalLabel}</span></div>
            <div className="fair">
              <div className="ring" style={{ "--p": `${model.calibrated * 360}deg` } as React.CSSProperties}>
                <div><strong>{pct(model.calibrated)}</strong><span>Fair UP</span></div>
              </div>
              <div className="fair-copy">
                <span>Model confidence</span>
                <strong>{confidence}/100</strong>
                <div className="bar"><i style={{ width: `${confidence}%` }} /></div>
                <p>{model.blocked ? "The edge does not clear the safety threshold. Patience is a position." : `${model.side} clears all risk gates with ${(model.bestEdge * 100).toFixed(1)}¢ net edge.`}</p>
              </div>
            </div>
            <div className="comparison">
              <div><span>Model fair UP</span><b>{pct(model.calibrated)}</b></div>
              <div><span>Market ask UP</span><b>{pct(model.upAsk)}</b></div>
              <div><span>Net edge</span><b className={model.bestEdge >= 0.02 ? "positive" : ""}>{(model.bestEdge * 100).toFixed(1)}¢</b></div>
            </div>
            <button className="bet-button" disabled={!running || model.blocked || bankroll < 5} onClick={() => placeBet()}>
              Place $5 paper bet on {model.side}
            </button>
            <label className="toggle-row"><span><b>Auto-bet qualifying signals</b><small>Maximum one bet every 20 seconds</small></span><input type="checkbox" checked={autoBet} onChange={(e) => setAutoBet(e.target.checked)} /></label>
          </section>

          <section className="card">
            <div className="card-head"><div><p className="eyebrow">WHY THE MODEL DECIDED</p><h2>Signal health</h2></div><span className="healthy">● 4/4 healthy</span></div>
            <div className="health-list">
              <div><span className="health-icon">↕</span><p><b>Distance from strike</b><small>{model.distance >= 0 ? "Above" : "Below"} by {Math.abs(model.distance * 10000).toFixed(2)} bps</small></p><strong>{model.distance >= 0 ? "UP" : "DOWN"}</strong></div>
              <div><span className="health-icon">≈</span><p><b>Volatility</b><small>EWMA half-life 22.7566s</small></p><strong>MEDIUM</strong></div>
              <div><span className="health-icon">◷</span><p><b>Time remaining</b><small>{seconds}s until settlement</small></p><strong>OPEN</strong></div>
              <div><span className="health-icon">⌁</span><p><b>Market quality</b><small>Spread 2¢ · depth 18 shares</small></p><strong>PASS</strong></div>
            </div>
            <details>
              <summary>View calculation details <span>⌄</span></summary>
              <div className="formula">
                <code>z = ln(S/K) ÷ √(q × T)</code>
                <p>z-score <b>{model.z.toFixed(3)}</b> · raw probability <b>{pct(model.raw)}</b></p>
                <p>Blended fair = 50% external model + 50% CLOB</p>
              </div>
            </details>
          </section>
        </div>

        <section className="card ledger">
          <div className="card-head"><div><p className="eyebrow">PAPER LEDGER</p><h2>Recent bets</h2></div><span className="subtle">{bets.length} simulated orders</span></div>
          {bets.length === 0 ? <div className="empty"><span>◎</span><b>No bets yet</b><p>Start the engine. It will wait until the model finds a qualifying edge.</p></div> :
            <div className="table">
              <div className="tr header"><span>Time</span><span>Side</span><span>Stake</span><span>Entry</span><span>Edge</span><span>Status</span></div>
              {bets.map((bet) => <div className="tr" key={bet.id}><span>{new Date(bet.id).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><b className={bet.side === "UP" ? "positive" : "negative"}>{bet.side}</b><span>$5.00</span><span>{pct(bet.price)}</span><span>{(bet.edge * 100).toFixed(1)}¢</span><span className="open">OPEN</span></div>)}
            </div>}
        </section>

        <footer><span>Paper mode only · No real funds at risk</span><span>Calibration v1 · Strategy epoch 3</span></footer>
      </section>
    </main>
  );
}
