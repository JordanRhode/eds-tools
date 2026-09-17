require("dotenv").config({ path: __dirname + "/.env" });
const fs = require("fs");
const path = require("path");

const org = process.env.ORG;
const repo = process.env.REPO;
const token = process.env.TOKEN;

const configFile = path.join(__dirname, "find-replace.config.json");
const BATCH_SIZE = 10;

// Dry run unless --apply is passed, so an accidental run never edits content.
const apply = process.argv.includes("--apply");

function authOpts(extra = {}) {
  return { headers: { Authorization: `Bearer ${token}` }, ...extra };
}

// Accepts "/en/page.html" or "/org/repo/en/page.html" and returns it
// relative to the repo root.
function toRepoPath(configuredPath) {
  const prefix = `/${org}/${repo}`;
  const normalized = configuredPath.startsWith("/")
    ? configuredPath
    : `/${configuredPath}`;
  if (normalized === prefix) return "";
  if (normalized.startsWith(`${prefix}/`)) {
    return normalized.slice(prefix.length);
  }
  return normalized;
}

function isDocPath(repoPath) {
  return repoPath.toLowerCase().endsWith(".html");
}

async function listChildren(repoPath) {
  const fullpath = `https://admin.da.live/list/${org}/${repo}${repoPath}`;
  const resp = await fetch(fullpath, authOpts());
  if (!resp.ok) {
    throw new Error(`list ${resp.status} ${fullpath}`);
  }
  return resp.json();
}

// Expands folder paths into the document paths beneath them.
async function collectDocPaths(repoPath, recursive, seen, results) {
  const children = await listChildren(repoPath);
  for (const child of children) {
    const childPath = toRepoPath(child.path);
    const isFolder = !child.ext;
    if (isFolder) {
      if (recursive) {
        await collectDocPaths(childPath, recursive, seen, results);
      }
      continue;
    }
    if (!isDocPath(childPath)) continue;
    if (seen.has(childPath)) continue;
    seen.add(childPath);
    results.push(childPath);
  }
}

async function resolveDocPaths(entries) {
  const seen = new Set();
  const docPaths = [];

  for (const entry of entries) {
    const configuredPath = typeof entry === "string" ? entry : entry.path;
    if (!configuredPath) continue;
    const repoPath = toRepoPath(configuredPath);

    if (isDocPath(repoPath)) {
      if (seen.has(repoPath)) continue;
      seen.add(repoPath);
      docPaths.push(repoPath);
      continue;
    }

    const recursive =
      typeof entry === "object" && entry.recursive !== undefined
        ? entry.recursive
        : true;
    await collectDocPaths(repoPath, recursive, seen, docPaths);
  }

  return docPaths;
}

function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(rule) {
  if (!rule || typeof rule.find !== "string" || rule.find === "") {
    throw new Error(`Replacement rule is missing a non-empty "find" value`);
  }
  const source = rule.isRegex ? rule.find : escapeForRegex(rule.find);
  const flags = rule.flags || (rule.caseSensitive === false ? "gi" : "g");
  const withGlobal = flags.includes("g") ? flags : `${flags}g`;
  return {
    pattern: new RegExp(source, withGlobal),
    replace: rule.replace ?? "",
    label: `"${rule.find}" -> "${rule.replace ?? ""}"`,
  };
}

async function getDoc(repoPath) {
  const fullpath = `https://admin.da.live/source/${org}/${repo}${repoPath}`;
  const resp = await fetch(fullpath, authOpts());
  if (!resp.ok) {
    return { status: resp.status, html: null };
  }
  return { status: resp.status, html: await resp.text() };
}

async function saveDoc(repoPath, html) {
  const blob = new Blob([html], { type: "text/html" });
  const body = new FormData();
  body.append("data", blob);
  const fullpath = `https://admin.da.live/source/${org}/${repo}${repoPath}`;
  const resp = await fetch(fullpath, authOpts({ method: "POST", body }));
  return resp.status;
}

async function processDoc(repoPath, matchers) {
  const { status, html } = await getDoc(repoPath);
  if (html === null) {
    return { line: `GET ${status} ${repoPath}`, changed: false };
  }

  let updated = html;
  const applied = [];

  for (const matcher of matchers) {
    matcher.pattern.lastIndex = 0;
    const matches = updated.match(matcher.pattern);
    if (!matches) continue;
    updated = updated.replace(matcher.pattern, matcher.replace);
    applied.push(`${matches.length}x ${matcher.label}`);
  }

  if (!applied.length) {
    return { line: `NO MATCH ${repoPath}`, changed: false };
  }

  const summary = `${repoPath} [${applied.join("; ")}]`;
  if (!apply) {
    return { line: `DRY RUN ${summary}`, changed: true };
  }

  const saveStatus = await saveDoc(repoPath, updated);
  return { line: `${saveStatus} ${summary}`, changed: true };
}

(async function init() {
  if (!org || !repo || !token) {
    console.error("Missing ORG, REPO, or TOKEN in .env");
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configFile, "utf-8"));
  const entries = config.paths || [];
  const matchers = (config.replacements || []).map(buildMatcher);

  if (!entries.length) {
    console.error(`No paths configured in ${configFile}`);
    process.exit(1);
  }
  if (!matchers.length) {
    console.error(`No replacements configured in ${configFile}`);
    process.exit(1);
  }

  if (!apply) {
    console.log("DRY RUN - no documents will be changed. Pass --apply to write.");
  }
  for (const matcher of matchers) {
    console.log(`Replacement: ${matcher.label}`);
  }

  const docPaths = await resolveDocPaths(entries);
  console.log(`Found ${docPaths.length} document(s) to check`);

  const results = [];
  let changedCount = 0;

  for (let i = 0; i < docPaths.length; i += BATCH_SIZE) {
    const batch = docPaths.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((repoPath) => processDoc(repoPath, matchers)),
    );
    for (const { line, changed } of batchResults) {
      if (changed) changedCount++;
      console.log(line);
      results.push(line);
    }
  }

  const verb = apply ? "changed" : "would change";
  const summary = `${changedCount} of ${docPaths.length} document(s) ${verb}`;
  console.log(summary);
  results.push(summary);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputFile = path.join(__dirname, `output-${timestamp}.log`);
  fs.writeFileSync(outputFile, results.join("\n") + "\n");
  console.log(`Results saved to ${outputFile}`);
})();
