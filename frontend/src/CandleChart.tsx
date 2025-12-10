import React, { useEffect, useRef, useState } from "react";
import { createChart, ColorType } from "lightweight-charts";

export interface CandlePoint {
  time: string;   // "YYYY-MM-DD"
  open: number;
  high: number;
  low: number;
  close: number;
}

interface CandleChartProps {
  data: CandlePoint[];
}

const CandleChart: React.FC<CandleChartProps> = ({ data }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<CandlePoint[]>(data);
  const [hover, setHover] = useState<CandlePoint | null>(null);

  // keep live data reference for lookup
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#020617" },
        textColor: "#e5e5e5",
      },
      grid: {
        vertLines: { color: "#111827" },
        horzLines: { color: "#111827" },
      },
      rightPriceScale: { borderColor: "#1f2937" },
      timeScale: {
        borderColor: "#1f2937",
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#f97373",
      borderUpColor: "#22c55e",
      borderDownColor: "#f97373",
      wickUpColor: "#22c55e",
      wickDownColor: "#f97373",
    });

    series.setData(
      dataRef.current.map((d) => ({
        time: d.time,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
      })) as any
    );

    const handleCrosshairMove = (param: any) => {
      if (!param || param.point === undefined || param.time === undefined) {
        setHover(null);
        return;
      }

      let dateStr = "";
      const t = param.time;

      if (typeof t === "string") {
        dateStr = t;
      } else if (typeof t === "number") {
        dateStr = new Date(t * 1000).toISOString().slice(0, 10);
      } else if (typeof t === "object" && t.year) {
        const m = String(t.month).padStart(2, "0");
        const d = String(t.day).padStart(2, "0");
        dateStr = `${t.year}-${m}-${d}`;
      } else {
        dateStr = String(t);
      }

      const candle = dataRef.current.find((d) => d.time === dateStr) || null;

      console.log("Crosshair move:", dateStr);
      console.log("Matched candle:", candle);

      if (candle) {
        setHover(candle);
      } else {
        setHover(null);
      }
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);

    const handleResize = () => {
      if (!containerRef.current) return;
      chart.resize(
        containerRef.current.clientWidth,
        containerRef.current.clientHeight
      );
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
    };
  }, []);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
      }}
    >
      <div
        ref={containerRef}
        style={{
          width: "100%",
          height: "100%",
        }}
      />
      {hover && (
        <div
          style={{
            position: "absolute",
            top: 16,
            left: 16,
            zIndex: 9999,
            backgroundColor: "rgba(15,23,42,0.95)", // slate-900-ish
            color: "#f9fafb", // very light text
            border: "1px solid #4b5563",
            borderRadius: "0.5rem",
            padding: "0.5rem 0.75rem",
            fontSize: "0.8rem",
            lineHeight: 1.5,
            pointerEvents: "none",
            boxShadow: "0 12px 30px rgba(0,0,0,0.7)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {hover.time}
          </div>
          <div>O: {hover.open.toFixed(2)}</div>
          <div>H: {hover.high.toFixed(2)}</div>
          <div>L: {hover.low.toFixed(2)}</div>
          <div>C: {hover.close.toFixed(2)}</div>
        </div>
      )}
    </div>
  );
};

export default CandleChart;
