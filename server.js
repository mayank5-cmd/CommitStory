/**
 * CommitStory web backend — POST /api/analyze
 * Parses a GitHub repo or PR URL, fetches the diff via Octokit,
 * calls Gemini Flash with strict JSON schema, returns JSON.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Octokit } from '@octokit/rest';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
// gemini-1.5-flash was retired by Google (404 on v1beta). Primary is the
// current stable Flash model; fallback is tried once on 404/NOT_FOUND.
const DEFAULT_MODEL = 'gemini-3.5-flash';
const FALLBACK_MODEL = 'gemini-2.5-flash';
// Diff limits: configurable via env, 0 = unlimited. The server keeps a high
// but bounded default since POST /api/analyze is public (abuse/bill guard).
// The safety ceiling just under the model's context window always applies.
const DEFAULT_MAX_FILES = 1000;
const DEFAULT_MAX_LINES_PER_FILE = 2000;
const DEFAULT_MAX_CHARS = 500000;
const MODEL_CONTEXT_SAFETY_CHARS = 3000000;

export function normalizeLimit(value, def) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return n <= 0 ? 0 : Math.floor(n);
}

export function resolveLimits() {
  return {
    maxFiles: normalizeLimit(process.env.MAX_DIFF_FILES, DEFAULT_MAX_FILES),
    maxLinesPerFile: normalizeLimit(
      process.env.MAX_DIFF_LINES_PER_FILE,
      DEFAULT_MAX_LINES_PER_FILE
    ),
    maxChars: normalizeLimit(process.env.MAX_DIFF_CHARS, DEFAULT_MAX_CHARS),
  };
}

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    mermaidCode: { type: 'STRING' },
    releaseNotes: { type: 'STRING' },
  },
  required: ['summary', 'mermaidCode', 'releaseNotes'],
  propertyOrdering: ['summary', 'mermaidCode', 'releaseNotes'],
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: 0,
    // Never let browsers cache the dashboard HTML — model names and UI
    // copy change over time and must show up on next load, not next restart.
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  })
);

function resolveApiKey() {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
}

function getOctokit() {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  return new Octokit(token ? { auth: token } : {});
}

/**
 * Accepts:
 *  - https://github.com/owner/repo
 *  - https://github.com/owner/repo/
 *  - https://github.com/owner/repo/pull/123
 *  - https://github.com/owner/repo/pulls/123 (tolerated)
 *  - with optional .git suffix / trailing slash / query strings
 */
export function parseGitHubUrl(input) {
  const url = String(input || '').trim();
  const m = url.match(
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/|$)(?:(?:pull|pulls)\/(\d+))?.*$/i
  );
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2].replace(/\.git$/, ''),
    prNumber: m[3] ? Number(m[3]) : null,
  };
}

export function sanitizeMermaid(code) {
  return String(code ?? '')
    .replace(/```mermaid/gi, '')
    .replace(/```/g, '')
    .trim();
}

/** Truncate a file list per limits. Any limit of 0 = unlimited for that dimension. */
export function truncateFiles(files, limits = resolveLimits()) {
  const { maxFiles, maxLinesPerFile, maxChars } = limits;
  const kept = [];
  let totalChars = 0;
  let truncated = false;
  for (let i = 0; i < files.length; i++) {
    if (maxFiles > 0 && i >= maxFiles) {
      truncated = true;
      break;
    }
    const f = files[i];
    const raw = String(f.patch || '');
    const lines = raw.split('\n');
    let patch =
      maxLinesPerFile > 0 ? lines.slice(0, maxLinesPerFile).join('\n') : raw;
    if (maxLinesPerFile > 0 && lines.length > maxLinesPerFile) {
      patch += `\n... [truncated: ${lines.length - maxLinesPerFile} more lines in ${f.filename}]`;
      truncated = true;
    }
    const header = `\n\n--- FILE: ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---\n`;
    if (maxChars > 0 && totalChars + header.length + patch.length > maxChars) {
      const remaining = maxChars - totalChars - header.length;
      patch = patch.slice(0, Math.max(0, remaining)) + '\n... [truncated: total diff cap reached]';
      kept.push({ filename: f.filename, patch: header + patch });
      truncated = true;
      break;
    }
    kept.push({ filename: f.filename, patch: header + patch });
    totalChars += header.length + patch.length;
  }
  if (maxFiles > 0 && files.length > maxFiles) {
    truncated = true;
  }
  return { kept, truncated };
}

export function buildPrompt({ context, diffText, truncated }) {
  return `You are CommitStory, a principal software architect and technical writer.

Analyze this GitHub change (${context}) and return:
1. "summary": concise technical summary (1-3 sentences).
2. "mermaidCode": a VALID Mermaid flowchart starting with "graph TD". Nodes = components/modules/files touched. Edges = calls, data flow, or dependencies inferred from the diff. Node IDs alphanumeric only. Under 25 nodes. No markdown fences.
3. "releaseNotes": friendly non-technical stakeholder release notes as a markdown bullet list. No jargon.

--- CONTEXT ---
${context}

--- DIFF (per-file truncated: ${truncated ? 'yes' : 'no'}) ---
${diffText || '(empty)'}`;
}

export function isModelNotFoundError(err) {
  const msg = `${err?.message ?? err}`;
  return /NOT_FOUND|not found|not supported|404/i.test(msg);
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Transient overload/rate-limit/network errors worth retrying with backoff. */
export function isRetryableError(err) {
  if (typeof err?.status === 'number' && RETRYABLE_STATUS.has(err.status)) return true;
  const msg = `${err?.message ?? err}`;
  return /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|try again later|timed? ?out|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|429|500|502|503|504/i.test(
    msg
  );
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run fn up to maxAttempts times with exponential backoff + jitter.
 * Only isRetryableError failures are retried; anything else throws immediately.
 */
export async function withTransientRetries(
  fn,
  { maxAttempts = 3, baseDelayMs = 1500, onRetry } = {}
) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLast = attempt === maxAttempts;
      if (!isRetryableError(err) || isLast) throw err;
      const delay =
        baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      onRetry?.({ attempt, maxAttempts, delay, err });
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function generateOnce({ apiKey, model, prompt }) {
  const ai = new GoogleGenAI({ apiKey });
  const response = await withTransientRetries(
    () =>
      ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    {
      onRetry: ({ attempt, maxAttempts, delay }) =>
        // eslint-disable-next-line no-console
        console.error(
          `Gemini overloaded on "${model}". Retry ${attempt}/${maxAttempts} in ${delay}ms...`
        ),
    }
  );
  const text = (response?.text ?? '').trim();
  if (!text) throw Object.assign(new Error('Gemini returned an empty response.'), { status: 502 });
  let parsed;
  try {
    parsed = JSON.parse(
      text.replace(/^```json/gi, '').replace(/^```/g, '').replace(/```$/g, '').trim()
    );
  } catch {
    throw Object.assign(new Error('Gemini returned invalid JSON.'), { status: 502 });
  }
  parsed.mermaidCode = sanitizeMermaid(parsed.mermaidCode);
  if (!parsed.summary || !parsed.mermaidCode || !parsed.releaseNotes) {
    throw Object.assign(new Error('Gemini response missing required fields.'), { status: 502 });
  }
  parsed.model = model;
  return parsed;
}

async function analyzeWithGemini({ prompt, model = DEFAULT_MODEL }) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw Object.assign(
      new Error(
        'Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY on the server.'
      ),
      { status: 500 }
    );
  }
  const candidates = [...new Set([model, FALLBACK_MODEL])];
  let lastErr;
  for (const candidate of candidates) {
    try {
      return await generateOnce({ apiKey, model: candidate, prompt });
    } catch (err) {
      lastErr = err;
      const isLast = candidate === candidates[candidates.length - 1];
      if (err?.status && ![404, 429, 500, 502, 503].includes(err.status) && !isModelNotFoundError(err) && !isRetryableError(err)) throw err;
      if (isLast) {
        if (isRetryableError(err) && !err?.status) {
          throw Object.assign(
            new Error(
              'Gemini is overloaded right now. Spikes are usually temporary — please try again in a minute.'
            ),
            { status: 503 }
          );
        }
        throw err;
      }
      if (isModelNotFoundError(err)) {
        // eslint-disable-next-line no-console
        console.error(
          `Model "${candidate}" unavailable, retrying with fallback "${candidates[candidates.indexOf(candidate) + 1]}".`
        );
      } else if (isRetryableError(err)) {
        // eslint-disable-next-line no-console
        console.error(
          `Model "${candidate}" still overloaded after retries. Failing over to "${candidates[candidates.indexOf(candidate) + 1]}".`
        );
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

async function fetchPrDiff(octokit, owner, repo, prNumber) {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const stat = files.map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
  const context = `PR #${prNumber} "${pr.title}" in ${owner}/${repo} (${pr.base.ref}...${pr.head.ref}, ${files.length} files, +${pr.additions}/-${pr.deletions})`;
  return { stat, files, context };
}

async function fetchRepoDiff(octokit, owner, repo) {
  // Bare repo URL: analyze the latest commit on the default branch (parent...head).
  const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoInfo.default_branch;
  const { data: branch } = await octokit.rest.repos.getBranch({ owner, repo, branch: defaultBranch });
  const headSha = branch.commit.sha;
  const { data: headCommit } = await octokit.rest.repos.getCommit({ owner, repo, ref: headSha });
  const parentSha = headCommit.parents?.[0]?.sha;
  if (!parentSha) {
    // Single-commit repo: diff against empty tree via the commit itself.
    const files = (headCommit.files || []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch || '',
    }));
    return {
      stat: files.map((f) => `${f.status} ${f.filename}`).join('\n'),
      files,
      context: `Latest commit ${headSha.slice(0, 7)} "${headCommit.commit.message.split('\n')[0]}" on ${owner}/${repo}@${defaultBranch} (initial commit analysis)`,
    };
  }
  const { data: cmp } = await octokit.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${parentSha}...${headSha}`,
  });
  const files = (cmp.files || []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch || '',
  }));
  const stat = files.map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions})`).join('\n');
  return {
    stat,
    files,
    context: `Latest commit ${headSha.slice(0, 7)} "${headCommit.commit.message.split('\n')[0]}" on ${owner}/${repo}@${defaultBranch} (${parentSha.slice(0, 7)}...${headSha.slice(0, 7)})`,
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: DEFAULT_MODEL, fallbackModel: FALLBACK_MODEL, limits: resolveLimits(), hasGeminiKey: Boolean(resolveApiKey()) });
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { url, model } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Provide a JSON body { "url": "https://github.com/owner/repo/pull/123" }.' });
    }
    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      return res.status(400).json({
        error: 'Invalid GitHub URL. Use https://github.com/<owner>/<repo> or https://github.com/<owner>/<repo>/pull/<number>.',
      });
    }
    const octokit = getOctokit();
    let stat = '';
    let files = [];
    let context = '';
    try {
      if (parsed.prNumber) {
        ({ stat, files, context } = await fetchPrDiff(octokit, parsed.owner, parsed.repo, parsed.prNumber));
      } else {
        ({ stat, files, context } = await fetchRepoDiff(octokit, parsed.owner, parsed.repo));
      }
    } catch (e) {
      const status = e?.status ?? 500;
      if (status === 404) return res.status(404).json({ error: 'Repository or PR not found. Check the URL (private repos need GITHUB_TOKEN).' });
      if (status === 403) return res.status(403).json({ error: 'GitHub rate limit exceeded. Set GITHUB_TOKEN on the server and retry.' });
      throw e;
    }

    if (!files.length) {
      return res.status(422).json({ error: 'No file changes found to analyze.', context });
    }

    const limits = resolveLimits();
    const { kept, truncated } = truncateFiles(files, limits);
    const diffText = `STAT:\n${stat}\n` + kept.map((k) => k.patch).join('\n');
    const prompt = buildPrompt({ context, diffText, truncated });
    if (prompt.length > MODEL_CONTEXT_SAFETY_CHARS) {
      return res.status(413).json({
        error: `Diff is too large to analyze (${prompt.length} chars exceeds the ~${MODEL_CONTEXT_SAFETY_CHARS}-char safety ceiling). Lower MAX_DIFF_* limits or analyze a smaller change.`,
        context,
      });
    }
    const result = await analyzeWithGemini({ prompt, model: model || DEFAULT_MODEL });

    const filesChanged = files.length;
    const additions = files.reduce((s, f) => s + (f.additions || 0), 0);
    const deletions = files.reduce((s, f) => s + (f.deletions || 0), 0);

    return res.json({
      owner: parsed.owner,
      repo: parsed.repo,
      prNumber: parsed.prNumber,
      context,
      truncated,
      limits,
      filesChanged,
      additions,
      deletions,
      ...result,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('POST /api/analyze failed:', err?.message ?? err);
    const status = err?.status || 500;
    return res.status(status).json({ error: err?.message || 'Internal server error.' });
  }
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`CommitStory dashboard at http://localhost:${PORT}`);
  });
}

export default app;
