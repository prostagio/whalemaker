type PriceLevel = { price: string; size: string };
type Book = {
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

const json = (url: string) =>
  fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
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
    const events = (await json(
      `https://gamma-api.polymarket.com/events?slug=${slug}`
    )) as GammaEvent[];
    const event = events[0];
    const market = event?.markets?.[0];

    if (!event || !market) {
      return Response.json(
        { error: "The current Polymarket BTC five-minute market is not available yet." },
        { status: 503, headers: { "Cache-Control": "no-store" } }
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

    const [upBook, downBook, crypto] = (await Promise.all([
      json(`https://clob.polymarket.com/book?token_id=${tokenIds[upIndex]}`),
      json(`https://clob.polymarket.com/book?token_id=${tokenIds[downIndex]}`),
      json(cryptoUrl.toString()),
    ])) as [Book, Book, { openPrice?: number; closePrice?: number; timestamp?: number }];

    const upAsk = bestAsk(upBook);
    const upBid = bestBid(upBook);
    const downAsk = bestAsk(downBook);
    const downBid = bestBid(downBook);
    const strike = number(crypto.openPrice);

    if (!strike) {
      throw new Error("Polymarket has not published the Chainlink opening price for this window.");
    }

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
    return Response.json(
      { error: error instanceof Error ? error.message : "Live market data failed." },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
