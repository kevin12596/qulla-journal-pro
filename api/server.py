#!/usr/bin/env python3
"""
Qulla Journal Pro - 後端 API
- /api/quote/<symbol>     - 即時報價 + EMA + 當日 high/low
- /api/adr/<symbol>       - 近 20 日 ADR
- /api/analyze/<symbol>   - 全套分析（給網站「自動抓」按鈕用）
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from tradingview_ta import TA_Handler, Interval
import sys
import json

app = Flask(__name__)
CORS(app)

# 股票中文名稱快取
import requests as _req
_NAME_CACHE = {}
def get_stock_name(symbol, exchange='TWSE'):
    """從 TWSE MIS 查中文名，帶快取"""
    if not symbol or not str(symbol).isdigit():
        return None
    key = f"{exchange}_{symbol}"
    if key in _NAME_CACHE:
        return _NAME_CACHE[key]
    prefixes = ['tse', 'otc'] if exchange == 'TWSE' else ['otc', 'tse']
    for px in prefixes:
        try:
            r = _req.get('https://mis.twse.com.tw/stock/api/getStockInfo.jsp',
                params={'ex_ch': f'{px}_{symbol}.tw', 'json': '1'}, timeout=3,
                headers={'User-Agent': 'Mozilla/5.0'})
            arr = r.json().get('msgArray', [])
            if arr and arr[0].get('n'):
                name = arr[0]['n']
                _NAME_CACHE[key] = name
                return name
        except Exception:
            continue
    return None

# 偵測市場（上市/上櫃/興櫃/美股）
def detect_exchange(symbol):
    """嘗試多個交易所，回傳第一個成功的"""
    # 純數字 → 台股
    if symbol.isdigit():
        candidates = [
            ("TWSE", "taiwan"),
            ("TPEX", "taiwan"),
        ]
    else:
        # 字母 → 美股
        candidates = [
            ("NASDAQ", "america"),
            ("NYSE", "america"),
        ]
    for exch, scr in candidates:
        try:
            h = TA_Handler(symbol=symbol, screener=scr, exchange=exch, interval=Interval.INTERVAL_1_DAY)
            a = h.get_analysis()
            if a.indicators.get('close'):
                return exch, scr, a
        except Exception:
            continue
    return None, None, None

@app.route('/api/health')
def health():
    return jsonify({"ok": True})

@app.route('/api/quote/<symbol>')
def quote(symbol):
    exch, scr, a = detect_exchange(symbol)
    if not a:
        return jsonify({"error": "找不到此股票", "symbol": symbol}), 404
    ind = a.indicators
    return jsonify({
        "symbol": symbol,
        "name": get_stock_name(symbol, exch),
        "exchange": exch,
        "open": ind.get('open'),
        "high": ind.get('high'),
        "low": ind.get('low'),
        "close": ind.get('close'),
        "volume": ind.get('volume'),
        "ema10": round(ind.get('EMA10', 0), 2),
        "ema20": round(ind.get('EMA20', 0), 2),
        "ema50": round(ind.get('EMA50', 0), 2),
        "rsi": round(ind.get('RSI', 0), 1),
        "recommendation": a.summary.get('RECOMMENDATION'),
    })

@app.route('/api/adr/<symbol>')
def adr(symbol):
    """
    ADR (Average Daily Range %) = mean of last 20 days (high-low)/close * 100
    用 TradingView 的 weekly + daily 推估，因為 tradingview_ta 不直接給歷史資料
    我們用 yfinance 較完整
    """
    try:
        import yfinance as yf
    except ImportError:
        return jsonify({"error": "yfinance not installed"}), 500

    # 嘗試映射 symbol 到 yfinance 格式
    if symbol.isdigit():
        # 台股：先試 .TW (上市)，失敗再 .TWO (上櫃)
        for suffix in ['.TW', '.TWO']:
            ticker = symbol + suffix
            try:
                hist = yf.Ticker(ticker).history(period='1mo')
                if len(hist) >= 14:
                    daily_range = (hist['High'] - hist['Low']) / hist['Close'] * 100
                    adr_pct = daily_range.tail(20).mean()
                    return jsonify({
                        "symbol": symbol,
                        "ticker": ticker,
                        "adr_pct": round(adr_pct, 2),
                        "days": min(20, len(hist)),
                        "latest_close": round(float(hist['Close'].iloc[-1]), 2),
                        "latest_high": round(float(hist['High'].iloc[-1]), 2),
                        "latest_low": round(float(hist['Low'].iloc[-1]), 2),
                    })
            except Exception as e:
                continue
        return jsonify({"error": "無法取得歷史資料"}), 404
    else:
        # 美股
        try:
            hist = yf.Ticker(symbol).history(period='1mo')
            if len(hist) >= 14:
                daily_range = (hist['High'] - hist['Low']) / hist['Close'] * 100
                adr_pct = daily_range.tail(20).mean()
                return jsonify({
                    "symbol": symbol,
                    "ticker": symbol,
                    "adr_pct": round(adr_pct, 2),
                    "days": min(20, len(hist)),
                    "latest_close": round(float(hist['Close'].iloc[-1]), 2),
                    "latest_high": round(float(hist['High'].iloc[-1]), 2),
                    "latest_low": round(float(hist['Low'].iloc[-1]), 2),
                })
        except Exception as e:
            return jsonify({"error": str(e)}), 500

@app.route('/api/analyze/<symbol>')
def analyze(symbol):
    """全套分析：合併 quote + adr + Qulla 條件檢查"""
    # 取 quote
    exch, scr, a = detect_exchange(symbol)
    if not a:
        return jsonify({"error": "找不到此股票", "symbol": symbol}), 404
    ind = a.indicators

    # 取 ADR（透過 yfinance）
    adr_pct = None
    try:
        import yfinance as yf
        if symbol.isdigit():
            for suffix in ['.TW', '.TWO']:
                try:
                    hist = yf.Ticker(symbol + suffix).history(period='1mo')
                    if len(hist) >= 14:
                        adr_pct = round(((hist['High'] - hist['Low']) / hist['Close'] * 100).tail(20).mean(), 2)
                        break
                except Exception:
                    continue
        else:
            hist = yf.Ticker(symbol).history(period='1mo')
            if len(hist) >= 14:
                adr_pct = round(((hist['High'] - hist['Low']) / hist['Close'] * 100).tail(20).mean(), 2)
    except Exception as e:
        print(f"ADR 計算失敗：{e}", file=sys.stderr)

    # Qulla 條件
    close = ind.get('close', 0)
    ema10 = ind.get('EMA10', 0)
    ema20 = ind.get('EMA20', 0)
    ema50 = ind.get('EMA50', 0)
    bull_align = ema10 > ema20 > ema50
    above_all = close > ema10 and close > ema20 and close > ema50
    deviation = (close - ema10) / ema10 * 100 if ema10 else 0

    conditions = []
    warnings = []
    if bull_align:
        conditions.append("✅ EMA 多頭排列")
    else:
        warnings.append("❌ EMA 未多頭排列")
    if above_all:
        conditions.append("✅ 股價在所有 EMA 之上")
    if deviation < 25:
        if deviation > 15:
            warnings.append(f"🟡 乖離率 {deviation:.1f}% 偏高")
        else:
            conditions.append(f"✅ 乖離率正常 {deviation:.1f}%")
    else:
        warnings.append(f"⚠️ 乖離率 {deviation:.1f}% 過高，追高風險")

    return jsonify({
        "symbol": symbol,
        "name": get_stock_name(symbol, exch),
        "exchange": exch,
        "close": close,
        "open": ind.get('open'),
        "high": ind.get('high'),
        "low": ind.get('low'),
        "volume": ind.get('volume'),
        "ema10": round(ema10, 2),
        "ema20": round(ema20, 2),
        "ema50": round(ema50, 2),
        "rsi": round(ind.get('RSI', 0), 1),
        "deviation_pct": round(deviation, 1),
        "adr_pct": adr_pct,
        "bull_align": bull_align,
        "above_all_ema": above_all,
        "conditions": conditions,
        "warnings": warnings,
        "recommendation": a.summary.get('RECOMMENDATION'),
    })

# ============================================================
# Qullamaggie 完整選股檢查（適用台股 + 美股）
# ============================================================
def _yf_ticker(symbol):
    """回傳 yfinance ticker 字串"""
    if symbol.isdigit():
        # 台股：先試 .TW 再 .TWO
        return [symbol + '.TW', symbol + '.TWO']
    return [symbol.upper()]

@app.route('/api/qulla-screen/<symbol>')
def qulla_screen(symbol):
    """
    完整 Qullamaggie 選股檢查
    回傳：
      - 動能：3M/6M 漲幅、52週位置
      - 趨勢：EMA10/20/50 多頭排列
      - 整理形態：近 N 週高低、回撤 %
      - 量縮：近 5 日 vs 前 20 日均量比
      - ADR%
      - 入場條件：是否突破整理高點、是否爆量
      - 結論：買 / 等 / 不碰 + 理由
    """
    try:
        import yfinance as yf
    except ImportError:
        return jsonify({"error": "yfinance not installed"}), 500

    tickers = _yf_ticker(symbol)
    hist = None
    used_ticker = None
    for t in tickers:
        try:
            h = yf.Ticker(t).history(period='6mo')
            if len(h) >= 60:
                hist = h
                used_ticker = t
                break
        except Exception:
            continue
    if hist is None or len(hist) < 60:
        return jsonify({"error": "歷史資料不足（< 60 日），無法做完整選股檢查", "symbol": symbol}), 404

    closes = hist['Close']
    highs = hist['High']
    lows = hist['Low']
    vols = hist['Volume']

    last_close = float(closes.iloc[-1])
    high_52w = float(highs.max())
    low_52w = float(lows.min())
    pct_from_high = (last_close - high_52w) / high_52w * 100
    pct_in_range = (last_close - low_52w) / (high_52w - low_52w) * 100 if high_52w > low_52w else 0

    # 漲幅
    def pct_change_n(n):
        if len(closes) < n + 1:
            return None
        return (last_close - float(closes.iloc[-n - 1])) / float(closes.iloc[-n - 1]) * 100
    chg_3m = pct_change_n(63)   # ~3 個月
    chg_6m = pct_change_n(126)  # ~6 個月
    chg_1m = pct_change_n(21)

    # EMA
    ema10 = closes.ewm(span=10, adjust=False).mean()
    ema20 = closes.ewm(span=20, adjust=False).mean()
    ema50 = closes.ewm(span=50, adjust=False).mean()
    e10 = float(ema10.iloc[-1]); e20 = float(ema20.iloc[-1]); e50 = float(ema50.iloc[-1])
    bull_align = e10 > e20 > e50
    above_all = last_close > e10 and last_close > e20 and last_close > e50
    deviation = (last_close - e10) / e10 * 100 if e10 else 0

    # 整理形態：近 8 週（40 個交易日）的高/低/回撤
    consol_window = min(40, len(closes) - 1)
    recent = hist.tail(consol_window)
    consol_high = float(recent['High'].max())
    consol_low = float(recent['Low'].min())
    drawdown = (consol_high - consol_low) / consol_high * 100
    near_breakout = last_close >= consol_high * 0.97
    breakout_today = last_close > consol_high

    # 量縮：近 5 日均量 vs 前 20 日均量
    if len(vols) >= 25:
        vol_recent = float(vols.tail(5).mean())
        vol_prior = float(vols.iloc[-25:-5].mean())
        vol_ratio = vol_recent / vol_prior if vol_prior else 0
    else:
        vol_recent = vol_prior = vol_ratio = 0

    # 今日量 vs 20 日均量（突破日爆量檢查）
    vol_today = float(vols.iloc[-1])
    vol_avg20 = float(vols.tail(20).mean())
    vol_today_ratio = vol_today / vol_avg20 if vol_avg20 else 0

    # ADR
    daily_range_pct = (highs - lows) / closes * 100
    adr_pct = float(daily_range_pct.tail(20).mean())

    # ===== 條件評分 =====
    checks = []
    score = 0
    max_score = 0

    # 1. 動能：3M 漲幅 > 30%
    max_score += 2
    if chg_3m is None:
        checks.append({"item": "3個月漲幅", "value": "資料不足", "pass": False, "weight": 2})
    elif chg_3m >= 30:
        score += 2
        checks.append({"item": "3個月漲幅", "value": f"+{chg_3m:.1f}%", "pass": True, "weight": 2, "note": "✅ 動能達標（≥30%）"})
    elif chg_3m >= 15:
        score += 1
        checks.append({"item": "3個月漲幅", "value": f"+{chg_3m:.1f}%", "pass": False, "weight": 2, "note": "🟡 動能偏弱（15-30%）"})
    else:
        checks.append({"item": "3個月漲幅", "value": f"{chg_3m:+.1f}%", "pass": False, "weight": 2, "note": "❌ 動能不足（<15%）"})

    # 2. EMA 多頭排列
    max_score += 2
    if bull_align:
        score += 2
        checks.append({"item": "EMA10/20/50 多頭排列", "value": f"{e10:.2f} > {e20:.2f} > {e50:.2f}", "pass": True, "weight": 2, "note": "✅ 多頭排列"})
    else:
        order = f"EMA10={e10:.2f} EMA20={e20:.2f} EMA50={e50:.2f}"
        checks.append({"item": "EMA10/20/50 多頭排列", "value": order, "pass": False, "weight": 2, "note": "❌ 未多頭排列（核心條件，建議放棄）"})

    # 3. 股價在所有 EMA 上方
    max_score += 1
    if above_all:
        score += 1
        checks.append({"item": "股價在所有 EMA 上方", "value": f"{last_close:.2f}", "pass": True, "weight": 1})
    else:
        checks.append({"item": "股價在所有 EMA 上方", "value": f"{last_close:.2f}", "pass": False, "weight": 1, "note": "❌ 股價跌破至少一條 EMA"})

    # 4. 整理回撤 < 25%
    max_score += 2
    if drawdown < 25:
        score += 2
        checks.append({"item": f"近 {consol_window // 5} 週整理回撤", "value": f"{drawdown:.1f}%", "pass": True, "weight": 2, "note": "✅ 健康整理（<25%）"})
    elif drawdown < 35:
        score += 1
        checks.append({"item": f"近 {consol_window // 5} 週整理回撤", "value": f"{drawdown:.1f}%", "pass": False, "weight": 2, "note": "🟡 回撤偏深（25-35%）"})
    else:
        checks.append({"item": f"近 {consol_window // 5} 週整理回撤", "value": f"{drawdown:.1f}%", "pass": False, "weight": 2, "note": "❌ 回撤過深（>35%），非健康整理"})

    # 5. 量縮（整理期間量能萎縮）
    max_score += 1
    if 0 < vol_ratio < 0.85:
        score += 1
        checks.append({"item": "整理量縮", "value": f"近5日/前20日 = {vol_ratio:.2f}x", "pass": True, "weight": 1, "note": "✅ 量縮，賣壓減少"})
    elif vol_ratio == 0:
        checks.append({"item": "整理量縮", "value": "資料不足", "pass": False, "weight": 1})
    else:
        checks.append({"item": "整理量縮", "value": f"{vol_ratio:.2f}x", "pass": False, "weight": 1, "note": "🟡 量未明顯萎縮"})

    # 6. 乖離率 < 25%
    max_score += 1
    if deviation < 15:
        score += 1
        checks.append({"item": "乖離率", "value": f"{deviation:+.1f}%", "pass": True, "weight": 1, "note": "✅ 乖離正常"})
    elif deviation < 25:
        checks.append({"item": "乖離率", "value": f"{deviation:+.1f}%", "pass": False, "weight": 1, "note": "🟡 乖離偏高，追高風險"})
    else:
        checks.append({"item": "乖離率", "value": f"{deviation:+.1f}%", "pass": False, "weight": 1, "note": "❌ 乖離過高，已遠離均線"})

    # 7. ADR%（流動性與波動可接受）
    max_score += 1
    if 3 <= adr_pct <= 10:
        score += 1
        checks.append({"item": "ADR%", "value": f"{adr_pct:.2f}%", "pass": True, "weight": 1, "note": "✅ 波動適中"})
    elif adr_pct > 10:
        checks.append({"item": "ADR%", "value": f"{adr_pct:.2f}%", "pass": False, "weight": 1, "note": "🟡 波動偏大，停損會被打很寬"})
    else:
        checks.append({"item": "ADR%", "value": f"{adr_pct:.2f}%", "pass": False, "weight": 1, "note": "🟡 波動過小，動能不足"})

    # 8. 接近/突破整理高點（入場觸發）
    max_score += 1
    if breakout_today and vol_today_ratio >= 1.5:
        score += 1
        checks.append({"item": "突破整理高點", "value": f"收 {last_close:.2f} > 整理高 {consol_high:.2f}，量 {vol_today_ratio:.2f}x", "pass": True, "weight": 1, "note": "🚀 放量突破，可進場"})
    elif breakout_today:
        checks.append({"item": "突破整理高點", "value": f"突破但量 {vol_today_ratio:.2f}x", "pass": False, "weight": 1, "note": "🟡 突破但量未爆，等明日確認"})
    elif near_breakout:
        checks.append({"item": "突破整理高點", "value": f"距整理高 {consol_high:.2f} 還差 {(consol_high - last_close) / last_close * 100:.1f}%", "pass": False, "weight": 1, "note": "🟡 接近突破，可關注"})
    else:
        checks.append({"item": "突破整理高點", "value": f"距整理高 {(consol_high - last_close) / last_close * 100:.1f}%", "pass": False, "weight": 1, "note": "❌ 距突破還遠"})

    # ===== 結論 =====
    pct_score = score / max_score * 100
    # Qulla 核心紅線：EMA 必須多頭排列
    if not bull_align:
        verdict = "不碰"
        reason = "EMA 未多頭排列，違反 Qullamaggie 核心條件。等多頭排列確立再說。"
    elif drawdown >= 35:
        verdict = "不碰"
        reason = f"近期回撤 {drawdown:.1f}% > 35%，賣壓過重，非健康整理。"
    elif breakout_today and vol_today_ratio >= 1.5 and pct_score >= 70:
        verdict = "買"
        reason = f"放量突破整理高點 {consol_high:.2f}，分數 {score}/{max_score}（{pct_score:.0f}%）。建議今日收盤建倉，止損設於整理低點 {consol_low:.2f} 或當日最低。"
    elif near_breakout and pct_score >= 70:
        verdict = "等"
        reason = f"條件達標但尚未突破。距整理高 {consol_high:.2f} 還差 {(consol_high - last_close) / last_close * 100:.1f}%，等放量突破再進。"
    elif deviation > 25:
        verdict = "不碰"
        reason = f"乖離率 {deviation:.1f}% 過高，已遠離 EMA10。等回踩 EMA10/20 後再評估。"
    elif pct_score >= 60:
        verdict = "等"
        reason = f"分數 {score}/{max_score}（{pct_score:.0f}%），條件部分達標但有缺。等整理形態完成或突破訊號出現。"
    else:
        verdict = "不碰"
        reason = f"分數只有 {score}/{max_score}（{pct_score:.0f}%），多項核心條件未達標。"

    return jsonify({
        "symbol": symbol,
        "ticker": used_ticker,
        "name": get_stock_name(symbol),
        "close": round(last_close, 2),
        "high_52w": round(high_52w, 2),
        "low_52w": round(low_52w, 2),
        "pct_from_52w_high": round(pct_from_high, 1),
        "pct_in_52w_range": round(pct_in_range, 1),
        "chg_1m": round(chg_1m, 1) if chg_1m is not None else None,
        "chg_3m": round(chg_3m, 1) if chg_3m is not None else None,
        "chg_6m": round(chg_6m, 1) if chg_6m is not None else None,
        "ema10": round(e10, 2),
        "ema20": round(e20, 2),
        "ema50": round(e50, 2),
        "bull_align": bull_align,
        "above_all_ema": above_all,
        "deviation_pct": round(deviation, 1),
        "consol_window_days": consol_window,
        "consol_high": round(consol_high, 2),
        "consol_low": round(consol_low, 2),
        "drawdown_pct": round(drawdown, 1),
        "near_breakout": near_breakout,
        "breakout_today": breakout_today,
        "vol_ratio_recent5_vs_prior20": round(vol_ratio, 2),
        "vol_today_vs_avg20": round(vol_today_ratio, 2),
        "adr_pct": round(adr_pct, 2),
        "checks": checks,
        "score": score,
        "max_score": max_score,
        "score_pct": round(pct_score, 0),
        "verdict": verdict,
        "reason": reason,
    })


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18791
    app.run(host='0.0.0.0', port=port, debug=False)
