from pathlib import Path
from datetime import timedelta
from typing import Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sklearn.ensemble import GradientBoostingRegressor
import json 
from pydantic import BaseModel
from openai import OpenAI, APIError, RateLimitError



# ==============================
# Load CSV once at startup
# ==============================

CSV_PATH = Path(__file__).resolve().parents[1] / "data" / "sp500_prices.csv"

df = pd.read_csv(CSV_PATH, parse_dates=["date"])
df["ticker"] = df["ticker"].astype(str)

# Ensure sorted
df = df.sort_values(["ticker", "date"]).reset_index(drop=True)

# ==============================
# FastAPI app + CORS
# ==============================

app = FastAPI()
client = OpenAI()

origins = [
    "http://localhost:5173",
    "https://stock-market-reporting-dashboard.vercel.app",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StockReportRequest(BaseModel):
    ticker: str
    persona: str
    horizon_days: int = 300


class StockReportResponse(BaseModel):
    ticker: str
    persona: str
    report_markdown: str

PERSONA_STYLES = {
    "balanced": (
        "You are a balanced, neutral equity analyst. "
        "You weigh upside and downside in a calm, data-driven way."
    ),
    "skeptic": (
        "You are a skeptical analyst who focuses on risks, red flags, and reasons "
        "the investment might underperform."
    ),
    "optimist": (
        "You are an optimistic growth-oriented analyst who emphasizes long-term "
        "opportunity and positive narratives, while still acknowledging risks."
    ),
    "risk_taker": (
        "You are a high-risk, high-reward oriented trader focused on volatility, "
        "big moves, and speculative upside."
    ),
}

def build_stock_snapshot(ticker: str) -> dict:
    symbol = ticker.upper()
    sub = df[df["ticker"] == symbol].sort_values("date")

    if sub.empty:
        raise HTTPException(status_code=404, detail=f"Symbol {symbol} not found")

    closes = sub["close"].astype(float)
    dates = sub["date"]

    last_row = sub.iloc[-1]
    last_price = float(last_row["close"])
    last_date = last_row["date"].strftime("%Y-%m-%d")

    def safe_return(days: int) -> Optional[float]:
        if len(closes) > days:
            return float(closes.iloc[-1] / closes.iloc[-(days + 1)] - 1.0)
        return None

    ret_1m = safe_return(21)
    ret_3m = safe_return(63)

    # Approx 1-year window
    window_1y = closes.tail(252)
    high_52w = float(window_1y.max()) if len(window_1y) > 0 else None
    low_52w = float(window_1y.min()) if len(window_1y) > 0 else None

    # Simple 20D volatility
    if len(window_1y) > 20:
        log_returns = np.log(window_1y / window_1y.shift(1)).dropna()
        vol_20d = float(log_returns.tail(20).std() * np.sqrt(252))
    else:
        vol_20d = None

    return {
        "ticker": symbol,
        "last_date": last_date,
        "last_price": last_price,
        "ret_1m": ret_1m,
        "ret_3m": ret_3m,
        "high_52w": high_52w,
        "low_52w": low_52w,
        "vol_20d_annualized": vol_20d,
    }



# ==============================
# Core endpoints
# ==============================


@app.get("/tickers")
def get_tickers():
    """Return sorted list of unique tickers."""
    tickers = sorted(df["ticker"].unique().tolist())
    return {"tickers": tickers}


@app.get("/prices/{symbol}")
def get_prices(symbol: str):
    symbol = symbol.upper()
    sub = df[df["ticker"] == symbol].sort_values("date")

    if sub.empty:
        raise HTTPException(status_code=404, detail=f"Symbol {symbol} not found")

    return {
        "symbol": symbol,
        "points": [
            {
                "date": d.strftime("%Y-%m-%d"),
                "open": float(o),
                "high": float(h),
                "low": float(l),
                "close": float(c),
            }
            for d, o, h, l, c in zip(
                sub["date"],
                sub["open"],
                sub["high"],
                sub["low"],
                sub["close"],
            )
        ],
    }



@app.get("/forecast/{symbol}")
def get_forecast(
    symbol: str,
    start_date: Optional[str] = Query(default=None),
    horizon: int = 7,
):
    """
    ML-based 7-day forecast.

    - Uses last ~3 years of data (~756 trading days) for this symbol.
    - Features: last 20 log prices.
    - Target: next-day log price.
    - Model: GradientBoostingRegressor.
    - Samples inside selected date window get HIGH weight.
    - Older samples get LOWER weight.
    - Forecasts next 7 days iteratively.
    """

    symbol = symbol.upper()
    sub = df[df["ticker"] == symbol].sort_values("date")

    if sub.empty:
        raise HTTPException(status_code=404, detail=f"Symbol {symbol} not found")

    # Always clamp to 7 days max
    horizon = max(1, min(int(horizon), 7))

    # Use last ~3 years
    sub = sub.tail(252 * 3)

    if len(sub) < 80:
        raise HTTPException(
            status_code=400,
            detail="Not enough history for ML forecast",
        )

    close = sub["close"].to_numpy(dtype=float)
    dates = sub["date"].reset_index(drop=True)

    log_price = np.log(close)
    lag = 20

    X_list = []
    y_list = []
    sample_dates = []

    for i in range(lag, len(log_price) - 1):
        X_list.append(log_price[i - lag : i])
        y_list.append(log_price[i + 1])
        sample_dates.append(dates.iloc[i])

    X = np.vstack(X_list)
    y = np.asarray(y_list, dtype=float)
    sample_dates = pd.Series(sample_dates)

    # ==============================
    # Window-biased weights
    # ==============================

    weights = np.ones(len(y), dtype=float)

    if start_date:
        try:
            start_dt = pd.to_datetime(start_date)
            recent_mask = sample_dates >= start_dt
            if recent_mask.any():
                weights[~recent_mask.to_numpy()] = 0.3
        except Exception:
            # If parsing fails, just use uniform weights
            pass

    # ==============================
    # Train ML model
    # ==============================

    model = GradientBoostingRegressor(
        n_estimators=300,
        learning_rate=0.05,
        max_depth=3,
        random_state=42,
    )

    model.fit(X, y, sample_weight=weights)

    # ==============================
    # Iterative 7-day forecast
    # ==============================

    last_log_window = log_price[-lag:].copy()
    last_date = dates.iloc[-1]

    points = []

    for step in range(1, horizon + 1):
        pred_log = float(model.predict(last_log_window.reshape(1, -1))[0])
        pred_price = float(np.exp(pred_log))

        new_date = last_date + timedelta(days=step)

        points.append(
            {
                "date": new_date.strftime("%Y-%m-%d"),
                "close": pred_price,
            }
        )

        # Slide window: drop oldest, append new prediction
        last_log_window = np.roll(last_log_window, -1)
        last_log_window[-1] = pred_log

    return {
        "symbol": symbol,
        "points": points,
    }


# ==============================
# General Trends endpoints
# ==============================


@app.get("/trends/overview")
def trends_overview():
    """
    Market overview for the S&P 500 universe:
    - Equal-weight synthetic index 1M / 3M returns
    - % of stocks above 50D / 200D moving averages
    - Median 20D volatility + regime
    - Advance/decline stats (last day)
    - 52-week highs / lows
    - Cross-sectional 1M return dispersion
    """

    # Equal-weight synthetic index (mean close across tickers)
    daily_index = (
        df.groupby("date")["close"].mean().sort_index()
    )  # pd.Series date->avg close

    if len(daily_index) < 70:
        raise HTTPException(
            status_code=400,
            detail="Not enough history to compute overview metrics",
        )

    last_date = daily_index.index[-1]
    last_price = float(daily_index.iloc[-1])

    def compute_return(days: int) -> float:
        if len(daily_index) <= days:
            return 0.0
        ref_price = float(daily_index.iloc[-1 - days])
        if ref_price == 0:
            return 0.0
        return (last_price / ref_price) - 1.0

    index_1m_return = compute_return(21)   # ~1 month
    index_3m_return = compute_return(63)   # ~3 months

    # Breadth, volatility, advance/decline, highs/lows, dispersion
    above_50 = 0
    total_50 = 0
    above_200 = 0
    total_200 = 0
    vol_values: list[float] = []

    advancers = 0
    decliners = 0
    unchanged = 0
    universe_count = 0

    lookback_1m = 21
    cs_1m_returns: list[float] = []

    new_highs = 0
    new_lows = 0

    for ticker, g in df.groupby("ticker"):
        g = g.sort_values("date")
        closes = g["close"]

        if len(closes) < 2:
            continue

        universe_count += 1

        # Advance / decline (last day)
        last_close = float(closes.iloc[-1])
        prev_close = float(closes.iloc[-2])
        if last_close > prev_close:
            advancers += 1
        elif last_close < prev_close:
            decliners += 1
        else:
            unchanged += 1

        # Moving averages for breadth
        closes_tail = closes.tail(260)
        ma50 = closes_tail.rolling(window=50).mean()
        ma200 = closes_tail.rolling(window=200).mean()

        last_ma50 = float(ma50.iloc[-1]) if not np.isnan(ma50.iloc[-1]) else np.nan
        last_ma200 = float(ma200.iloc[-1]) if not np.isnan(ma200.iloc[-1]) else np.nan

        if not np.isnan(last_ma50):
            total_50 += 1
            if last_close > last_ma50:
                above_50 += 1

        if not np.isnan(last_ma200):
            total_200 += 1
            if last_close > last_ma200:
                above_200 += 1

        # Volatility: std of last 20 daily returns
        if len(closes_tail) >= 21:
            rets = closes_tail.pct_change().dropna()
            if len(rets) >= 20:
                last20 = rets.tail(20)
                vol = float(last20.std())
                if not np.isnan(vol):
                    vol_values.append(vol)

        # 1M return for dispersion
        if len(closes) > lookback_1m:
            past_close = float(closes.iloc[-1 - lookback_1m])
            if past_close > 0:
                r_1m = (last_close / past_close) - 1.0
                if np.isfinite(r_1m):
                    cs_1m_returns.append(r_1m)

        # 52-week highs / lows (approx. last 252 trading days)
        last252 = closes.tail(252)
        if len(last252) >= 30:
            max_52w = float(last252.max())
            min_52w = float(last252.min())
            if last_close >= max_52w:
                new_highs += 1
            if last_close <= min_52w:
                new_lows += 1

    pct_above_50d = (above_50 / total_50) if total_50 > 0 else 0.0
    pct_above_200d = (above_200 / total_200) if total_200 > 0 else 0.0
    median_20d_vol = float(np.median(vol_values)) if vol_values else 0.0

    pct_advancers = (advancers / universe_count) if universe_count > 0 else 0.0
    pct_decliners = (decliners / universe_count) if universe_count > 0 else 0.0

    pct_new_highs = (new_highs / universe_count) if universe_count > 0 else 0.0
    pct_new_lows = (new_lows / universe_count) if universe_count > 0 else 0.0

    dispersion_1m = float(np.std(cs_1m_returns)) if cs_1m_returns else 0.0

    # Simple volatility regime classification based on absolute daily vol
    if median_20d_vol < 0.01:
        vol_regime = "Low Volatility"
    elif median_20d_vol < 0.03:
        vol_regime = "Normal Volatility"
    else:
        vol_regime = "High Volatility"

    return {
        "last_date": last_date.strftime("%Y-%m-%d"),
        "index_1m_return": index_1m_return,
        "index_3m_return": index_3m_return,
        "pct_above_50d": pct_above_50d,
        "pct_above_200d": pct_above_200d,
        "median_20d_vol": median_20d_vol,
        "vol_regime": vol_regime,
        "pct_advancers": pct_advancers,
        "pct_decliners": pct_decliners,
        "pct_new_highs": pct_new_highs,
        "pct_new_lows": pct_new_lows,
        "num_new_highs": new_highs,
        "num_new_lows": new_lows,
        "dispersion_1m": dispersion_1m,
    }


@app.get("/trends/momentum")
def trends_momentum(lookback_days: int = 21, top_n: int = 10):
    """
    Cross-sectional momentum snapshot:
    - Compute lookback_days return per ticker.
    - Return top N and bottom N names by 1M return.
    """

    lookback_days = max(5, min(int(lookback_days), 126))
    top_n = max(1, min(int(top_n), 50))

    records: list[tuple[str, float]] = []

    for ticker, g in df.groupby("ticker"):
        g = g.sort_values("date")
        closes = g["close"]

        if len(closes) <= lookback_days:
            continue

        last_close = float(closes.iloc[-1])
        past_close = float(closes.iloc[-1 - lookback_days])

        if past_close <= 0:
            continue

        ret = (last_close / past_close) - 1.0
        records.append((ticker, ret))

    if not records:
        return {"lookback_days": lookback_days, "top": [], "bottom": []}

    # Sort by return
    records.sort(key=lambda x: x[1], reverse=True)

    top = [{"ticker": t, "ret_1m": r} for t, r in records[:top_n]]
    bottom = [{"ticker": t, "ret_1m": r} for t, r in records[-top_n:]]

    return {
        "lookback_days": lookback_days,
        "top": top,
        "bottom": bottom,
    }


@app.post("/reports/stock", response_model=StockReportResponse)
def generate_stock_report(req: StockReportRequest):
    snapshot = build_stock_snapshot(req.ticker)
    persona_key = req.persona.lower()
    persona_instructions = PERSONA_STYLES.get(persona_key, PERSONA_STYLES["balanced"])

    prompt = f"""
You are writing a thoughtful, long-form explainer about a single stock.
Your job is to help an intelligent layperson understand what this company is,
what its recent price behavior looks like, and what a careful investor might
want to think about next.

You are NOT allowed to give direct investment advice. 
Do NOT say "buy", "sell", "strong buy", "overweight", "underweight",
"you should", or give price targets or probability-weighted forecasts.

Persona / angle:
{persona_instructions}

Time horizon to keep in mind: roughly {req.horizon_days} days.

Below is a JSON snapshot of the stock and its relationship to the S&P 500
universe. You MUST treat this as the only numerical source of truth.
You may rephrase, aggregate, or compare these numbers, but you may not invent
new numeric values that are not implied by the JSON.

STOCK_SNAPSHOT_JSON:
{json.dumps(snapshot, indent=2, default=str)}

---

Write a single, cohesive markdown report in a style that is:

- Clear and precise
- Analytically sharp, but not hyped
- Slightly reflective / philosophical in tone (like a good essay), while
  still grounded in the data above
- Suitable for an educated retail investor who is curious but not a quant

Use the following structure and headings:

# {snapshot.get("ticker", "Selected stock")} — Plain-English Overview

Briefly explain what this company actually *is* and *does* in everyday language.
One or two paragraphs, no jargon when it can be avoided.

## Where the Stock Stands Right Now

Summarize key metrics using ONLY the JSON above. Focus on things like:
- Recent returns over different horizons
- Where the price sits relative to its recent range or 52-week range
- Volatility / stability compared to the broader S&P universe
- Any notable breadth or momentum context you can infer

Use bullet points for the metrics. When you reference numbers,
either quote them directly or describe them qualitatively
("roughly flat over three months", "well off recent highs", etc.).

## How to Read These Numbers

Interpret the metrics in plain language:
- What do these numbers *suggest* about momentum, sentiment, or regime?
- Does this look like a calm, trending story, a choppy sideways story,
  or something more dramatic?
- Tie your interpretation back to the metrics you just quoted.
Avoid speculation about news or fundamentals you were not given.

## Scenario Thinking: What Could Go Right

Give 2–4 bullet points describing upside scenarios.
Ground each in patterns visible in the JSON (momentum, volatility, breadth, etc.)
rather than in hypothetical product launches or headlines.
Write in terms of "if X continues / improves, then the bull case is that…".

## Scenario Thinking: What Could Go Wrong

Give 2–4 bullet points describing downside or risk scenarios.
Again, ground your reasoning in the data: draw on volatility,
drawdowns, relative performance, or concentration of recent gains.
Avoid dramatic language; be calm and precise.

## How a Thoughtful Investor Might Use This

One or two paragraphs. The goal here is not to tell the reader what to do,
but to frame *how* to think:
- What kinds of questions should someone be asking about this stock
  given the current profile?
- What time horizons (short-term trader vs patient holder) are suggested
  by the data?
- How might this stock fit into a broader S&P-like portfolio in terms of
  risk, cyclicality, or temperament?

End with a clear reminder that this is an educational, statistical snapshot
only and does not account for the reader's personal situation, and that it is
NOT financial advice.

Write everything in well-structured markdown. Do not include the raw JSON.
"""


    try:
        # ---- Call the Responses API (non-streaming) ----
        response = client.responses.create(
            model="gpt-4.1-mini",
            input=[
                {"role": "system", "content": "You are a concise, neutral markets explainer."},
                {"role": "user", "content": prompt},
            ],
            # Big enough to fit the whole multi-section report
            max_output_tokens=1200,
        )

        # Optional: debug logs
        try:
            print("LLM finish_reason:", response.output[0].finish_reason)
            print("LLM usage:", response.usage)
        except Exception:
            pass

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM error: {e}")

    # ---- Extract text safely from the Responses object ----
    if not response.output:
        raise HTTPException(status_code=502, detail="Empty report returned from LLM (no output blocks).")

    first_block = response.output[0]

    text_chunks: list[str] = []

    # Most common case: first block is a message with text parts
    if getattr(first_block, "type", None) == "message":
        for part in getattr(first_block, "content", []):
            # In the Python SDK, `part.text` is already the string
            if getattr(part, "type", None) == "output_text":
                text_chunks.append(part.text)
    # Fallback: sometimes the first block itself is an output_text
    elif getattr(first_block, "type", None) == "output_text":
        text_chunks.append(first_block.text)

    report_text = "".join(text_chunks).strip()

    if not report_text:
        # At this point we *know* the model returned tokens, so if this triggers
        # it’s almost certainly a parsing bug, not the LLM.
        raise HTTPException(status_code=502, detail="Empty report returned from LLM (no text found in output).")

    return StockReportResponse(
        ticker=snapshot["ticker"],
        persona=persona_key,
        report_markdown=report_text,
    )
