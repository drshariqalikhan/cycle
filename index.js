
/**
 * server.js
 * A dedicated Node.js/Express server to fetch financial data.
 * v2.3 - Uses yahoo-finance2 library for robust authentication
 */

const express = require('express');
const cors = require('cors');
// Robust Yahoo Finance library that handles crumbs/cookies
const yahooFinance = require('yahoo-finance2').default;

const fetch = globalThis.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Suppress library notices
yahooFinance.suppressNotices(['yahooSurvey']);

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

const fetchFredData = async (id) => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`;
    const response = await fetch(url, FETCH_OPTIONS);
    if (!response.ok) throw new Error(`FRED fetch failed for ${id}: ${response.status}`);
    return await response.text();
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
    res.json({ status: 'ok', message: 'CycleScreener API v2.3 is active.' });
});

app.get('/api/data', async (req, res) => {
    try {
        const { ticker = 'VT.US', interval = 'w' } = req.query;
        console.log(`Processing data request for ${ticker}...`);
        
        let stockData = null;

        // 1. Fetch Stock Data using yahoo-finance2 library
        try {
             // Map interval: 'd'->'1d', 'w'->'1wk', 'm'->'1mo'
            const yInterval = interval === 'd' ? '1d' : interval === 'm' ? '1mo' : '1wk';
            // Yahoo format: VT.US -> VT (usually)
            const yTicker = ticker.replace('.US', '');

            console.log(`Fetching Yahoo Finance (Lib) for ${yTicker}...`);
            
            // Fetch generous amount of history (from 1980)
            const result = await yahooFinance.chart(yTicker, {
                period1: '1980-01-01', 
                interval: yInterval
            });

            if (result && result.quotes && result.quotes.length > 0) {
                const dates = [], prices = [], highs = [], lows = [];
                result.quotes.forEach(q => {
                    if (q.date && q.close !== null && q.close !== undefined) {
                        dates.push(q.date.toISOString().split('T')[0]);
                        prices.push(q.close);
                        highs.push(q.high || q.close);
                        lows.push(q.low || q.close);
                    }
                });
                stockData = { dates, prices, highs, lows };
            }
        } catch (e) {
            console.error("Yahoo Library Error:", e.message);
        }

        if (!stockData) {
            throw new Error("Failed to fetch stock data via Yahoo Finance.");
        }

        // 2. Fetch Economic Data (FRED)
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

app.listen(PORT, () => console.log(`Server v2.3 running on port ${PORT}`));
