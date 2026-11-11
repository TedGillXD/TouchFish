import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { requestHolidayYears, useHolidayState } from "./holiday-client";

export default function HolidaySettings() {
  const state = useHolidayState();
  const [busy, setBusy] = useState(false);
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(String(currentYear));
  const requestedYear = Number(selectedYear);
  const validYear = Number.isInteger(requestedYear) && requestedYear >= 1900 && requestedYear < 2299;
  const years = state.years.map((item) => item.year).sort((a, b) => a - b);
  const desktop = !!window.touchFish?.holidays;
  const refreshing = busy || state.status === "refreshing";
  const refresh = async () => {
    if (refreshing || !validYear) return;
    setBusy(true);
    try {
      await requestHolidayYears([requestedYear - 1, requestedYear, requestedYear + 1], true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="holiday-download" aria-label="中国大陆节假日数据">
      <div className="holiday-download-heading">
        <span><Download size={13} />中国大陆 · 在线获取</span>
        <button
          className="text-button"
          onClick={() => void refresh()}
          disabled={!desktop || refreshing || !validYear}
        >
          <RefreshCw size={12} className={refreshing ? "holiday-spinning" : ""} />
          {refreshing ? "正在更新" : "更新节假日"}
        </button>
      </div>
      <label className="holiday-year-selector">
        更新年份
        <input
          aria-label="节假日更新年份"
          type="number"
          min="1900"
          max="2298"
          value={selectedYear}
          onChange={(event) => setSelectedYear(event.target.value)}
        />
        <span>同时检查相邻年份，衔接跨年调休</span>
      </label>
      <p className="holiday-cache-years">
        {years.length ? `已缓存 ${years.join("、")} 年` : "尚无节假日缓存，当前按工作制及手动排班估算。"}
      </p>
      <p className={`holiday-sync-message ${state.status === "error" ? "failed" : ""}`} role="status">
        {state.message}
      </p>
      {state.lastChecked && <p className="holiday-sync-time">
        最近检查 {new Date(state.lastChecked).toLocaleString("zh-CN", {
          year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
        })}
      </p>}
      <p className="holiday-download-note">
        自动联网更新并缓存，检查与下载跟随系统代理。日历中的手动调整优先，已开始的记录保留原计薪标准。
      </p>
    </div>
  );
}
