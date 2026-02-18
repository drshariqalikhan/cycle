
/**
 * server.js
 * A dedicated Node.js/Express server to fetch financial data.
 * Features:
 * - Robust fallback (Stooq -> Yahoo Finance) to handle IP blocks.
 * - Returns raw price data (High, Low, Close) for accurate technical analysis.
 */
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch'); // Ensure node-fetch v2 is installed
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

// --- MATH HELPERS (Server-side calculation optional, mostly for reference) ---
const calculateSMA = (d, p) => { if (!d || d.length < p) return new Array(d.length).fill(null); const s = new Array(d.length).fill(null); let sum = 0; for (let i=0; i<p; i++) sum+=d[i]; s[p-1]=sum/p; for (let i=p; i<d.length; i++) { sum=sum-d[i-p]+d[i]; s[i]=sum/p; } return s; };
const calculateEMA = (d, p) => { if (!d || d.length < p) return new Array(d.length).fill(null); const k=2/(p+1), e=new Array(d.length).fill(null); let sum=0; for (let i=0; i<p; i++) sum+=d[i]; e[p-1]=sum/p; for (let i=p; i<d.length; i++) { if (e[i-1]!==null) e[i]=(d[i]*k)+(e[i-1]*(1-k)); } return e; };

// --- DATA FETCHING ---
const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    const header = lines.shift().split(','); 
    // Basic detection of Yahoo vs Stooq format or assuming standard Order
    // Standard: Date, Open, High, Low, Close, Volume
    const dates = [], prices = [], highs = [], lows = [], volumes = [];
    
    lines.forEach(line => {
        const cols = line.split(',');
        if(cols.length < 5) return;
        
        // Try to handle Yahoo's "Adj Close" column if present (7 cols usually)
        // Yahoo: Date, Open, High, Low, Close, Adj Close, Volume
        // Stooq: Date, Open, High, Low, Close, Volume
        
        // We will target High, Low, and Close.
        // If 7 columns, Close is often index 4, Adj Close 5. We usually want Adjusted for long term, but let's stick to Close (4) for consistency.
        // Actually, Yahoo Close (4) is raw, Adj Close (5) is splits/divs. Stooq "Close" is usually adjusted.
        
        let d = cols[0];
        let h, l, c, v;
        
        if (cols.length >= 7) { // Likely Yahoo
            h = parseFloat(cols[2]);
            l = parseFloat(cols[3]);
            c = parseFloat(cols[4]); // Use Raw Close for now to match Stooq logic, or Adj Close (5)
            v = parseFloat(cols[6]);
        } else { // Likely Stooq
            h = parseFloat(cols[2]);
            l = parseFloat(cols[3]);
            c = parseFloat(cols[4]);
            v = parseFloat(cols[5]);
        }

        if (!isNaN(c) && !isNaN(h) && !isNaN(l)) {
            dates.push(d);
            highs.push(h);
            lows.push(l);
            prices.push(c);
            volumes.push(isNaN(v) ? 0 : v);
        }
    });
    return { dates, prices, highs, lows, volumes };
};

const fetchPriceData = async (ticker = 'VT.US', interval = 'w') => {
    // 1. Try Stooq
    try {
        console.log(`Fetching Stooq for ${ticker}...`);
        const url = `https://stooq.com/q/d/l/?s=${ticker}&i=${interval}&c=1`;
        const response = await fetch(url);
        if (response.ok) {
            const text = await response.text();
            if (text.includes('Date') && !text.includes('Exceeded limit')) {
                const data = parseCSV(text);
                if (data.prices.length > 0) return data;
            }
        }
    } catch (e) {
        console.error("Stooq failed:", e.message);
    }

    // 2. Fallback to Yahoo Finance
    try {
        // Yahoo ticker conversion: VT.US -> VT
        const yahooTicker = ticker.replace('.US', '');
        // Yahoo interval: '1wk' for weekly, '1d' for daily, '1mo' for monthly
        const yInterval = interval === 'w' ? '1wk' : (interval === 'm' ? '1mo' : '1d');
        console.log(`Fetching Yahoo for ${yahooTicker}...`);
        
        const url = `https://query1.finance.yahoo.com/v7/finance/download/${yahooTicker}?period1=0&period2=9999999999&interval=${yInterval}&events=history`;
        const response = await fetch(url);
        if (response.ok) {
            const text = await response.text();
            if (text.includes('Date')) {
                return parseCSV(text);
            }
        }
    } catch (e) {
         console.error("Yahoo failed:", e.message);
    }
    
    return { dates: [], prices: [], highs: [], lows: [], volumes: [] };
};

const fetchFredData = async (id) => {
    try {
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
    } catch (e) {
        console.error(`Fred fetch failed for ${id}:`, e.message);
        return [];
    }
};

// --- API ENDPOINT ---
app.get('/api/analyze', async (req, res) => {
    try {
        const { ticker = 'VT.US', interval = 'w' } = req.query;
        
        const [priceData, jobOpenings, sentiment, retailSales] = await Promise.all([
            fetchPriceData(ticker, interval),
            fetchFredData('JTS1000OSL'),
            fetchFredData('UMCSENT'),
            fetchFredData('RSXFS')
        ]);

        const { prices, highs, lows, dates, volumes } = priceData;
        
        // Server-side indicator calc (optional, but kept for compatibility)
        const fastEma = calculateEMA(prices, 10);
        const slowEma = calculateEMA(prices, 20);
        const phases = fastEma.map((fe, i) => {
            const se = slowEma[i];
            if (fe === null || se === null) return null;
            return fe < se ? PHASES.DOWNTREND : PHASES.NEW_UPTREND;
        });

        res.json({
            dates,
            prices,
            highs, // IMPORTANT: Needed for ATR calc on frontend
            lows,  // IMPORTANT: Needed for ATR calc on frontend
            volumes,
            indicators: {
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
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
