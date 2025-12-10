import os
from datetime import datetime, timedelta

import pandas as pd
import yfinance as yf
from dateutil.relativedelta import relativedelta

DATA_DIR = "data"
CONFIG_DIR = "config"
CSV_PATH = os.path.join(DATA_DIR, "sp500_prices.csv")
TICKERS_PATH = "tickers_sp500.txt"

DATE_COL = "date"  # we'll normalize to this name


def load_tickers(path: str) -> list:
    """Read tickers from text file (one per line)."""
    with open(path, "r") as f:
        tickers = [line.strip().upper() for line in f if line.strip()]
    if not tickers:
        raise ValueError("No tickers found in tickers_sp500.txt")
    return tickers


def load_existing_data(path: str) -> pd.DataFrame:
    """Load existing CSV if it exists; else return None."""
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, parse_dates=[DATE_COL])
    return df


def get_history(tickers: list, start: datetime, end: datetime) -> pd.DataFrame:
    """
    Download OHLCV history for tickers between start and end (inclusive of start, exclusive of end).
    Returns a DataFrame with columns: date, ticker, open, high, low, close, adj_close, volume.
    """
    # yfinance expects string dates
    start_str = start.strftime("%Y-%m-%d")
    end_str = end.strftime("%Y-%m-%d")

    print(f"Downloading data from {start_str} to {end_str} for {len(tickers)} tickers...")
    data = yf.download(
        tickers=tickers,
        start=start_str,
        end=end_str,
        auto_adjust=False,
        group_by="ticker",
        progress=False,
        threads=True,
    )

    if data.empty:
        return pd.DataFrame(columns=[DATE_COL, "ticker", "open", "high", "low", "close", "adj_close", "volume"])

    # yfinance returns multi-index if multiple tickers
    if isinstance(data.columns, pd.MultiIndex):
        # reshape to long format
        data = (
            data.stack(level=0)
            .rename_axis(index=["date", "ticker"])
            .reset_index()
        )
    else:
        # single-ticker case: add ticker column from first ticker
        ticker = tickers[0]
        data = data.reset_index()
        data["ticker"] = ticker

    # rename columns to standardized names
    rename_map = {
        "Date": "date",
        "Open": "open",
        "High": "high",
        "Low": "low",
        "Close": "close",
        "Adj Close": "adj_close",
        "Volume": "volume",
    }
    data = data.rename(columns=rename_map)

    # Ensure only the columns we care about
    data = data[[DATE_COL, "ticker", "open", "high", "low", "close", "adj_close", "volume"]]

    # Enforce dtypes
    data[DATE_COL] = pd.to_datetime(data[DATE_COL])
    data["ticker"] = data["ticker"].astype(str)

    return data


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(CONFIG_DIR, exist_ok=True)

    tickers = load_tickers(TICKERS_PATH)
    today = datetime.today().date()

    existing_df = load_existing_data(CSV_PATH)

    if existing_df is None:
        # First run: get last 10 years
        start_date = today - relativedelta(years=10)
        end_date = today + timedelta(days=1)  # yfinance end is exclusive
        print("No existing CSV found. Pulling full 10-year history...")
        new_df = get_history(tickers, start=start_date, end=end_date)
        if new_df.empty:
            print("WARNING: No data downloaded. Check tickers or network.")
            return
        # Sort and save
        new_df = new_df.sort_values([DATE_COL, "ticker"])
        new_df.to_csv(CSV_PATH, index=False)
        print(f"Saved initial dataset to {CSV_PATH} with {len(new_df)} rows.")
    else:
        # Incremental update
        last_date = existing_df[DATE_COL].max().date()
        start_date = last_date + timedelta(days=1)
        if start_date > today:
            print("CSV is already up to date. Nothing to do.")
            return

        end_date = today + timedelta(days=1)
        print(f"Existing data through {last_date}. Fetching from {start_date} to {today}...")
        new_df = get_history(tickers, start=start_date, end=end_date)

        if new_df.empty:
            print("No new rows returned from yfinance. CSV remains unchanged.")
            return

        # Combine, drop duplicates, sort, overwrite
        combined = pd.concat([existing_df, new_df], ignore_index=True)

        # Drop exact duplicate rows (just in case)
        combined = combined.drop_duplicates(subset=[DATE_COL, "ticker"])

        combined = combined.sort_values([DATE_COL, "ticker"])
        combined.to_csv(CSV_PATH, index=False)

        print(
            f"Updated {CSV_PATH}: "
            f"{len(existing_df)} -> {len(combined)} rows "
            f"(added {len(combined) - len(existing_df)} new rows)."
        )


if __name__ == "__main__":
    main()
