
/**
 * server.js
 * A dedicated Node.js/Express server to fetch financial data and calculate cycle indicators.
 * Deployment: See "Documentation" tab in the app.
 */
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Ensure node-fetch v2 is installed or use Node 18+ native fetch
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- CONSTANTS ---
const PHASES = { 
    DOWNTREND: 'DOWNTREND', 
    NEW_UPTREND: 'NEW_UPTREND', 
    LATE_UPTREND: 'LATE_UPTREND', 
    PRE_DOWNTREND: 'PRE_DOWNTREND' 
};

// --- MATH HELPERS ---
const calculateSMA = (d, p) => { 
    if (!d || d.length < p) return new Array(d.length).fill(null); 
    const s = new Array(d.length).fill(null); 
    let sum = 0; 
    for (let i=0; i<p; i++) sum+=d[i]; 
    s[p-1]=sum/p; 
    for (let i=p; i<d.length; i++) { sum=sum-d[i-p]+d[i]; s[i]=sum/p; } 
    return s; 
};

const calculateEMA = (d, p) => { 
    if (!d || d.length < p) return new Array(d.length).fill(null); 
    const k=2/(p+1), e=new Array(d.length).fill(null); 
    let sum=0; 
    for (let i=0; i<p; i++) sum+=d[i]; 
    e[p-1]=sum/p; 
    for (let i=p; i<d.length; i++) { if (e[i-1]!==null) e[i]=(d[i]*k)+(e[i-1]*(1-k)); } 
    return e; 
};

const calculateATR = (h, l, c, p) => {
    if (!h || !l || !c || h.length < p) return new Array(h.length).fill(null);
    const tr = new Array(h.length).fill(null);
    if (h[0] !== null && l[0] !== null) tr[0] = h[0] - l[0];
    for (let i = 1; i < h.length; i++) {
        const h_c = h[i], l_c = l[i], c_p = c[i - 1];
        if (h_c === null || l_c === null || c_p === null) continue;
        tr[i] = Math.max(h_c - l_c, Math.abs(h_c - c_p), Math.abs(l_c - c_p));
    }
    const atr = new Array(h.length).fill(null);
    let sum = 0, count = 0;
    for (let i = 0; i < p; i++) { if (tr[i] !== null) { sum += tr[i]; count++; } }
    if (count > 0) atr[p - 1] = sum / count;
    for (let i = p; i < h.length; i++) {
        if (tr[i] !== null && atr[i - 1] !== null) {
            atr[i] = (atr[i - 1] * (p - 1) + tr[i]) / p;
        }
    }
    return atr;
};

const calculateNormalizedMACDByATR = (d, atr, p12 = 12, p26 = 26, pS = 9) => {
    const e12 = calculateEMA(d, p12);
    const e26 = calculateEMA(d, p26);
    const macdLine = e26.map((v, i) => (v !== null && e12[i] !== null && atr[i] !== null && atr[i] !== 0) ? ((e12[i] - v) / atr[i]) * 100 : null);
    const signalLine = calculateEMA(macdLine, pS);
    const histogram = signalLine.map((v, i) => v !== null && macdLine[i] !== null ? macdLine[i] - v : null);
    return { macdLine, signalLine, histogram };
};

// --- DATA FETCHING ---
const fetchStooqData = async (ticker = 'VT.US', interval = 'w') => {
    const url = `https://stooq.com/q/d/l/?s=${ticker}&i=${interval}&c=1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Stooq fetch failed');
    const text = await response.text();
    // Parse CSV manually
    const lines = text.trim().split('\n');
    const header = lines.shift().split(','); // Assuming comma for simplicity
    const dates = [], prices = [], highs = [], lows = [];
    lines.forEach(line => {
        const cols = line.split(',');
        if(cols.length < 5) return;
        // Simple parsing assuming standard columns order or fixed
        // DATE, OPEN, HIGH, LOW, CLOSE
        dates.push(cols[0]);
        highs.push(parseFloat(cols[2]));
        lows.push(parseFloat(cols[3]));
        prices.push(parseFloat(cols[4]));
    });
    return { dates, prices, highs, lows };
};

const fetchFredData = async (id) => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
    const response = await fetch(url);
    if(!response.ok) return [];
    const text = await response.text();
    const lines = text.trim().split('\n');
    lines.shift(); // Header
    return lines.map(l => {
        const [date, val] = l.split(',');
        return { date, value: parseFloat(val) };
    }).filter(d => !isNaN(d.value));
};

// --- API ENDPOINT ---
app.get('/api/analyze', async (req, res) => {
    try {
        const { ticker = 'VT.US', interval = 'w' } = req.query;
        
        // 1. Fetch Data concurrently
        const [priceData, jobOpenings, sentiment, retailSales] = await Promise.all([
            fetchStooqData(ticker, interval),
            fetchFredData('JTS1000OSL'),
            fetchFredData('UMCSENT'),
            fetchFredData('RSXFS')
        ]);

        // 2. Calculations (Simplified for brevity)
        // Note: Real logic needs data alignment which is verbose.
        // We will just calculate Stock Indicators here.
        
        const { prices, highs, lows } = priceData;
        const atr = calculateATR(highs, lows, prices, 26);
        const macd = calculateNormalizedMACDByATR(prices, atr);
        const fastEma = calculateEMA(prices, 10);
        const slowEma = calculateEMA(prices, 20);

        // 3. Determine Phases
        const phases = fastEma.map((fe, i) => {
            const se = slowEma[i];
            if (fe === null || se === null) return null;
            return fe < se ? PHASES.DOWNTREND : PHASES.NEW_UPTREND; // Simplified logic
        });

        res.json({
            dates: priceData.dates,
            prices: priceData.prices,
            indicators: {
                macd,
                fastEma,
                slowEma
            },
            phases,
            economic: {
                jobOpenings,
                sentiment,
                retailSales
            }
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
