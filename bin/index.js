#!/usr/bin/env node
/**
 * CommitStory CLI — turn `git diff` into a Mermaid architecture map + release notes.
 *
 * Usage:
 *   commitstory --compare main..feature
 *   commitstory --compare HEAD~5..HEAD -o story.md
 *   commitstory --compare main...HEAD --api-key <key> --model gemini-3.5-flash
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

// gemini-1.5-flash was retired by Google (404 on v1beta). Primary is the
// current stable Flash model; fallback is tried once on 404/NOT_FOUND.
export const DEFAULT_MODEL = 'gemini-3.5-flash';
export const FALLBACK_MODEL = 'gemini-2.5-flash';
// Diff limits are configurable; 0 = unlimited. CLI defaults to unlimited
// (your machine, your key) — constrain with flags if you want. The safety
// ceiling just under the model's context window always applies.
export const DEFAULT_MAX_FILES = 0;
export const DEFAULT_MAX_LINES_PER_FILE = 0;
export const DEFAULT_MAX_CHARS = 0;
export const MODEL_CONTEXT_SAFETY_CHARS = 3000000;

/** Normalize a limit value: 0 or negative = unlimited. Falls back to def on garbage. */
export function normalizeLimit(value, def) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return n <= 0 ? 0 : Math.floor(n);
}

export function resolveLimits({ maxFiles, maxLinesPerFile, maxChars } = {}) {
  return {
    maxFiles: normalizeLimit(maxFiles, DEFAULT_MAX_FILES),
    maxLinesPerFile: normalizeLimit(maxLinesPerFile, DEFAULT_MAX_LINES_PER_FILE),
    maxChars: normalizeLimit(maxChars, DEFAULT_MAX_CHARS),
  };
}

export function describeLimits({ maxFiles, maxLinesPerFile, maxChars }) {
  const parts = [
    maxFiles > 0 ? `${maxFiles} files` : 'unlimited files',
    maxLinesPerFile > 0 ? `${maxLinesPerFile} lines/file` : 'unlimited lines/file',
    maxChars > 0 ? `${maxChars} chars total` : 'unlimited chars',
  ];
  return parts.join(' × ');
}
export const MAX_FILES = 30;
export const MAX_LINES_PER_FILE = 200;
export const MAX_TOTAL_CHARS = 15000;

export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: {
      type: 'STRING',
      description: '1-3 sentence technical summary of what changed and why.',
    },
    mermaidCode: {
      type: 'STRING',
      description:
        'A valid Mermaid flowchart (graph TD) showing components/modules touched and how they interact. No markdown fences.',
    },
    releaseNotes: {
      type: 'STRING',
      description:
        'Non-technical, stakeholder-friendly release notes in markdown bullet list. No jargon.',
    },
  },
  required: ['summary', 'mermaidCode', 'releaseNotes'],
  propertyOrdering: ['summary', 'mermaidCode', 'releaseNotes'],
};

export function resolveApiKey(cliKey) {
  const key =
    cliKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
  return key.trim();
}

function runGit(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = err?.stderr?.toString() ?? err?.message ?? String(err);
    throw new Error(`git ${args.join(' ')} failed:\n${stderr}`);
  }
}

export function ensureGitRepo() {
  try {
    runGit(['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new Error(
      'Not inside a Git repository. Run commitstory from your project root.'
    );
  }
}

/**
 * Truncate a unified diff per the given limits. Any limit set to 0 means
 * unlimited for that dimension. Returns { patch, truncated, fileCount }.
 */
export function truncatePatch(patch, limits = {}) {
  const { maxFiles, maxLinesPerFile, maxChars } = resolveLimits(limits);
  // Lookahead split retains the `diff --git …` header on every chunk,
  // so reassembly is lossless (byte-identical when unlimited).
  const chunks = patch.split(/^(?=diff --git )/m).filter(Boolean);
  const kept = [];
  let totalChars = 0;
  let truncated = false;

  const fileCount = chunks.length;
  for (let i = 0; i < chunks.length; i++) {
    if (maxFiles > 0 && i >= maxFiles) {
      truncated = true;
      break;
    }
    const lines = chunks[i].split('\n');
    let block =
      maxLinesPerFile > 0 ? lines.slice(0, maxLinesPerFile).join('\n') : lines.join('\n');
    if (maxLinesPerFile > 0 && lines.length > maxLinesPerFile) {
      block += `\n... [truncated: ${lines.length - maxLinesPerFile} more lines in this file]\n`;
      truncated = true;
    }
    if (maxChars > 0 && totalChars + block.length > maxChars) {
      const remaining = maxChars - totalChars;
      block = block.slice(0, Math.max(0, remaining));
      block += '\n... [truncated: total diff cap reached]';
      kept.push(block);
      truncated = true;
      break;
    }
    kept.push(block);
    totalChars += block.length;
  }

  if (maxFiles > 0 && fileCount > maxFiles) {
    kept.push(`... [truncated: ${fileCount - maxFiles} more files not shown]`);
  }
  // Chunks retain their own newlines (lookahead split), so join losslessly.
  return { patch: kept.join(''), truncated, fileCount };
}

/** Guard just under the model's context window — never send more than this. */
export function assertWithinContext(prompt) {
  if (prompt.length > MODEL_CONTEXT_SAFETY_CHARS) {
    throw new Error(
      `Diff is too large to analyze (${prompt.length} chars exceeds the ~${MODEL_CONTEXT_SAFETY_CHARS}-char safety ceiling under the model's context window). ` +
        'Narrow the range (e.g. fewer commits) or set --max-files / --max-lines-per-file / --max-chars.'
    );
  }
}

export function sanitizeMermaid(code) {
  return String(code ?? '')
    .replace(/```mermaid/gi, '')
    .replace(/```/g, '')
    .trim();
}

export function buildPrompt({ range, stat, patch, truncated }) {
  return `You are CommitStory, a principal software architect and technical writer.

Analyze this Git diff range "${range}" and return:
1. "summary": concise technical summary (1-3 sentences).
2. "mermaidCode": a VALID Mermaid flowchart starting with "graph TD". Nodes = components/modules/files touched. Edges = calls, data flow, or dependencies inferred from the diff. Keep node IDs alphanumeric (no spaces/quotes/parens). Keep under 25 nodes. Do NOT wrap in markdown fences.
3. "releaseNotes": friendly non-technical stakeholder release notes as a markdown bullet list (what changed for users, benefits). No jargon, no file paths unless user-facing.

--- GIT DIFF STAT ---
${stat || '(empty)'}

--- GIT PATCH (per-file truncated: ${truncated ? 'yes' : 'no'}) ---
${patch || '(empty)'}`;
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
 * Run fn up to maxAttempts times, waiting with exponential backoff + jitter
 * between attempts. Only isRetryableError failures are retried; anything
 * else throws immediately. onRetry is called before each wait.
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

async function generateOnce({ apiKey, model, prompt, log = console.error }) {
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
      onRetry: ({ attempt, maxAttempts, delay, err }) =>
        log(
          `Gemini overloaded (${String(err?.message ?? err).split('\n')[0].slice(0, 120)}). Retry ${attempt}/${maxAttempts} in ${delay}ms...`
        ),
    }
  );

  const text = (response?.text ?? '').trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  let parsed;
  try {
    const cleaned = text
      .replace(/^```json/gi, '')
      .replace(/^```/g, '')
      .replace(/```$/g, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Gemini returned invalid JSON:\n${text.slice(0, 2000)}`);
  }
  parsed.mermaidCode = sanitizeMermaid(parsed.mermaidCode);
  if (!parsed.summary || !parsed.mermaidCode || !parsed.releaseNotes) {
    throw new Error(
      'Gemini response missing required fields (summary, mermaidCode, releaseNotes).'
    );
  }
  parsed.model = model;
  return parsed;
}

export async function analyzeWithGemini({ apiKey, model, prompt }) {
  const candidates = [...new Set([model || DEFAULT_MODEL, FALLBACK_MODEL])];
  let lastErr;
  for (const candidate of candidates) {
    try {
      return await generateOnce({ apiKey, model: candidate, prompt });
    } catch (err) {
      lastErr = err;
      const isLast = candidate === candidates[candidates.length - 1];
      if (isLast) {
        if (isRetryableError(err)) {
          throw new Error(
            `Gemini is overloaded right now (${String(err?.message ?? err).split('\n')[0].slice(0, 160)}). Spikes are usually temporary — please try again in a minute.`
          );
        }
        throw err;
      }
      if (isModelNotFoundError(err)) {
        console.error(
          `Model "${candidate}" unavailable (${String(err?.message ?? err).split('\n')[0]}). Retrying with "${candidates[candidates.indexOf(candidate) + 1]}"...`
        );
      } else if (isRetryableError(err)) {
        console.error(
          `Model "${candidate}" still overloaded after retries. Failing over to "${candidates[candidates.indexOf(candidate) + 1]}"...`
        );
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

export function toMarkdown({ range, result }) {
  return `# CommitStory: \`${range}\`

_Model: ${result.model || DEFAULT_MODEL}_

## Summary
${result.summary}

## Architecture Map
\`\`\`mermaid
${result.mermaidCode}
\`\`\`

## Release Notes
${result.releaseNotes}
`;
}

const program = new Command();
program
  .name('commitstory')
  .description(
    'Transform Git diffs into Mermaid architecture maps + stakeholder release notes (Gemini Flash)'
  )
  .version('1.0.0', '-v, --version')
  .requiredOption('--compare <range>', 'Git compare range, e.g. main..feature or HEAD~3..HEAD')
  .option('-o, --output <file>', 'Save markdown report to file')
  .option('--api-key <key>', 'Gemini API key (overrides GEMINI_API_KEY / GOOGLE_API_KEY env)')
  .option('--model <model>', 'Gemini model', DEFAULT_MODEL)
  .option('--max-files <n>', 'Max files to analyze (0 = unlimited)', String(DEFAULT_MAX_FILES))
  .option('--max-lines-per-file <n>', 'Max diff lines per file (0 = unlimited)', String(DEFAULT_MAX_LINES_PER_FILE))
  .option('--max-chars <n>', 'Max total diff chars (0 = unlimited)', String(DEFAULT_MAX_CHARS))
  .action(async (opts) => {
    try {
      const apiKey = resolveApiKey(opts.apiKey);
      if (!apiKey) {
        console.error(
          'Error: missing Gemini API key.\nSet GEMINI_API_KEY (or GOOGLE_API_KEY) in .env, or pass --api-key <key>.\nGet one at https://aistudio.google.com/app/apikey'
        );
        process.exitCode = 1;
        return;
      }
      ensureGitRepo();
      const range = opts.compare;

      let stat = '';
      let rawPatch = '';
      try {
        stat = runGit(['diff', '--stat', range]).trim();
        rawPatch = runGit(['diff', '--no-color', range]);
      } catch (e) {
        console.error(`Error: ${e.message}`);
        console.error('Hint: valid ranges look like "main..feature", "HEAD~3..HEAD", "abc123..def456".');
        process.exitCode = 1;
        return;
      }

      if (!rawPatch.trim()) {
        console.error(`No differences found for range "${range}". Nothing to analyze.`);
        process.exitCode = 1;
        return;
      }

      const limits = resolveLimits({
        maxFiles: opts.maxFiles,
        maxLinesPerFile: opts.maxLinesPerFile,
        maxChars: opts.maxChars,
      });
      const { patch, truncated, fileCount } = truncatePatch(rawPatch, limits);
      if (truncated) {
        console.error(
          `Note: diff truncated for AI analysis (files: ${fileCount}, cap ${describeLimits(limits)}).`
        );
      }

      console.error(`Analyzing ${range} with ${opts.model} ...`);
      const prompt = buildPrompt({ range, stat, patch, truncated });
      assertWithinContext(prompt);
      const result = await analyzeWithGemini({
        apiKey,
        model: opts.model,
        prompt,
      });

      const markdown = toMarkdown({ range, result });
      process.stdout.write(markdown + '\n');

      if (opts.output) {
        writeFileSync(opts.output, markdown, 'utf8');
        console.error(`\nSaved report to ${opts.output}`);
      }
    } catch (err) {
      console.error(`Error: ${err?.message ?? err}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv);
