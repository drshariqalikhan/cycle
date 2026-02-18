
/**
 * server.js
 * A dedicated Node.js/Express server to fetch financial data.
 * v2.1 - Enhanced Logging & JSON Error Handling
 */

const express = require('express');
const cors = require('cors');

// Robust fetch loader: Use global fetch (Node 18+) or require node-fetch
const fetch = globalThis.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// 1. REQUEST LOGGER: Prints every request to the console.
// This helps confirm if the request is actually reaching your server.
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// --- FETCH HELPERS ---
const FETCH_OPTIONS = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
};

const fetchStooqData = async (ticker, interval) => {
    const url = `https://stooq.com/q/d/l/?s=${ticker}&i=${interval}&c=1`;
    const response = await fetch(url, FETCH_OPTIONS);
    if (!response.ok) throw new Error(`Stooq fetch failed: ${response.status}`);
    const text = await response.text();
    // Stooq often returns 200 OK with HTML content if blocked.
    if (text.trim().startsWith('<')) throw new Error("Stooq returned HTML (Rate Limit/Block)");
    return text;
};

const fetchFredData = async (id) => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
    const response = await fetch(url, FETCH_OPTIONS);
    if (!response.ok) throw new Error(`FRED fetch failed for ${id}: ${response.status}`);
    return await response.text();
};

const parseStooqCSV = (csv) => {
    const lines = csv.trim().split('\n');
    if (lines.length < 2) return null;
    const header = lines.shift().toUpperCase().split(',');
    const dateIdx = header.findIndex(h => h.includes('DATE'));
    const closeIdx = header.findIndex(h => h.includes('CLOSE'));
    const highIdx = header.findIndex(h => h.includes('HIGH'));
    const lowIdx = header.findIndex(h => h.includes('LOW'));
    if (dateIdx === -1 || closeIdx === -1) return null;
    const dates = [], prices = [], highs = [], lows = [];
    lines.forEach(line => {
        const cols = line.split(',');
        if (cols.length <= Math.max(dateIdx, closeIdx)) return;
        dates.push(cols[dateIdx]);
        prices.push(parseFloat(cols[closeIdx]));
        highs.push(parseFloat(cols[highIdx] || cols[closeIdx]));
        lows.push(parseFloat(cols[lowIdx] || cols[closeIdx]));
    });
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

// Health Check - Returns JSON
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'CycleScreener API v2 is active. Endpoints available: /api/data' });
});

// Data Endpoint
app.get('/api/data', async (req, res) => {
    try {
        const { ticker = 'VT.US', interval = 'w' } = req.query;
        console.log(`Processing data request for ${ticker}...`);
        
        const [stooqRaw, jobRaw, sentimentRaw, retailRaw] = await Promise.all([
            fetchStooqData(ticker, interval),
            fetchFredData('JTS1000OSL'),
            fetchFredData('UMCSENT'),
            fetchFredData('RSXFS')
        ]);

        const stockData = parseStooqCSV(stooqRaw);
        if (!stockData) throw new Error("Failed to parse stock data");

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

// 2. 404 HANDLER: Returns JSON instead of HTML for unknown routes.
// This prevents the "HTML instead of JSON" error in the frontend.
app.use((req, res) => {
    console.log(`404 Warning: Route not found ${req.url}`);
    res.status(404).json({ error: "Route not found. Please check your URL. It should end with /api/data" });
});

app.listen(PORT, () => console.log(`Server v2 running on port ${PORT}`));
