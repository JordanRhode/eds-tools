require('dotenv').config({ path: __dirname + '/.env' });
const fs = require('fs');
const path = require('path');
const Handlebars = require('handlebars');

const org = process.env.ORG;
const repo = process.env.REPO;
const token = process.env.TOKEN;

const inputData = 'https://main--evident-website-eds--evidentscientific.aem.live/en/downloads/manuals/download-list.json';
const outputPathPrefix = '/en/downloads/manuals/files';

const templateSource = fs.readFileSync(path.join(__dirname, 'page-template.hbs'), 'utf-8');
const template = Handlebars.compile(templateSource);

function toSlug(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getDateStringFromExcelSerialNumber(
	value,
) {
  const dateNumber = Number(value);
  if (!dateNumber || !Number.isFinite(dateNumber)) return value || '';


	if (dateNumber === 0) {
		return '';
	}

	// Excel's epoch starts on January 1, 1900
	const excelEpoch = new Date(1900, 0, 1);

	// Subtract 1 because Excel considers 1/1/1900 as day 1
	// Subtract another day for Excel's leap year bug (1900 is not a leap year)
	const daysOffset = dateNumber - 2;

	// Date calculation
	const parsedDate = new Date(
		excelEpoch.getTime() + daysOffset * 24 * 60 * 60 * 1000,
	);

	const options = {
		day: 'numeric',
		month: 'numeric',
		year: 'numeric',
	};

	return parsedDate.toLocaleDateString('en-US', options);
}

function buildGroupKey(row) {
  return [row.Title, row.Version, row.Product, row.Type].map(toSlug).join('|');
}

function buildCodeMap(rows) {
  const codeMap = {};
  for (const row of rows) {
    const key = buildGroupKey(row);
    if (!codeMap[key] && row.Code) {
      codeMap[key] = row.Code;
    }
  }
  return codeMap;
}

function mapRowToData(row, codeMap) {
  return {
    'date': getDateStringFromExcelSerialNumber(row.Date),
    'version': row.Version || '',
    'title-en': row.Title || '',
    'product-en': row.Product || '',
    'type-en': row.Type || '',
    'language-en': row.Language || '',
    'code': row.Code || codeMap[buildGroupKey(row)] || '',
    'link': row.Link || '',
    'marketing-content-en': row.MarketingContent || '',
    'enable-form': row.EnableForm || '',
  };
}

function buildFileName(row) {
  const parts = [row.Title, row.Version, row.Product, row.Type, row.Language]
    .map(toSlug)
    .filter(Boolean);
  return parts.join('-');
}

const BATCH_SIZE = 10;

async function savePage(html, filePath) {
  const blob = new Blob([html], { type: 'text/html' });
  const body = new FormData();
  body.append('data', blob);
  const opts = {
    headers: { Authorization: `Bearer ${token}` },
    method: 'POST',
    body,
  };
  const fullpath = `https://admin.da.live/source/${org}/${repo}${filePath}`;
  const resp = await fetch(fullpath, opts);
  return { status: resp.status, filePath };
}

(async function init() {
  const resp = await fetch(inputData);
  const json = await resp.json();
  const rows = json.data?.filter((row) => row.Link);

  const codeMap = buildCodeMap(rows);
  const results = [];
  const fileNameCounts = {};

  const tasks = rows.map((row) => {
    const data = mapRowToData(row, codeMap);
    const page = template(data);
    let fileName = buildFileName(row);
    if (fileNameCounts[fileName] === undefined) {
      fileNameCounts[fileName] = 0;
    } else {
      fileNameCounts[fileName]++;
      fileName = `${fileName}-copy-${fileNameCounts[fileName]}`;
    }
    const filePath = `${outputPathPrefix}/${fileName}.html`;
    return { page, filePath };
  });

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

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = path.join(__dirname, `output-${timestamp}.log`);
  fs.writeFileSync(outputFile, results.join('\n') + '\n');
  console.log(`Results saved to ${outputFile}`);
}());
