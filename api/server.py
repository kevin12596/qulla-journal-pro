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

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18791
    app.run(host='0.0.0.0', port=port, debug=False)
