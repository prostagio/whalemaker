type PriceLevel = { price: string; size: string };
type Book = {
  asset_id?: string;
  bids?: PriceLevel[];
  asks?: PriceLevel[];
  timestamp?: string;
};

type GammaMarket = {
  conditionId: string;
  question: string;
  slug: string;
  outcomes: string;
  outcomePrices: string;
  clobTokenIds: string;
  acceptingOrders: boolean;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
  endDate: string;
  eventStartTime?: string;
};

type GammaEvent = {
  slug: string;
  title: string;
  markets: GammaMarket[];
};

type CachedMarket = {
  slug: string;
  event: GammaEvent;
  market: GammaMarket;
  tokenIds: string[];
  upIndex: number;
  downIndex: number;
  strike: number;
  expiresAt: number;
};

let cachedMarket: CachedMarket | null = null;

const json = (url: string, init?: RequestInit) =>
  fetch(url, {
    ...init,
    cache: "no-store",
    headers: { Accept: "application/json", ...init?.headers },
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Polymarket returned HTTP ${response.status}`);
    }
    return response.json();
  });

const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const bestAsk = (book: Book) =>
  Math.min(...(book.asks ?? []).map((level) => number(level.price)).filter(Boolean));

const bestBid = (book: Book) =>
  Math.max(...(book.bids ?? []).map((level) => number(level.price)).filter(Boolean));

const sizeAt = (levels: PriceLevel[] | undefined, price: number) =>
  number(levels?.find((level) => number(level.price) === price)?.size);

export async function GET() {
  try {
    const now = Date.now();
    const derivedWindowStart = Math.floor(now / 300_000) * 300;
    const slug = `btc-updown-5m-${derivedWindowStart}`;
    if (!cachedMarket || cachedMarket.slug !== slug || cachedMarket.expiresAt <= now) {
      const events = (await json(
        `https://gamma-api.polymarket.com/events?slug=${slug}`
      )) as GammaEvent[];
      const event = events[0];
      const market = event?.markets?.[0];

      if (!event || !market) {
        return Response.json(
          { error: "The current Polymarket BTC five-minute market is not available yet." },
          { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "3" } }
        );
      }

      const tokenIds = JSON.parse(market.clobTokenIds) as string[];
      const outcomes = JSON.parse(market.outcomes) as string[];
      const upIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "up");
      const downIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "down");

      if (upIndex < 0 || downIndex < 0 || !tokenIds[upIndex] || !tokenIds[downIndex]) {
        throw new Error("Polymarket returned an unexpected outcome mapping.");
      }

      const cryptoUrl = new URL("https://polymarket.com/api/crypto/crypto-price");
      cryptoUrl.searchParams.set("symbol", "BTC");
      cryptoUrl.searchParams.set(
        "eventStartTime",
        market.eventStartTime || new Date(derivedWindowStart * 1_000).toISOString()
      );
      cryptoUrl.searchParams.set("variant", "fiveminute");
      const crypto = (await json(cryptoUrl.toString())) as {
        openPrice?: number;
        closePrice?: number;
        timestamp?: number;
      };
      const strike = number(crypto.openPrice);
      if (!strike) {
        throw new Error("Polymarket has not published the Chainlink opening price for this window.");
      }
      cachedMarket = {
        slug,
        event,
        market,
        tokenIds,
        upIndex,
        downIndex,
        strike,
        expiresAt: (derivedWindowStart + 300) * 1_000,
      };
    }

    const { event, market, tokenIds, upIndex, downIndex, strike } = cachedMarket;
    const books = (await json("https://clob.polymarket.com/books", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { token_id: tokenIds[upIndex] },
        { token_id: tokenIds[downIndex] },
      ]),
    })) as Book[];
    const upBook = books.find((book) => book.asset_id === tokenIds[upIndex]) ?? books[0] ?? {};
    const downBook = books.find((book) => book.asset_id === tokenIds[downIndex]) ?? books[1] ?? {};

    const upAsk = bestAsk(upBook);
    const upBid = bestBid(upBook);
    const downAsk = bestAsk(downBook);
    const downBid = bestBid(downBook);

    return Response.json(
      {
        eventTitle: event.title,
        slug,
        marketUrl: `https://polymarket.com/event/${slug}`,
        conditionId: market.conditionId,
        acceptingOrders: Boolean(market.acceptingOrders),
        windowStart:
          Date.parse(market.eventStartTime || "") || derivedWindowStart * 1_000,
        windowEnd:
          Date.parse(market.endDate || "") || (derivedWindowStart + 300) * 1_000,
        secondsLeft: Math.max(
          0,
          Math.ceil(
            ((Date.parse(market.endDate || "") || (derivedWindowStart + 300) * 1_000) - now) /
              1_000
          )
        ),
        strike,
        upAsk: Number.isFinite(upAsk) ? upAsk : 1,
        upBid: Number.isFinite(upBid) ? upBid : 0,
        downAsk: Number.isFinite(downAsk) ? downAsk : 1,
        downBid: Number.isFinite(downBid) ? downBid : 0,
        upAskSize: sizeAt(upBook.asks, upAsk),
        upBidSize: sizeAt(upBook.bids, upBid),
        downAskSize: sizeAt(downBook.asks, downAsk),
        downBidSize: sizeAt(downBook.bids, downBid),
        fetchedAt: now,
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live market data failed.";
    const rateLimited = message.includes("HTTP 429");
    return Response.json(
      { error: message },
      {
        status: rateLimited ? 429 : 502,
        headers: {
          "Cache-Control": "no-store",
          ...(rateLimited ? { "Retry-After": "5" } : {}),
        },
      }
    );
  }
}
