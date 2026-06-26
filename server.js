require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static('.'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const CACHE_FILE = './job-cache.json';

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch(e) {}
  return { seen: [], dismissed: [] };
}

function saveCache(cache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); } catch(e) {}
}

// ── Parse.bot search — finds jobs and returns URLs ──
async function searchSeek(keyword) {
  try {
    const url = new URL('https://api.parse.bot/scraper/6f3f8e62-caf1-482e-ab3f-9f93af22e4c6/search_jobs');
    url.searchParams.set('keyword', keyword);
    url.searchParams.set('location', 'Wellington');
    url.searchParams.set('salary_type', 'annual');

    const response = await fetch(url.toString(), {
      headers: {
        'X-API-Key': process.env.PARSE_API_KEY,
        'API-Snapshot-Version': '5'
      }
    });

    if (!response.ok) {
      console.error(`Parse.bot error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    const jobs = data.data?.jobs || data.jobs || [];
    console.log(`"${keyword}" → ${jobs.length} results`);
    return Array.isArray(jobs) ? jobs : [];
  } catch(err) {
    console.error('Search error:', err.message);
    return [];
  }
}

// ── Fetch full job page directly from Seek URL ──
async function fetchJobPage(jobUrl) {
  try {
    const response = await fetch(jobUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-NZ,en;q=0.5',
      }
    });
    if (!response.ok) return null;
    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[^\x20-\x7E]/g, '')
      .trim()
      .slice(0, 3500);
    return text.length > 200 ? text : null;
  } catch(err) {
    console.error('Page fetch error:', err.message);
    return null;
  }
}

// ── Tight title filter ──
const TITLE_MUST_CONTAIN = [
  ' ai ',
  'ai ',
  ' ai',
  'artificial intelligence',
  'generative',
  'digital transformation',
  'data and ai',
  'data & ai',
  'copilot',
  'llm',
  'ai governance',
  'ai enablement',
  'ai capability',
  'ai specialist',
  'ai consultant',
  'ai advisor',
  'ai lead',
  'ai product',
  'ai programme',
  'ai program',
];

function titleIsRelevant(title) {
  const t = ' ' + title.toLowerCase() + ' ';
  return TITLE_MUST_CONTAIN.some(kw => t.includes(kw));
}

const SEARCH_KEYWORDS = [
  'artificial intelligence',
  'AI specialist',
  'AI consultant',
  'AI advisor'
];

// ── Routes ──
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/gmail.readonly'] });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    res.redirect('/?authed=true');
  } catch (err) {
    res.redirect('/?error=auth');
  }
});

app.post('/mark-seen', (req, res) => {
  const { jobKeys } = req.body;
  const cache = loadCache();
  jobKeys.forEach(k => { if (!cache.seen.includes(k)) cache.seen.push(k); });
  saveCache(cache);
  res.json({ ok: true });
});

app.post('/dismiss', (req, res) => {
  const { jobKey } = req.body;
  const cache = loadCache();
  if (!cache.dismissed.includes(jobKey)) cache.dismissed.push(jobKey);
  if (!cache.seen.includes(jobKey)) cache.seen.push(jobKey);
  saveCache(cache);
  res.json({ ok: true });
});

app.post('/clear-dismissed', (req, res) => {
  const cache = loadCache();
  cache.dismissed = [];
  cache.seen = [];
  saveCache(cache);
  res.json({ ok: true });
});

app.get('/fetch-seek', async (req, res) => {
  try {
    const cache = loadCache();
    const seen = new Set(cache.seen);
    const dismissed = new Set(cache.dismissed);
    const deduped = new Set();
    const candidates = [];

    // Step 1: Parse.bot finds jobs and URLs
    for (const keyword of SEARCH_KEYWORDS) {
      console.log(`\nSearching: "${keyword}"`);
      const results = await searchSeek(keyword);

      for (const job of results) {
        if (!job.title) continue;
        const key = (job.title + '||' + (job.company || '')).toLowerCase().trim();
        if (deduped.has(key) || dismissed.has(key)) continue;
        deduped.add(key);

        if (!titleIsRelevant(job.title)) {
          console.log(`  Skip: ${job.title}`);
          continue;
        }

        const jobUrl = job.job_url || (job.id ? `https://nz.seek.com/job/${job.id}` : null);
        if (!jobUrl) continue;

        console.log(`  ✓ ${job.title} at ${job.company}`);
        candidates.push({
          title: job.title,
          org: job.company,
          salary: job.salary,
          url: jobUrl,
          key
        });
      }
    }

    console.log(`\n${candidates.length} candidates after title filter`);

    // Step 2: Fetch full page and score with Sonnet
    const jobs = [];
    for (const candidate of candidates) {
      try {
        console.log(`  Fetching: ${candidate.title}`);
        const pageContent = await fetchJobPage(candidate.url);

        let jobContent = `Title: ${candidate.title}\nOrganisation: ${candidate.org}\nSalary: ${candidate.salary || 'Not stated'}`;
        if (pageContent) {
          jobContent += `\n\nFull job description:\n${pageContent}`;
        }

        const scoreRes = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 500,
          messages: [{
            role: 'user',
            content: `You are a job screening agent for Mafeking Ihimaera. Score this job and return a single JSON object only. No markdown, no backticks.

ABOUT MAFEKING: Senior Advisor at Te Puni Kokiri, Wellington. 13 years NZ public sector experience in data, advisory, and AI delivery — NOT deep technical engineering or managed services delivery. Maori. Built the organisation's first knowledge-grounded AI agent in Copilot Studio. Built end-to-end Power Apps and Power BI solutions. Holds IAPP AI Governance Professional certification. Immediately available.

TARGET ROLES: AI Consultant, AI Advisor, AI Specialist, AI Enablement Lead, Digital Transformation Consultant, Data and AI Product Lead, Senior Advisor with explicit AI focus.

SALARY: Hard floor $120k. Target $120k-$180k. Exception: AI-titled roles at government or Big 4 may consider from $100k if strong career trajectory.

TIER 1: NZ government agencies with AI programmes.
TIER 2: Deloitte, PwC, EY, KPMG, Capgemini, Acumen BI, Allen and Clarke, Solnet, Assurity, VedArc.
TIER 3: Maori orgs only if primary AI role.

AUTO-SKIP triggers — score 3 or below if ANY of these apply:
- Requires 8+ years in a single technical domain (managed services, architecture, engineering)
- Pure engineering, infrastructure, or software development role
- Requires Snowflake, Databricks, Terraform, or deep cloud engineering
- Outside Wellington/Auckland unless explicitly remote
- No genuine AI scope
- Director/Partner level requiring P&L or business development responsibility
- Data analyst roles below $120k

RELATIONSHIP PLAY: Score 6-7 at Tier 1 or Tier 2 = flag as relationship play.

BE CONSERVATIVE: If the role requires experience or seniority clearly beyond Mafeking's profile, score it low. Do not inflate scores because the title sounds good.

Return ONLY this JSON:
{"title":"","org":"","salary":"Not stated","score":0,"recommendation":"SKIP","summary":"Two sentences max.","risks":[],"relationshipPlay":false,"relationshipPlayNote":"","url":""}

Recommendation must be one of: APPLY NOW, WORTH READING, SKIP, RELATIONSHIP PLAY

${jobContent}`
          }]
        });

        const raw = scoreRes.content[0].text.trim();
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const scored = JSON.parse(match[0]);
          if (scored.score >= 5) {
            scored.url = candidate.url;
            scored.key = candidate.key;
            scored.isNew = !seen.has(candidate.key);
            jobs.push(scored);
            console.log(`  → ${scored.score}/10 ${scored.recommendation} — ${candidate.title}`);
          } else {
            console.log(`  → ${scored.score}/10 filtered out — ${candidate.title}`);
          }
        }
      } catch(e) {
        console.error('Score error:', candidate.title, e.message);
      }
    }

    jobs.sort((a, b) => {
      if (a.isNew && !b.isNew) return -1;
      if (!a.isNew && b.isNew) return 1;
      return b.score - a.score;
    });

    console.log(`\nDone. ${jobs.length} jobs scoring 5+`);
    res.json({ jobs, count: jobs.length });

  } catch (err) {
    console.error('Fatal error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(process.env.PORT, () => {
  console.log(`Job Search Agent running at http://localhost:${process.env.PORT}`);
});
