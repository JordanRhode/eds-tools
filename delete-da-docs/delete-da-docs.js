require("dotenv").config({ path: __dirname + "/.env" });
const fs = require("fs");
const path = require("path");

const org = process.env.ORG;
const repo = process.env.REPO;
const token = process.env.TOKEN;

const inputFile = path.join(__dirname, "paths-to-delete.json");
const BATCH_SIZE = 50;

async function deletePath(sourcePath) {
  const fullpath = `https://admin.da.live/source${sourcePath}`;
  const opts = {
    headers: { Authorization: `Bearer ${token}` },
    method: "DELETE",
  };
  const resp = await fetch(fullpath, opts);
  return { status: resp.status, sourcePath };
}

(async function init() {
  if (!org || !repo || !token) {
    console.error("Missing ORG, REPO, or TOKEN in .env");
    process.exit(1);
  }

  const items = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
  const expectedPrefix = `/${org}/${repo}/`;
  const results = [];
  const tasks = [];

  for (const item of items) {
    if (!item.path) continue;
    if (!item.path.startsWith(expectedPrefix)) {
      const line = `SKIP ${item.path} (does not match /${org}/${repo}/)`;
      console.log(line);
      results.push(line);
      continue;
    }
    tasks.push(item.path);
  }

  for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
    const batch = tasks.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(deletePath));
    for (const { status, sourcePath } of batchResults) {
      const line = `${status} ${sourcePath}`;
      console.log(line);
      results.push(line);
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = path.join(__dirname, `output-${timestamp}.log`);
  fs.writeFileSync(outputFile, results.join("\n") + "\n");
  console.log(`Results saved to ${outputFile}`);
})();
