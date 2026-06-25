require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('.'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.REDIRECT_URI
);

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

const SCREENING_PROMPT = `You are a job screening agent for Mafeking Ihimaera. Score job listings and return structured JSON only.

He is a Senior Advisor at Te Puni Kokiri, Wellington. 13 years NZ public sector experience in data, advisory, and AI delivery. Maori. Built the organisation's first knowledge-grounded AI agent in Copilot Studio. Built end-to-end Power Apps and Power BI solutions. Holds IAPP AI Governance Professional certification. Immediately available.

TARGET ROLES: AI Consultant, AI Advisor, AI Specialist, AI Enablement Lead, Technology Consultant, Digital Transformation Consultant, Data and AI Product Lead, Senior Advisor with explicit AI focus.

SALARY: Hard floor $120k. Target $120k-$180k. Exception: AI-titled roles at government or Big 4 may consider from $100k if career trajectory is strong.

TIER 1 (priority): NZ government agencies with AI programmes.
TIER 2: Deloitte, PwC, EY, KPMG, Capgemini, Acumen BI, Allen and Clarke, Solnet, Assurity.
TIER 3: Maori orgs only if primary AI role.

AUTO-SKIP: Pure engineering, data analyst below $120k, Snowflake/Databricks/Terraform required, outside Wellington/Auckland unless remote, no AI scope.

RELATIONSHIP PLAY: Score 6-7 at Tier 1 or Tier 2 org = flag as relationship play.

Return ONLY a single valid JSON object. No markdown. No backticks. No explanation. No special characters outside the JSON values. Use only plain ASCII in your response.

{
  "title": "job title",
  "org": "organisation",
  "salary": "salary or Not stated",
  "score": 7,
  "recommendation": "APPLY NOW",
  "summary": "Two sentences max.",
  "risks": ["risk 1", "risk 2"],
  "relationshipPlay": false,
  "relationshipPlayNote": ""
}

Recommendation must be one of: APPLY NOW, WORTH READING, SKIP, RELATIONSHIP PLAY`;

app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    res.redirect('/?authed=true');
  } catch (err) {
    console.error('Auth error:', err);
    res.redirect('/?error=auth');
  }
});

app.get('/fetch-jobs', async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'from:(jobalerts-noreply@linkedin.com) newer_than:7d',
      maxResults: 20
    });

    const messages = response.data.messages || [];
    console.log(`Found ${messages.length} emails`);
    const jobs = [];

    for (const msg of messages.slice(0, 10)) {
      try {
        const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id });
        const payload = detail.data.payload;
        const subject = payload.headers.find(h => h.name === 'Subject')?.value || '';
        let body = '';

        if (payload.parts) {
          const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          }
        } else if (payload.body?.data) {
          body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
        }

        const cleanSubject = subject.replace(/[^\x20-\x7E]/g, '');
        const cleanBody = body.replace(/[^\x20-\x7E\n]/g, '').slice(0, 1500);
        const content = `Subject: ${cleanSubject}\n\n${cleanBody}`;

        console.log(`Processing: ${cleanSubject}`);

        const aiResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 600,
          system: SCREENING_PROMPT,
          messages: [{ role: 'user', content: `Screen this job alert email and return JSON only:\n\n${content}` }]
        });

        const rawText = aiResponse.content[0].text.trim();
        console.log('Claude response:', rawText.slice(0, 100));

        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const scored = JSON.parse(jsonMatch[0]);
          if (scored.title && scored.title !== 'N/A' && scored.score > 0) {
            jobs.push({ ...scored, emailSubject: cleanSubject });
          }
        }
      } catch (msgErr) {
        console.error('Error processing message:', msgErr.message);
      }
    }

    jobs.sort((a, b) => b.score - a.score);
    res.json({ jobs });

  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(process.env.PORT, () => {
  console.log(`Job Search Agent running at http://localhost:${process.env.PORT}`);
});