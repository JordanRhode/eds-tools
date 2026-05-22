require("dotenv").config({ path: __dirname + "/.env" });
const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");

const org = process.env.ORG;
const repo = process.env.REPO;
const token = process.env.TOKEN;

const inputData =
  "https://main--evident-website-eds--evidentscientific.aem.live/en/downloads/download-list.json";
const outputPathPrefix = "/en/downloads/files";

const templateSource = fs.readFileSync(
  path.join(__dirname, "page-template.hbs"),
  "utf-8",
);
const template = Handlebars.compile(templateSource);

const LANGUAGE_CODES = {
  English: "en",
  German: "de",
  Spanish: "es",
  French: "fr",
  Italian: "it",
  Japanese: "ja",
  Korean: "ko",
  Chinese: "zh",
};

const LANGUAGE_SORT_ORDER = ["en", "de", "es", "fr", "it", "ja", "ko", "zh"];

function toSlug(str) {
  return (str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getDateStringFromExcelSerialNumber(value) {
  const dateNumber = Number(value);
  if (!dateNumber || !Number.isFinite(dateNumber)) return value || "";

  if (dateNumber === 0) {
    return "";
  }

  // Excel's epoch starts on January 1, 1900
  const excelEpoch = new Date(1900, 0, 1);

  // Subtract 1 because Excel considers 1/1/1900 as day 1
  // Subtract another day for Excel's leap year bug (1900 is not a leap year)
  const daysOffset = dateNumber - 2;

  const parsedDate = new Date(
    excelEpoch.getTime() + daysOffset * 24 * 60 * 60 * 1000,
  );

  const options = {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  };

  return parsedDate.toLocaleDateString("en-US", options);
}

function buildGroupKey(row) {
  return [row.Title, row.Version, row.Product, row.Type].map(toSlug).join("|");
}

function groupRowsByDownload(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = buildGroupKey(row);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }
  return groups;
}

function isTruthy(value) {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function buildPageData(rowsInGroup) {
  const data = {
    date: "",
    version: "",
    code: "",
    link: "",
    "enable-form": "",
  };

  const linkParts = [];
  let anyEnableForm = false;

  for (const row of rowsInGroup) {
    if (!data["title-en"] && row.Title) data["title-en"] = row.Title;
    if (!data["product-en"] && row.Product) data["product-en"] = row.Product;
    if (!data["type-en"] && row.Type) data["type-en"] = row.Type;
    if (!data.date) data.date = getDateStringFromExcelSerialNumber(row.Date);
    if (!data.version) data.version = row.Version || "";
    if (!data.code && row.Code) data.code = row.Code;
    if (isTruthy(row.EnableForm)) anyEnableForm = true;

    const code = LANGUAGE_CODES[row.Language];
    if (code) {
      data[`title-${code}`] = row.Title || "";
      data[`product-${code}`] = row.Product || "";
      data[`type-${code}`] = row.Type || "";
      data[`marketing-content-${code}`] = row.MarketingContent || "";
      data[`disclaimer-content-${code}`] = row.DisclaimerContent || "";
    } else {
      // Fallback in place if there are non-standard languages
      if (!data["title-en"] && row.Title) data["title-en"] = row.Title;
      if (!data["product-en"] && row.Product) data["product-en"] = row.Product;
      if (!data["type-en"] && row.Type) data["type-en"] = row.Type;
      if (!data["marketing-content-en"] && row.MarketingContent) data["marketing-content-en"] = row.MarketingContent;
      if (!data["disclaimer-content-en"] && row.DisclaimerContent) data["disclaimer-content-en"] = row.DisclaimerContent;
    }

    if (row.Link) {
      const language = (row.Language || "").trim();
      if (language) {
        linkParts.push(`${language}|${row.Link}`);
      }
      else {
        linkParts.push(row.Link);
      }
    }
  }

  data["enable-form"] = anyEnableForm ? "true" : "";
  data.link = linkParts.join(",");

  return data;
}

function pickPrimaryRow(rowsInGroup) {
  const sorted = [...rowsInGroup].sort((a, b) => {
    const aIdx = LANGUAGE_SORT_ORDER.indexOf(LANGUAGE_CODES[a.Language]);
    const bIdx = LANGUAGE_SORT_ORDER.indexOf(LANGUAGE_CODES[b.Language]);
    const aRank = aIdx === -1 ? LANGUAGE_SORT_ORDER.length : aIdx;
    const bRank = bIdx === -1 ? LANGUAGE_SORT_ORDER.length : bIdx;
    return aRank - bRank;
  });
  return sorted[0];
}

function buildFileName(row) {
  const parts = [row.Title, row.Version, row.Product, row.Type]
    .map(toSlug)
    .filter(Boolean);
  return parts.join("-");
}

const BATCH_SIZE = 10;

async function savePage(html, filePath) {
  const blob = new Blob([html], { type: "text/html" });
  const body = new FormData();
  body.append("data", blob);
  const opts = {
    headers: { Authorization: `Bearer ${token}` },
    method: "POST",
    body,
  };
  const fullpath = `https://admin.da.live/source/${org}/${repo}${filePath}`;
  const resp = await fetch(fullpath, opts);
  return { status: resp.status, filePath };
}

(async function init() {
  const resp = await fetch(inputData);
  const json = await resp.json();
  const rows = json.data?.filter(
    (row) => row.Link,
  );

  const groups = groupRowsByDownload(rows);
  const results = [];
  const fileNameCounts = {};
  const tasks = [];

  for (const rowsInGroup of groups.values()) {
    const data = buildPageData(rowsInGroup);
    const page = template(data);
    let fileName = buildFileName(pickPrimaryRow(rowsInGroup));
    if (fileNameCounts[fileName] === undefined) {
      fileNameCounts[fileName] = 0;
    } else {
      fileNameCounts[fileName]++;
      fileName = `${fileName}-copy-${fileNameCounts[fileName]}`;
    }
    const filePath = `${outputPathPrefix}/${fileName}.html`;
    tasks.push({ page, filePath });
  }

  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(({ page, filePath }) => savePage(page, filePath)),
    );
    for (const { status, filePath } of batchResults) {
      const line = `${status} ${filePath}`;
      console.log(line);
      results.push(line);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = path.join(__dirname, `output-${timestamp}.log`);
  fs.writeFileSync(outputFile, results.join("\n") + "\n");
  console.log(`Results saved to ${outputFile}`);
})();
