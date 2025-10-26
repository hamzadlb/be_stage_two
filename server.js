import express from "express";
import pool from "./db.js";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import * as Jimp from "jimp";
import fetch from "node-fetch";

dotenv.config();

const PORT = process.env.PORT || 8000;
const CACHE_IMAGE_PATH = process.env.CACHE_IMAGE_PATH || path.join(process.cwd(), "cache", "summary.png");
const COUNTRIES_API_URL = process.env.COUNTRIES_API_URL || "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies";
const EXCHANGE_API_URL = process.env.EXCHANGE_API_URL || "https://open.er-api.com/v6/latest/USD";
const EXTERNAL_TIMEOUT_MS = Number(process.env.EXTERNAL_TIMEOUT_MS || 10000);

const app = express();
app.use(express.json());

let refreshInProgress = false;

function jsonError(res, status, message, details) {
  const body = { error: message };
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}

function normalizeName(name) {
  return (name || "").trim().toLowerCase();
}

function randomMultiplier() {
  return Math.floor(Math.random() * 1001) + 1000;
}

function computeEstimatedGDP(population, exchangeRate) {
  if (!population || !exchangeRate || Number(exchangeRate) === 0) return null;
  const multiplier = randomMultiplier();
  return (Number(population) * multiplier) / Number(exchangeRate);
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function generateSummaryImage(totalCount, top5, timestampIso) {
  const cacheDir = path.dirname(CACHE_IMAGE_PATH);
  await fs.mkdir(cacheDir, { recursive: true });

  const width = 1000;
  const height = 600;
  const margin = 40;

  const image = await Jimp.Jimp.create(width, height, 0xffffffff);
  const fontTitle = await Jimp.Jimp.loadFont(Jimp.Jimp.FONT_SANS_32_BLACK);
  const fontText = await Jimp.Jimp.loadFont(Jimp.Jimp.FONT_SANS_16_BLACK);

  image.print(fontTitle, margin, margin, `Countries: ${totalCount}`);
  image.print(fontText, margin, margin + 50, `Last refresh: ${timestampIso}`);
  image.print(fontText, margin, margin + 80, `Top ${top5.length} by estimated GDP:`);

  let y = margin + 120;
  top5.forEach((c, idx) => {
    const gdpStr = c.estimated_gdp != null ? Number(c.estimated_gdp).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "N/A";
    image.print(fontText, margin, y, `${idx + 1}. ${c.name} — ${gdpStr}`);
    y += 30;
  });

  const tmpPath = CACHE_IMAGE_PATH + ".tmp";
  await image.writeAsync(tmpPath);
  await fs.rename(tmpPath, CACHE_IMAGE_PATH);
}

app.post("/countries/refresh", async (req, res) => {
  if (refreshInProgress) return jsonError(res, 409, "Refresh already in progress");
  refreshInProgress = true;

  let conn;
  try {
    const countriesPromise = fetchWithTimeout(COUNTRIES_API_URL).catch(() => { throw { api: "Countries API" }; });
    const ratesPromise = fetchWithTimeout(EXCHANGE_API_URL).catch(() => { throw { api: "Exchange Rates API" }; });

    const [countriesData, ratesData] = await Promise.all([countriesPromise, ratesPromise]);

    if (!Array.isArray(countriesData)) throw { api: "Countries API" };

    const rates = ratesData && (ratesData.rates || ratesData.conversion_rates) ? (ratesData.rates || ratesData.conversion_rates) : {};

    conn = await pool.getConnection();
    await conn.beginTransaction();

    for (const c of countriesData) {
      const name = c.name || null;
      const population = c.population != null ? c.population : null;
      if (!name || population == null) continue;

      const capital = c.capital || null;
      const region = c.region || null;
      const flag_url = c.flag || null;

      let currency_code = "N/A";
      if (Array.isArray(c.currencies) && c.currencies.length > 0 && c.currencies[0] && c.currencies[0].code) {
        currency_code = String(c.currencies[0].code).trim().toUpperCase();
      }

      let exchange_rate = null;
      let estimated_gdp = 0;

      if (currency_code !== "N/A" && Object.prototype.hasOwnProperty.call(rates, currency_code)) {
        exchange_rate = rates[currency_code];
        estimated_gdp = computeEstimatedGDP(population, exchange_rate);
      }

      const normalized = normalizeName(name);
      const last_refreshed_at = new Date();

      try {
        await conn.execute(
          `INSERT INTO countries (name, normalized_name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             name = VALUES(name),
             capital = VALUES(capital),
             region = VALUES(region),
             population = VALUES(population),
             currency_code = VALUES(currency_code),
             exchange_rate = VALUES(exchange_rate),
             estimated_gdp = VALUES(estimated_gdp),
             flag_url = VALUES(flag_url),
             last_refreshed_at = VALUES(last_refreshed_at)`,
          [name, normalized, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at]
        );
      } catch (err) {
        console.error("DB Insert Error:", name, err);
        throw err;
      }
    }

    const lastRef = new Date().toISOString();
    await conn.execute(
      `INSERT INTO meta (\`key\`, value) VALUES (?, ?) 
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      ["last_refreshed_at", lastRef]
    );

    await conn.commit();

    const [countRows] = await pool.query("SELECT COUNT(*) AS total FROM countries");
    const total = countRows[0].total;

    const [topRows] = await pool.query("SELECT name, estimated_gdp FROM countries WHERE estimated_gdp IS NOT NULL ORDER BY estimated_gdp DESC LIMIT 5");
    const top5 = topRows.map(r => ({ name: r.name, estimated_gdp: r.estimated_gdp }));

    try { await generateSummaryImage(total, top5, lastRef); } catch (e) { console.error("Image Error:", e); }

    refreshInProgress = false;
    return res.json({ message: "Refresh successful", total_countries: total, last_refreshed_at: lastRef });

  } catch (err) {
    refreshInProgress = false;
    if (conn) {
      try { await conn.rollback(); } catch (e) {}
      conn.release();
    }
    console.error("Refresh Error:", err);
    if (err && err.api) return jsonError(res, 503, "External data source unavailable", `Could not fetch data from ${err.api}`);
    if (err && err.name === "AbortError") return jsonError(res, 503, "External data source unavailable", "Fetch timed out");
    return jsonError(res, 500, "Internal server error");
  }
});


app.get("/countries", async (req, res) => {
  try {
    const { region, currency, sort, page = 1, limit = 100 } = req.query;

    console.log('Raw query parameters:', { region, currency, sort, page, limit });
    console.log('Type of page:', typeof page, 'Type of limit:', typeof limit);

    // More robust conversion
    const pageNum = parseInt(String(page), 10);
    const limitNum = parseInt(String(limit), 10);
    
    const validatedPage = isNaN(pageNum) || pageNum < 1 ? 1 : pageNum;
    const validatedLimit = isNaN(limitNum) || limitNum < 1 ? 100 : Math.min(limitNum, 1000);
    const offset = (validatedPage - 1) * validatedLimit;

    console.log('Processed values:', { validatedPage, validatedLimit, offset });

    const where = [];
    const params = [];

    if (region && String(region).trim() !== '') {
      where.push("LOWER(region) = LOWER(?)");
      params.push(String(region).trim());
    }
    if (currency && String(currency).trim() !== '') {
      where.push("currency_code = ?");
      params.push(String(currency).trim().toUpperCase());
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    let orderSql = "";
    if (sort === "gdp_desc") orderSql = "ORDER BY estimated_gdp DESC";
    if (sort === "gdp_asc") orderSql = "ORDER BY estimated_gdp ASC";

    // Approach 1: Use query instead of execute with parameterized LIMIT
    const sql = `SELECT id, name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at 
                 FROM countries ${whereSql} ${orderSql} LIMIT ? OFFSET ?`;

    // Ensure we're passing proper integers
    const finalParams = [...params, validatedLimit, offset];
    
    console.log('Final SQL:', sql);
    console.log('Final parameters:', finalParams);
    console.log('Parameter types:', finalParams.map(p => `${typeof p}: ${p}`));

    // Use query instead of execute
    const [rows] = await pool.query(sql, finalParams);
    return res.json(rows);

  } catch (err) {
    console.error("GET /countries error:", err);
    console.error("Error details:", err.message);
    return jsonError(res, 500, "Internal server error");
  }
});


app.get("/countries/:name", async (req, res) => {
  try {
    const normalized = normalizeName(req.params.name);
    const [rows] = await pool.execute(
      "SELECT id, name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url, last_refreshed_at FROM countries WHERE normalized_name = ?",
      [normalized]
    );
    if (!rows.length) return jsonError(res, 404, "Country not found");
    return res.json(rows[0]);
  } catch (err) {
    return jsonError(res, 500, "Internal server error");
  }
});


app.delete("/countries/:name", async (req, res) => {
  try {
    const normalized = normalizeName(req.params.name);
    const [result] = await pool.execute("DELETE FROM countries WHERE normalized_name = ?", [normalized]);
    if (result.affectedRows === 0) return jsonError(res, 404, "Country not found");
    return res.json({ message: "Deleted" });
  } catch (err) {
    return jsonError(res, 500, "Internal server error");
  }
});


app.get("/status", async (req, res) => {
  try {
    const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM countries");
    const [r] = await pool.execute("SELECT value FROM meta WHERE `key` = ?", ["last_refreshed_at"]);
    const lastRef = r.length ? r[0].value : null;
    return res.json({ total_countries: total, last_refreshed_at: lastRef });
  } catch (err) {
    return jsonError(res, 500, "Internal server error");
  }
});


app.get("/countries/image", async (req, res) => {
  try {
    await fs.access(CACHE_IMAGE_PATH);
    return res.sendFile(path.resolve(CACHE_IMAGE_PATH));
  } catch (err) {
    return jsonError(res, 404, "Summary image not found");
  }
});


app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
