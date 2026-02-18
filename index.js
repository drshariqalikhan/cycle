
/**
 * server.js
 * A dedicated Node.js/Express server to fetch financial data.
 * 
 * IMPORTANT: Financial providers (Stooq, FRED) often block cloud servers
 * (like Render/Heroku) unless a 'User-Agent' header is present.
 */

const express = require('express');
const cors = require('cors');
// If using Node < 18, you might need: const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- HEADERS TO BYPASS BLOCKING ---
const FETCH_OPTIONS = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
};

const fetchStooqData = async (ticker, interval) => {
    const url = `https://stooq.com/q/d/l/?s=${ticker}&i=${interval}&c=1`;
    console.log(`Fetching Stooq: ${url}`);
    const response = await fetch(url, FETCH_OPTIONS);
    if (!response.ok) throw new Error(`Stooq fetch failed: ${response.status} ${response.statusText}`);
    const text = await response.text();
    // Stooq returns a 200 OK with "Exceeded the limit" HTML if rate limited/blocked
    if (text.trim().startsWith('<')) {
        console.error("Stooq returned HTML instead of CSV. Content preview:", text.substring(0, 100));
        throw new Error("Stooq returned HTML (likely rate limit or block).");
    }
    return text;
};

const fetchFredData = async (id) => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
    console.log(`Fetching FRED: ${url}`);
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

// 1. Root Route: Returns a simple message so you know the server is up.
app.get('/', (req, res) => {
    res.send('CycleScreener API is active. Use /api/data?ticker=VT.US to fetch data.');
});

// 2. Data Route
app.get('/api/data', async (req, res) => {
    try {
        const { ticker = 'VT.US', interval = 'w' } = req.query;
        
        const [stooqRaw, jobRaw, sentimentRaw, retailRaw] = await Promise.all([
            fetchStooqData(ticker, interval),
            fetchFredData('JTS1000OSL'),
            fetchFredData('UMCSENT'),
            fetchFredData('RSXFS')
        ]);

        const stockData = parseStooqCSV(stooqRaw);
        if (!stockData) throw new Error("Failed to parse stock data");

        const fredData = {
            jobOpenings: parseFredCSV(jobRaw),
            consumerSentiment: parseFredCSV(sentimentRaw),
            retailSales: parseFredCSV(retailRaw)
        };

        res.json({
            ticker,
            dates: stockData.dates,
            prices: stockData.prices,
            highs: stockData.highs,
            lows: stockData.lows,
            economic: fredData
        });

    } catch (error) {
        console.error("API Error Details:", error);
        res.status(500).json({ error: error.message, details: "Check server logs for parsing errors." });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
