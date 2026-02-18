
/**
 * server.js
 * A dedicated Node.js/Express server to fetch financial data.
 * v2.2 - Added Yahoo Finance Fallback & Improved Logging
 */

const express = require('express');
const cors = require('cors');

// Robust fetch loader
const fetch = globalThis.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// 1. REQUEST LOGGER
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// --- FETCH HELPERS ---
const FETCH_OPTIONS = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
};

const fetchStooqData = async (ticker, interval) => {
    const url = `https://stooq.com/q/d/l/?s=${ticker}&i=${interval}&c=1`;
    console.log("Fetching Stooq:", url);
    const response = await fetch(url, FETCH_OPTIONS);
    if (!response.ok) throw new Error(`Stooq fetch failed: ${response.status}`);
    return await response.text();
};

const fetchYahooData = async (ticker, interval) => {
    // Map interval: 'd'->'1d', 'w'->'1wk', 'm'->'1mo'
    const yahooInterval = interval === 'd' ? '1d' : interval === 'm' ? '1mo' : '1wk';
    // Yahoo ticker usually doesn't need .US suffix for major indices/ETFs, but checks vary.
    // For VT.US, Yahoo expects 'VT'.
    const yahooTicker = ticker.replace('.US', '');
    
    // Using period1=0 to period2=high_number gets max history
    const url = `https://query1.finance.yahoo.com/v7/finance/download/${yahooTicker}?period1=0&period2=9999999999&interval=${yahooInterval}&events=history`;
    console.log("Fetching Yahoo Fallback:", url);
    
    const response = await fetch(url, FETCH_OPTIONS);
    if (!response.ok) throw new Error(`Yahoo fetch failed: ${response.status}`);
    return await response.text();
};

const fetchFredData = async (id) => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
    const response = await fetch(url, FETCH_OPTIONS);
    if (!response.ok) throw new Error(`FRED fetch failed for ${id}: ${response.status}`);
    return await response.text();
};

const parseGeneralCSV = (csv) => {
    if (!csv) return null;
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return null;

    // Detect delimiter (Stooq sometimes uses semicolon)
    const headerLine = lines.shift().toUpperCase();
    const delimiter = headerLine.includes(';') ? ';' : ',';
    const header = headerLine.split(delimiter);

    const dateIdx = header.findIndex(h => h.includes('DATE'));
    const closeIdx = header.findIndex(h => h.includes('CLOSE'));
    const highIdx = header.findIndex(h => h.includes('HIGH'));
    const lowIdx = header.findIndex(h => h.includes('LOW'));

    if (dateIdx === -1 || closeIdx === -1) return null;

    const dates = [], prices = [], highs = [], lows = [];
    
    lines.forEach(line => {
        const cols = line.split(delimiter);
        if (cols.length <= Math.max(dateIdx, closeIdx)) return;
        
        const dateStr = cols[dateIdx];
        const price = parseFloat(cols[closeIdx]);
        
        // Ensure valid number
        if (!isNaN(price)) {
            dates.push(dateStr);
            prices.push(price);
            highs.push(parseFloat(cols[highIdx] || cols[closeIdx]));
            lows.push(parseFloat(cols[lowIdx] || cols[closeIdx]));
        }
    });

    if (prices.length === 0) return null;
    return { dates, prices, highs, lows };
};

const parseFredCSV = (csv) => {
    const lines = csv.trim().split('\n');
    lines.shift();
    return lines.map(line => {
        const [date, val] = line.split(',');
        const num = parseFloat(val);
        if (!date || isNaN(num) || val === '.') return null;
        return { date, value: num };
    }).filter(Boolean);
};

// --- ROUTES ---

app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'CycleScreener API v2.2 is active.' });
});

app.get('/api/data', async (req, res) => {
    try {
        const { ticker = 'VT.US', interval = 'w' } = req.query;
        console.log(`Processing data request for ${ticker}...`);
        
        // 1. Fetch Stock Data (Try Stooq first, then Yahoo)
        let stockData = null;
        
        // Try Stooq
        try {
            const raw = await fetchStooqData(ticker, interval);
            // Check for common Stooq error pages that aren't 404s
            if (!raw.trim().startsWith('<')) { 
                stockData = parseGeneralCSV(raw);
            }
        } catch (e) {
            console.warn("Stooq failed:", e.message);
        }

        // Try Yahoo if Stooq failed
        if (!stockData) {
            console.log("Attempting Yahoo Finance fallback...");
            try {
                const raw = await fetchYahooData(ticker, interval);
                stockData = parseGeneralCSV(raw);
            } catch (e) {
                console.warn("Yahoo failed:", e.message);
            }
        }

        if (!stockData) {
            throw new Error("Failed to fetch stock data from both Stooq and Yahoo.");
        }

        // 2. Fetch Economic Data (FRED)
        // We run this after stock data is secured to save resources if stock fails
        const [jobRaw, sentimentRaw, retailRaw] = await Promise.all([
            fetchFredData('JTS1000OSL'),
            fetchFredData('UMCSENT'),
            fetchFredData('RSXFS')
        ]);

        res.json({
            ticker,
            dates: stockData.dates,
            prices: stockData.prices,
            highs: stockData.highs,
            lows: stockData.lows,
            economic: {
                jobOpenings: parseFredCSV(jobRaw),
                consumerSentiment: parseFredCSV(sentimentRaw),
                retailSales: parseFredCSV(retailRaw)
            }
        });

    } catch (error) {
        console.error("API Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.use((req, res) => {
    res.status(404).json({ error: "Route not found. Use /api/data" });
});

app.listen(PORT, () => console.log(`Server v2.2 running on port ${PORT}`));
