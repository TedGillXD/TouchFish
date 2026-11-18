import { ArrowLeft, House, Minus, RotateCw, Tv, X } from "lucide-react";
import type { HongguoWindowAction } from "./hongguo-types";
import "./hongguo-window.css";

export default function HongguoWindowBar() {
  const action = (name: HongguoWindowAction) => window.hongguoWindow?.action(name);
  return (
    <header className="hongguo-window-bar" aria-label="红果短剧小窗控制">
      <div className="hongguo-window-navigation">
        <button type="button" title="返回上一页" aria-label="返回上一页" onClick={() => action("back")}><ArrowLeft size={15} /></button>
        <button type="button" title="回到红果首页" aria-label="回到红果首页" onClick={() => action("home")}><House size={14} /></button>
        <button type="button" title="刷新红果网页" aria-label="刷新红果网页" onClick={() => action("reload")}><RotateCw size={14} /></button>
      </div>
      <div className="hongguo-window-title"><Tv size={15} />红果短剧</div>
      <div className="hongguo-window-buttons">
        <button type="button" title="最小化窗口" aria-label="最小化窗口" onClick={() => action("minimize")}><Minus size={17} /></button>
        <button type="button" title="关闭窗口" aria-label="关闭窗口" onClick={() => action("close")}><X size={17} /></button>
      </div>
    </header>
  );
}
