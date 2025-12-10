import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { ComposedChart, Bar } from "recharts";
import CandleChart from "./CandleChart";
import ReactMarkdown from "react-markdown";



interface PricePoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}


interface ForecastPoint {
  date: string;
  predicted: number;
}

interface ChartPoint {
  date: string;
  close?: number;
  predicted?: number;
  open?: number;
  high?: number;
  low?: number;
}


interface OverviewData {
  last_date: string;
  index_1m_return: number;
  index_3m_return: number;
  pct_above_50d: number;
  pct_above_200d: number;
  median_20d_vol: number;
  vol_regime: string;
  pct_advancers: number;
  pct_decliners: number;
  pct_new_highs: number;
  pct_new_lows: number;
  num_new_highs: number;
  num_new_lows: number;
  dispersion_1m: number;
}

interface MomentumItem {
  ticker: string;
  ret_1m: number;
}

interface MomentumData {
  lookback_days: number;
  top: MomentumItem[];
  bottom: MomentumItem[];
}

type ActiveTab = "symbol" | "trends" | "aiReport";


type CandlePoint = {
  time: string;   // "YYYY-MM-DD"
  open: number;
  high: number;
  low: number;
  close: number;
};



const API_BASE = "http://localhost:8000";

function formatPct(x: number, digits = 1): string {
  const v = x * 100;
  if (!Number.isFinite(v)) return "—";
  const s = v.toFixed(digits);
  const sign = v > 0 ? "+" : v < 0 ? "" : "";
  return `${sign}${s}%`;
}

function formatNumber(x: number, digits = 4): string {
  if (!Number.isFinite(x)) return "—";
  return x.toFixed(digits);
}


function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("symbol");

  const [tickers, setTickers] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<string>("AAPL");

  // Historical data
  const [fullData, setFullData] = useState<PricePoint[]>([]);
  const [startDate, setStartDate] = useState<string>("");

  // Forecast data
  const [forecastData, setForecastData] = useState<ForecastPoint[]>([]);
  const [showForecast, setShowForecast] = useState<boolean>(true);
  const [forecastLoading, setForecastLoading] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);

  // General Trends state
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [momentum, setMomentum] = useState<MomentumData | null>(null);
  const [trendsLoading, setTrendsLoading] = useState<boolean>(false);
  const [trendsError, setTrendsError] = useState<string | null>(null);

  // AI Report state
  const [persona, setPersona] = useState<"balanced" | "skeptic" | "optimist" | "risk_taker">(
    "balanced"
  );
  const [aiReport, setAiReport] = useState<string>("");
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string | null>(null);


  // ============================
  // Load tickers
  // ============================

  useEffect(() => {
    const fetchTickers = async () => {
      try {
        const res = await fetch(`${API_BASE}/tickers`);
        const json = await res.json();
        setTickers(json.tickers || []);
      } catch (err) {
        console.error(err);
        setError("Failed to load tickers");
      }
    };
    fetchTickers();
  }, []);

  // ============================
  // Load prices on symbol change
  // ============================

  useEffect(() => {
    const fetchPrices = async () => {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`${API_BASE}/prices/${selectedSymbol}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const points: PricePoint[] = json.points || [];

        setFullData(points);

        // DEFAULT WINDOW = LAST 3 MONTHS
        if (points.length > 0) {
          const latestDateStr = points[points.length - 1].date;
          const latestDate = new Date(latestDateStr);

          const threeMonthsAgo = new Date(latestDate);
          threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

          const iso = threeMonthsAgo.toISOString().slice(0, 10);

          const defaultStart =
            iso < points[0].date ? points[0].date : iso;

          setStartDate(defaultStart);
        } else {
          setStartDate("");
        }
      } catch (err) {
        console.error(err);
        setError("Failed to load prices");
        setFullData([]);
        setStartDate("");
      } finally {
        setLoading(false);
      }
    };

    if (selectedSymbol) fetchPrices();
  }, [selectedSymbol]);

  // ============================
  // Load ML forecast (window-biased)
  // ============================

  useEffect(() => {
    const fetchForecast = async () => {
      setForecastLoading(true);
      setForecastError(null);

      try {
        const params = new URLSearchParams();
        if (startDate) params.append("start_date", startDate);

        const url =
          params.toString().length > 0
            ? `${API_BASE}/forecast/${selectedSymbol}?${params.toString()}`
            : `${API_BASE}/forecast/${selectedSymbol}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = await res.json();
        const pts = (json.points || []) as { date: string; close: number }[];

        const mapped: ForecastPoint[] = pts.map((p) => ({
          date: p.date,
          predicted: p.close,
        }));

        setForecastData(mapped);
      } catch (err) {
        console.error(err);
        setForecastError("Failed to load forecast");
        setForecastData([]);
      } finally {
        setForecastLoading(false);
      }
    };

    if (selectedSymbol) fetchForecast();
  }, [selectedSymbol, startDate]);

  // ============================
  // Filter historical data
  // ============================

  const filteredHistorical: PricePoint[] = startDate
    ? fullData.filter((p) => p.date >= startDate)
    : fullData;

  // ============================
  // Combine historical + forecast
  // ============================

  const chartData: ChartPoint[] = [
    ...filteredHistorical.map((p) => ({
      date: p.date,
      open: p.open,
      high: p.high,
      low: p.low,
      close: p.close,
    })),
    ...(showForecast
      ? forecastData.map((p) => ({
          date: p.date,
          predicted: p.predicted,
        }))
      : []),
  ];

  const candleData = fullData.map((p) => ({
    time: p.date,
    open: p.open,
    high: p.high,
    low: p.low,
    close: p.close,
  }));
  console.log("Sample candle:", candleData.slice(0, 3));
  

  const minDate = fullData.length ? fullData[0].date : "";
  const maxDate = fullData.length
    ? fullData[fullData.length - 1].date
    : "";

  // ============================
  // General Trends data fetch
  // ============================

  useEffect(() => {
    if (activeTab !== "trends") return;

    const fetchTrends = async () => {
      setTrendsLoading(true);
      setTrendsError(null);

      try {
        const [ovRes, momRes] = await Promise.all([
          fetch(`${API_BASE}/trends/overview`),
          fetch(
            `${API_BASE}/trends/momentum?lookback_days=21&top_n=10`,
          ),
        ]);

        if (!ovRes.ok) throw new Error(`Overview HTTP ${ovRes.status}`);
        if (!momRes.ok) throw new Error(`Momentum HTTP ${momRes.status}`);

        const ovJson = (await ovRes.json()) as OverviewData;
        const momJson = (await momRes.json()) as MomentumData;

        setOverview(ovJson);
        setMomentum(momJson);
      } catch (err) {
        console.error(err);
        setTrendsError("Failed to load general trends");
        setOverview(null);
        setMomentum(null);
      } finally {
        setTrendsLoading(false);
      }
    };

    fetchTrends();
  }, [activeTab]);

  // ============================
  // Handlers
  // ============================

  const handleChangeSymbol = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedSymbol(e.target.value);
  };

  const handleStartDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setStartDate(e.target.value);
  };

  const handleGenerateReport = async () => {
    if (!selectedSymbol) {
      setAiError("Please select a symbol first.");
      return;
    }

    setAiLoading(true);
    setAiError(null);
    setAiReport("");

    try {
      const res = await fetch(`${API_BASE}/reports/stock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: selectedSymbol,
          persona,
          horizon_days: 90,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Request failed with status ${res.status}`);
      }

      const data = await res.json();
      setAiReport(data.report_markdown || "");
    } catch (err) {
      console.error(err);
      setAiError("Failed to generate AI report. Check the backend and try again.");
    } finally {
      setAiLoading(false);
    }
  };



  // ============================
  // Symbol tab view
  // ============================

  const renderSymbolView = () => (
    <>
      {/* Controls row */}
      <section
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1.5rem",
          alignItems: "center",
          marginBottom: "1.25rem",
        }}
      >
        {/* Symbol selector */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <label style={{ fontWeight: 500 }}>Symbol:</label>
          <select
            value={selectedSymbol}
            onChange={handleChangeSymbol}
            style={{
              padding: "0.4rem 0.6rem",
              borderRadius: "0.5rem",
              border: "1px solid #374151",
              background: "#111827",
              color: "#e5e5e5",
            }}
          >
            {(tickers.length ? tickers : ["AAPL"]).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {/* Start date */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <label style={{ fontWeight: 500 }}>Start date:</label>
          <input
            type="date"
            value={startDate}
            min={minDate}
            max={maxDate}
            onChange={handleStartDateChange}
            style={{
              padding: "0.35rem 0.5rem",
              borderRadius: "0.5rem",
              border: "1px solid #374151",
              background: "#111827",
              color: "#e5e5e5",
            }}
          />
          {minDate && (
            <span style={{ fontSize: "0.75rem", opacity: 0.7 }}>
              ({minDate} → {maxDate})
            </span>
          )}
        </div>

        {/* Forecast toggle */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={showForecast}
              onChange={(e) => setShowForecast(e.target.checked)}
            />
            <span style={{ fontWeight: 500 }}>
              Show 7-day ML prediction
            </span>
          </label>

          {forecastLoading && (
            <span style={{ fontSize: "0.75rem", opacity: 0.7 }}>
              updating…
            </span>
          )}
        </div>
      </section>

      {/* Errors */}
      {error && (
        <div
          style={{
            marginBottom: "0.75rem",
            padding: "0.75rem 1rem",
            borderRadius: "0.5rem",
            background: "#7f1d1d",
          }}
        >
          {error}
        </div>
      )}

      {forecastError && showForecast && (
        <div
          style={{
            marginBottom: "0.75rem",
            padding: "0.75rem 1rem",
            borderRadius: "0.5rem",
            background: "#78350f",
          }}
        >
          {forecastError}
        </div>
      )}

      {/* Chart */}
      {loading ? (
        <div>Loading chart…</div>
      ) : chartData.length === 0 ? (
        <div>No data for {selectedSymbol}</div>
      ) : (
        <>
          <div
            style={{
              width: "100%",
              height: "480px",
              padding: "0.4rem",
              borderRadius: "0.75rem",
              background: "#020617",
              boxShadow: "0 20px 40px rgba(0, 0, 0, 0.5)",
            }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 20, right: 40, left: 60, bottom: 40 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  minTickGap={20}
                  label={{
                    value: "Date",
                    position: "insideBottomRight",
                    offset: -5,
                    fill: "#9ca3af",
                    fontSize: 12,
                  }}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "#9ca3af" }}
                  domain={["auto", "auto"]}
                  label={{
                    value: "Price (USD)",
                    angle: -90,
                    position: "insideLeft",
                    offset: 10,
                    fill: "#9ca3af",
                    fontSize: 12,
                  }}
                />
                <Tooltip
                  contentStyle={{
                    background: "#020617",
                    border: "1px solid #374151",
                    borderRadius: "0.5rem",
                    fontSize: "0.8rem",
                  }}
                  labelStyle={{ color: "#e5e5e5" }}
                />

                {/* Historical */}
                <Line
                  type="monotone"
                  dataKey="close"
                  stroke="#60a5fa"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />

                {/* Forecast */}
                {showForecast && (
                  <Line
                    type="monotone"
                    dataKey="predicted"
                    stroke="#f97316"
                    strokeDasharray="5 5"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>


          {/* Forecast explanation */}
          <div
            style={{
              width: "100%",
              padding: "1rem 1.25rem",
              borderRadius: "0.75rem",
              background: "#020617",
              boxShadow: "0 12px 30px rgba(0, 0, 0, 0.4)",
              color: "#e5e7eb",
              fontSize: "0.875rem",
              lineHeight: 1.6,
              opacity: 0.9,
            }}
          >
            <div
              style={{
                textAlign: "left",
                fontWeight: 600,
                fontSize: "0.95rem",
                marginBottom: "0.5rem",
                letterSpacing: "0.02em",
                color: "#f3f4f6",
              }}
            >
              How the 7-Day Prediction Works:
            </div>

            <p style={{ marginBottom: "0.5rem" }}>
              The 7-day forecast is generated using a{" "}
              <strong>Gradient Boosting regression model</strong> trained on recent
              log-price movements for <strong>{selectedSymbol}</strong>. The model
              looks at the previous <strong>20 trading days</strong> as input features
              to capture short-term structure such as momentum, curvature, and small
              nonlinear shifts in trend.
            </p>

            <p style={{ marginBottom: "0.5rem" }}>
              The <strong>selected date range</strong> on the chart directly biases the
              training through sample-weighting. Data points inside the visible window
              are given higher influence, while older history is{" "}
              <strong>down-weighted</strong> but still used for stability. This lets the
              forecast adapt to the current regime without completely discarding
              broader context.
            </p>

            <p>
              The <strong>dashed forecast line</strong> represents an iterative
              7-step forward projection in log-price space, converted back to price. It
              reflects continuation of the recent statistical pattern only and{" "}
              <strong>does not incorporate</strong> fundamentals, earnings events, or
              macroeconomic information.
            </p>
          </div>

          <div
            style={{
              marginTop: "0.9rem",
              width: "100%",
              height: "480px",
              padding: "1rem",
              textAlign: "center",
              borderRadius: "0.75rem",
              background: "#020617",
              boxShadow: "0 20px 40px rgba(0, 0, 0, 0.5)",
              marginBottom: "1.25rem", 
            }}
          >
            <h3 style={{ marginBottom: "0.75rem", opacity: 0.85 }}>
            {selectedSymbol} Candlestick View
            </h3>

            <div style={{ width: "100%", height: "100%" }}>
              <CandleChart data={candleData} />
            </div>
          </div>


          <div
            style={{
              marginTop: "5rem",
              width: "100%",
              padding: "1rem 1.25rem",
              borderRadius: "0.75rem",
              background: "#020617",
              boxShadow: "0 12px 30px rgba(0, 0, 0, 0.4)",
              color: "#e5e7eb",
              fontSize: "0.875rem",
              lineHeight: 1.6,
              opacity: 0.9,
              position: "relative",
              zIndex: 5,
            }}
          >
            <div
              style={{
                marginTop: "0.8rem",
                textAlign: "left",
                fontWeight: 600,
                fontSize: "0.95rem",
                marginBottom: "0.5rem",
                letterSpacing: "0.02em",
                color: "#f3f4f6",
              }}
            >
              How to Read This Candlestick Chart:
            </div>

            <p style={{ marginBottom: "0.5rem" }}>
              Each candle represents one trading day for <strong>{selectedSymbol}</strong>.
              The <strong>body</strong> shows the open and close price, while the
              <strong> wicks</strong> show the full intraday range (high and low).
            </p>

            <p style={{ marginBottom: "0.5rem" }}>
              <span style={{ color: "#22c55e", fontWeight: 500 }}>Green candles</span>{" "}
              indicate the price closed higher than it opened (bullish session).
              <span style={{ color: "#f97373", fontWeight: 500 }}> Red candles</span>{" "}
              indicate the price closed lower than it opened (bearish session).
            </p>

            <p>
              Use the chart to visually analyze <strong>trend direction</strong>,
              <strong> momentum shifts</strong>, and <strong>volatility</strong>.
              Large bodies suggest strong directional conviction, while long wicks
              indicate intraday rejection or uncertainty.
            </p>
          </div>



        </>
      )}
    </>
  );

  // ============================
  // Trends tab view
  // ============================

  const renderTrendsView = () => {
    if (trendsLoading) {
      return <div>Loading general trends…</div>;
    }

    if (trendsError) {
      return (
        <div
          style={{
            marginTop: "0.75rem",
            padding: "0.75rem 1rem",
            borderRadius: "0.5rem",
            background: "#7f1d1d",
          }}
        >
          {trendsError}
        </div>
      );
    }

    if (!overview || !momentum) {
      return <div>No trends data available.</div>;
    }

    const pctAdv = overview.pct_advancers;
    const pctDec = overview.pct_decliners;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
        {/* Market overview */}
        <section
          style={{
            padding: "1rem 1.25rem",
            borderRadius: "0.75rem",
            background: "#020617",
            border: "1px solid #1f2937",
          }}
        >
          <div
            style={{
              marginBottom: "0.5rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <h2 style={{ fontSize: "1.1rem" }}>Market Overview</h2>
            <span style={{ fontSize: "0.75rem", opacity: 0.7 }}>
              as of {overview.last_date}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
              gap: "0.75rem",
            }}
          >
            {/* Index returns */}
            <div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                Synthetic Index 1M Return
              </div>
              <div
                style={{
                  fontSize: "1rem",
                  marginTop: "0.15rem",
                  color:
                    overview.index_1m_return > 0
                      ? "#22c55e"
                      : overview.index_1m_return < 0
                      ? "#f97373"
                      : "#e5e5e5",
                }}
              >
                {formatPct(overview.index_1m_return)}
              </div>
            </div>

            <div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                Synthetic Index 3M Return
              </div>
              <div
                style={{
                  fontSize: "1rem",
                  marginTop: "0.15rem",
                  color:
                    overview.index_3m_return > 0
                      ? "#22c55e"
                      : overview.index_3m_return < 0
                      ? "#f97373"
                      : "#e5e5e5",
                }}
              >
                {formatPct(overview.index_3m_return)}
              </div>
            </div>

            {/* Breadth */}
            <div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                % Above 50D MA
              </div>
              <div
                style={{
                  fontSize: "1rem",
                  marginTop: "0.15rem",
                  color:
                    overview.pct_above_50d > 0.6
                      ? "#22c55e"
                      : overview.pct_above_50d < 0.4
                      ? "#f97373"
                      : "#e5e5e5",
                }}
              >
                {formatPct(overview.pct_above_50d)}
              </div>
            </div>

            <div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                % Above 200D MA
              </div>
              <div
                style={{
                  fontSize: "1rem",
                  marginTop: "0.15rem",
                  color:
                    overview.pct_above_200d > 0.6
                      ? "#22c55e"
                      : overview.pct_above_200d < 0.4
                      ? "#f97373"
                      : "#e5e5e5",
                }}
              >
                {formatPct(overview.pct_above_200d)}
              </div>
            </div>

            {/* Volatility */}
            <div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                Median 20D Volatility (daily)
              </div>
              <div
                style={{
                  fontSize: "1rem",
                  marginTop: "0.15rem",
                  color:
                    overview.vol_regime === "Low Volatility"
                      ? "#22c55e"
                      : overview.vol_regime === "High Volatility"
                      ? "#f97373"
                      : "#e5e5e5",
                }}
              >
                {formatNumber(overview.median_20d_vol, 4)}
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  opacity: 0.8,
                  color:
                    overview.vol_regime === "Low Volatility"
                      ? "#22c55e"
                      : overview.vol_regime === "High Volatility"
                      ? "#f97373"
                      : "#e5e5e5",
                }}
              >
                Regime: {overview.vol_regime}
              </div>
            </div>

            {/* Advance / Decline */}
            <div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                Advance / Decline (last day)
              </div>
              <div
                style={{
                  fontSize: "1rem",
                  marginTop: "0.15rem",
                }}
              >
                <span
                  style={{
                    color:
                      pctAdv > pctDec
                        ? "#22c55e"
                        : pctAdv < pctDec
                        ? "#f97373"
                        : "#e5e5e5",
                  }}
                >
                  {formatPct(pctAdv)}
                </span>
{" "}
                /
{" "}
                <span
                  style={{
                    color:
                      pctDec > pctAdv
                        ? "#f97373"
                        : "#e5e5e5",
                  }}
                >
                  {formatPct(pctDec)}
                </span>
              </div>
            </div>

            {/* 52-week highs/lows */}
            <div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                52W Highs / Lows (counts)
              </div>
              <div
                style={{
                  fontSize: "1rem",
                  marginTop: "0.15rem",
                }}
              >
                <span
                  style={{
                    color:
                      overview.num_new_highs >= overview.num_new_lows
                        ? "#22c55e"
                        : "#e5e5e5",
                  }}
                >
                  {overview.num_new_highs}
                </span>
{" "}
                /
{" "}
                <span
                  style={{
                    color:
                      overview.num_new_lows > overview.num_new_highs
                        ? "#f97373"
                        : "#e5e5e5",
                  }}
                >
                  {overview.num_new_lows}
                </span>
              </div>
              <div style={{ fontSize: "0.75rem", opacity: 0.75 }}>
                {formatPct(overview.pct_new_highs)} highs,{" "}
                {formatPct(overview.pct_new_lows)} lows
              </div>
            </div>

            {/* 1M dispersion */}
            <div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7 }}>
                1M Return Dispersion
              </div>
              <div
                style={{
                  fontSize: "1rem",
                  marginTop: "0.15rem",
                  color:
                    overview.dispersion_1m > 0.15
                      ? "#f97373"
                      : overview.dispersion_1m < 0.07
                      ? "#22c55e"
                      : "#e5e5e5",
                }}
              >
                {formatNumber(overview.dispersion_1m, 3)}
              </div>
              <div style={{ fontSize: "0.75rem", opacity: 0.75 }}>
                Cross-sectional spread of 1M returns
              </div>
            </div>
          </div>

          {/* Explanation */}
          <p
            style={{
              marginTop: "0.9rem",
              fontSize: "0.85rem",
              opacity: 0.8,
            }}
          >
            The overview summarizes the equal-weighted S&amp;P universe:
            trend (1M/3M index returns), breadth (% of stocks above key moving
            averages), volatility regime, and short-horizon internals such as
            advance/decline, new 52-week highs/lows, and dispersion of 1-month
            returns. Together these describe whether the market is broadly
            trending, concentrated, rotational, or in a stressed high-vol
            environment.
          </p>
        </section>

        {/* Momentum */}
        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "1rem",
          }}
        >
          {/* Top momentum */}
          <div
            style={{
              padding: "1rem 1.25rem",
              borderRadius: "0.75rem",
              background: "#020617",
              border: "1px solid #1f2937",
            }}
          >
            <h2 style={{ fontSize: "1.05rem", marginBottom: "0.6rem" }}>
              Top {momentum.top.length} Momentum (1M)
            </h2>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.85rem",
              }}
            >
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={{ paddingBottom: "0.4rem" }}>Symbol</th>
                  <th style={{ paddingBottom: "0.4rem" }}>1M Return</th>
                </tr>
              </thead>
              <tbody>
                {momentum.top.map((item) => (
                  <tr key={item.ticker}>
                    <td style={{ padding: "0.18rem 0" }}>{item.ticker}</td>
                    <td
                      style={{
                        padding: "0.18rem 0",
                        color:
                          item.ret_1m > 0
                            ? "#22c55e"
                            : item.ret_1m < 0
                            ? "#f97373"
                            : "#e5e5e5",
                      }}
                    >
                      {formatPct(item.ret_1m)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p
              style={{
                marginTop: "0.8rem",
                fontSize: "0.82rem",
                opacity: 0.8,
              }}
            >
              Top momentum highlights the strongest 1-month performers in the
              index. These names often sit in leadership themes and can signal
              where capital has been rotating most aggressively in the recent
              regime.
            </p>
          </div>

          {/* Bottom momentum */}
          <div
            style={{
              padding: "1rem 1.25rem",
              borderRadius: "0.75rem",
              background: "#020617",
              border: "1px solid #1f2937",
            }}
          >
            <h2 style={{ fontSize: "1.05rem", marginBottom: "0.6rem" }}>
              Bottom {momentum.bottom.length} Momentum (1M)
            </h2>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.85rem",
              }}
            >
              <thead>
                <tr style={{ textAlign: "left" }}>
                  <th style={{ paddingBottom: "0.4rem" }}>Symbol</th>
                  <th style={{ paddingBottom: "0.4rem" }}>1M Return</th>
                </tr>
              </thead>
              <tbody>
                {momentum.bottom.map((item) => (
                  <tr key={item.ticker}>
                    <td style={{ padding: "0.18rem 0" }}>{item.ticker}</td>
                    <td
                      style={{
                        padding: "0.18rem 0",
                        color:
                          item.ret_1m > 0
                            ? "#22c55e"
                            : item.ret_1m < 0
                            ? "#f97373"
                            : "#e5e5e5",
                      }}
                    >
                      {formatPct(item.ret_1m)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p
              style={{
                marginTop: "0.8rem",
                fontSize: "0.82rem",
                opacity: 0.8,
              }}
            >
              Bottom momentum surfaces the weakest 1-month names. This list is
              useful for spotting breakdowns, areas of persistent selling
              pressure, or potential mean-reversion candidates depending on your
              trading style.
            </p>
          </div>
        </section>
      </div>
    );
  };

    // ============================
  // AI Report tab view
  // ============================

  const renderAiReportView = () => {
    return (
      <div
        style={{
          maxWidth: "800px",
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <div
          style={{
            padding: "0.75rem 1rem",
            borderRadius: "0.75rem",
            background: "#0f172a",
            border: "1px solid #1f2937",
            fontSize: "0.85rem",
          }}
        >
          <strong>Note:</strong>{" "}
          This AI-generated report is for educational and exploratory purposes only and is{" "}
          <span style={{ fontWeight: 600 }}>not financial advice</span>.
        </div>

        {/* Controls row: symbol + persona + button */}
        <section
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "1rem",
            alignItems: "center",
          }}
        >
          {/* Symbol selector (reuses the same selectedSymbol state) */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <label style={{ fontSize: "0.8rem", opacity: 0.8 }}>Symbol</label>
            <select
              value={selectedSymbol}
              onChange={handleChangeSymbol}
              style={{
                padding: "0.4rem 0.6rem",
                borderRadius: "0.5rem",
                border: "1px solid #374151",
                background: "#111827",
                color: "#e5e5e5",
                minWidth: "120px",
              }}
            >
              {(tickers.length ? tickers : ["AAPL"]).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {/* Persona selector */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <label style={{ fontSize: "0.8rem", opacity: 0.8 }}>Report style</label>
            <select
              value={persona}
              onChange={(e) =>
                setPersona(e.target.value as "balanced" | "skeptic" | "optimist" | "risk_taker")
              }
              style={{
                padding: "0.4rem 0.6rem",
                borderRadius: "0.5rem",
                border: "1px solid #374151",
                background: "#111827",
                color: "#e5e5e5",
                minWidth: "200px",
              }}
            >
              <option value="balanced">Balanced analyst</option>
              <option value="skeptic">Skeptic (risk-focused)</option>
              <option value="optimist">Optimist (growth-focused)</option>
              <option value="risk_taker">Risk taker / trader</option>
            </select>
          </div>

          {/* Generate button */}
          <button
            onClick={handleGenerateReport}
            disabled={aiLoading}
            style={{
              padding: "0.5rem 1rem",
              borderRadius: "999px",
              border: "1px solid #374151",
              background: aiLoading ? "#111827" : "#0b1120",
              color: "#f9fafb",
              fontSize: "0.9rem",
              cursor: aiLoading ? "default" : "pointer",
              opacity: aiLoading ? 0.6 : 1,
              marginTop: "0.9rem",
            }}
          >
            {aiLoading ? "Generating…" : "Generate AI report"}
          </button>
        </section>

        {/* Error message */}
        {aiError && (
          <div
            style={{
              padding: "0.75rem 1rem",
              borderRadius: "0.75rem",
              background: "#7f1d1d",
              fontSize: "0.85rem",
            }}
          >
            {aiError}
          </div>
        )}

        {/* Loading hint */}
        {aiLoading && (
          <div style={{ fontSize: "0.85rem", opacity: 0.8 }}>
            Talking to the model and summarizing recent behavior for {selectedSymbol}…
          </div>
        )}

        {/* Report body */}
        {aiReport && !aiLoading && (
          <div
            style={{
              padding: "1rem 1.25rem",
              borderRadius: "0.75rem",
              background: "#020617",
              border: "1px solid #1f2937",
              fontSize: "0.9rem",
              lineHeight: 1.6,
            }}
          >
            <ReactMarkdown>{aiReport}</ReactMarkdown>
          </div>
        )}

        {!aiReport && !aiLoading && !aiError && (
          <div style={{ fontSize: "0.85rem", opacity: 0.8 }}>
            Choose a symbol and report style, then click{" "}
            <span style={{ fontWeight: 500 }}>&quot;Generate AI report&quot;</span> to
            view a persona-driven narrative built from your price history.
          </div>
        )}
      </div>
    );
  };


  // ============================
  // Root render
  // ============================

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100vw",
        padding: "1.5rem",
        boxSizing: "border-box",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        background: "#050816",
        color: "#e5e5e5",
      }}
    >
      <header
        style={{
          marginBottom: "1rem",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "1.8rem", marginBottom: "0.35rem" }}>
          S&amp;P 500 Analytics
        </h1>
        <p style={{ opacity: 0.8, fontSize: "0.95rem" }}>
          Single-symbol forecasting and cross-sectional market trends.
        </p>
      </header>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: "0.75rem",
          marginBottom: "1.25rem",
          justifyContent: "center",
        }}
      >
        <button
          onClick={() => setActiveTab("symbol")}
          style={{
            padding: "0.45rem 0.9rem",
            borderRadius: "999px",
            border: "1px solid #374151",
            background: activeTab === "symbol" ? "#111827" : "transparent",
            color: "#e5e5e5",
            fontSize: "0.9rem",
            cursor: "pointer",
          }}
        >
          Single Symbol
        </button>
        <button
          onClick={() => setActiveTab("trends")}
          style={{
            padding: "0.45rem 0.9rem",
            borderRadius: "999px",
            border: "1px solid #374151",
            background: activeTab === "trends" ? "#111827" : "transparent",
            color: "#e5e5e5",
            fontSize: "0.9rem",
            cursor: "pointer",
          }}
        >
          General Trends
        </button>
        <button
          onClick={() => setActiveTab("aiReport")}
          style={{
            padding: "0.45rem 0.9rem",
            borderRadius: "999px",
            border: "1px solid #374151",
            background: activeTab === "aiReport" ? "#111827" : "transparent",
            color: "#e5e5e5",
            fontSize: "0.9rem",
            cursor: "pointer",
          }}
        >
          AI Report
        </button>
      </div>

      {activeTab === "symbol" && renderSymbolView()}
      {activeTab === "trends" && renderTrendsView()}
      {activeTab === "aiReport" && renderAiReportView()}
    </div>
  );
}

export default App;
