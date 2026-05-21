const express = require("express");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const LOGS_DIR = path.join(__dirname, "logs");

if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR);
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

function fetchCTLogs(domain) {
  return new Promise((resolve, reject) => {
    const url = `https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json&exclude=expired`;
    https.get(url, { headers: { "User-Agent": "ctl-downloader/1.0" } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`crt.sh returned status ${res.statusCode}`));
        return;
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error("Failed to parse crt.sh response"));
        }
      });
    }).on("error", reject);
  });
}

function extractSubdomains(entries, baseDomain) {
  const subdomains = new Set();
  const lowerBase = baseDomain.toLowerCase();

  for (const entry of entries) {
    const names = (entry.name_value || "").split("\n");
    for (const name of names) {
      const clean = name.trim().toLowerCase().replace(/^\*\./, "");
      if (clean && clean.endsWith(lowerBase)) {
        subdomains.add(clean);
      }
    }
  }

  return [...subdomains].sort();
}

function sanitizeDomain(domain) {
  return domain.replace(/[^a-zA-Z0-9.-]/g, "");
}

app.post("/api/scan", async (req, res) => {
  const domain = sanitizeDomain((req.body.domain || "").trim());
  if (!domain || !domain.includes(".")) {
    return res.status(400).json({ error: "Invalid domain" });
  }

  try {
    const entries = await fetchCTLogs(domain);
    const subdomains = extractSubdomains(entries, domain);

    const logFile = path.join(LOGS_DIR, `${domain}.log`);
    let existing = new Set();
    if (fs.existsSync(logFile)) {
      existing = new Set(
        fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean)
      );
    }

    for (const sub of subdomains) {
      existing.add(sub);
    }

    const allSorted = [...existing].sort();
    fs.writeFileSync(logFile, allSorted.join("\n") + "\n");

    res.json({
      domain,
      total: allSorted.length,
      newFound: subdomains.length,
      subdomains: allSorted,
    });
  } catch (err) {
    console.error(`Error scanning ${domain}:`, err.message);
    res.status(502).json({ error: `Failed to fetch CT logs: ${err.message}` });
  }
});

app.get("/api/logs/:domain", (req, res) => {
  const domain = sanitizeDomain(req.params.domain);
  const logFile = path.join(LOGS_DIR, `${domain}.log`);

  if (!fs.existsSync(logFile)) {
    return res.status(404).json({ error: "No log found for this domain" });
  }

  const subdomains = fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
  res.json({ domain, total: subdomains.length, subdomains });
});

app.get("/api/logs/:domain/download", (req, res) => {
  const domain = sanitizeDomain(req.params.domain);
  const logFile = path.join(LOGS_DIR, `${domain}.log`);

  if (!fs.existsSync(logFile)) {
    return res.status(404).json({ error: "No log found for this domain" });
  }

  res.download(logFile, `${domain}-subdomains.log`);
});

app.listen(PORT, () => {
  console.log(`CT Log Downloader running on http://localhost:${PORT}`);
});
