require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();

// ══════════════════════════════════════════════════
// CONCURRENCY CONFIG
// Adjust these to match your free API tier:
//   Gemini Flash free → 60 RPM  → CONCURRENCY = 10, INTERVAL = 1100ms
//   Groq free         → 30 RPM  → CONCURRENCY = 5,  INTERVAL = 2100ms
// ══════════════════════════════════════════════════
const QUEUE_CONCURRENCY = 10;   // max simultaneous AI calls
const QUEUE_INTERVAL_MS = 1100; // min ms between batches

// ── Simple In-Memory Cache ────────────────────────
// Identical request payloads return cached results instantly.
// Cache expires after 10 minutes (good for a class session).
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCacheKey(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}
function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}
function setCache(key, value) {
  // Cap cache size at 200 entries to avoid memory bloat
  if (cache.size >= 200) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { value, timestamp: Date.now() });
}

// ── Request Queue ─────────────────────────────────
// Prevents 40 simultaneous calls from hitting the AI API
// at once and triggering rate limit errors.
class RequestQueue {
  constructor(concurrency, intervalMs) {
    this.concurrency = concurrency;
    this.intervalMs = intervalMs;
    this.running = 0;
    this.queue = [];
    this.lastCallTime = 0;
  }

  async add(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._process();
    });
  }

  async _process() {
    if (this.running >= this.concurrency || this.queue.length === 0) return;

    // Enforce minimum interval between calls
    const now = Date.now();
    const wait = Math.max(0, this.intervalMs - (now - this.lastCallTime));

    if (wait > 0) {
      setTimeout(() => this._process(), wait);
      return;
    }

    const { fn, resolve, reject } = this.queue.shift();
    this.running++;
    this.lastCallTime = Date.now();

    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this.running--;
      this._process(); // pick up next queued item
    }
  }

  get queueLength() { return this.queue.length; }
  get activeCount() { return this.running; }
}

const aiQueue = new RequestQueue(QUEUE_CONCURRENCY, QUEUE_INTERVAL_MS);

// ── Retry with Exponential Backoff ────────────────
// Retries up to MAX_RETRIES times on rate limit (429) errors.
const MAX_RETRIES = 3;

async function withRetry(fn, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err?.response?.status === 429 || err?.message?.includes('429');
      const isLast = attempt === retries;

      if (is429 && !isLast) {
        const backoffMs = attempt * 2000; // 2s, 4s, 6s
        console.warn(`Rate limit hit. Retry ${attempt}/${retries} in ${backoffMs}ms...`);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        throw err;
      }
    }
  }
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── Queue status endpoint (useful to show in demo) ──
app.get('/api/status', (req, res) => {
  res.json({
    queueLength: aiQueue.queueLength,
    activeRequests: aiQueue.activeCount,
    cacheSize: cache.size
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════
// CONDITION-BASED DIETARY RULES
// ══════════════════════════════════════════════════
const CONDITION_RULES = {
  diabetes: {
    label: 'Diabetes (Type 2)',
    emoji: '🩸',
    prioritize: [
      'bitter gourd (karela)', 'fenugreek seeds (methi)', 'oats', 'barley',
      'whole wheat roti', 'moong dal', 'sprouted legumes', 'spinach',
      'amla', 'cinnamon (dalchini)', 'cucumber', 'bottle gourd (lauki)'
    ],
    avoid: [
      'white rice (large portions)', 'maida / refined flour', 'sugar',
      'fruit juices', 'potato chips', 'white bread', 'sweet drinks',
      'packaged biscuits', 'mithai / sweets'
    ],
    notes: 'Low glycemic index foods only. Small, frequent meals (every 3-4 hrs). ' +
           'Avoid refined carbs and anything that causes blood sugar spikes. ' +
           'Prioritize fiber-rich complex carbohydrates.'
  },
  hypertension: {
    label: 'Hypertension (High BP)',
    emoji: '❤️',
    prioritize: [
      'banana', 'spinach', 'sweet potato', 'moong dal', 'oats',
      'garlic (raw)', 'amla', 'coconut water', 'flaxseeds (alsi)',
      'tomato', 'beets', 'dark leafy greens'
    ],
    avoid: [
      'pickles (achar)', 'papads', 'namkeen / salty snacks', 'processed foods',
      'excess table salt (keep under 1 tsp/day)', 'canned foods',
      'ready-to-eat meals', 'fried foods'
    ],
    notes: 'DASH diet principles: low sodium, rich in potassium and magnesium. ' +
           'Use herbs (jeera, coriander, turmeric) for flavor instead of salt. ' +
           'Limit sodium to under 1500mg/day.'
  },
  anemia: {
    label: 'Anemia / Iron Deficiency',
    emoji: '🫀',
    prioritize: [
      'spinach (palak)', 'rajma (kidney beans)', 'chana (chickpeas)',
      'dates (khajoor)', 'jaggery (gud)', 'ragi (finger millet)',
      'sesame seeds (til)', 'amla (Vitamin C enhances iron)', 'pomegranate',
      'beetroot', 'pumpkin seeds', 'horse gram (kulthi dal)'
    ],
    avoid: [
      'tea or coffee within 1 hour of meals (tannins block iron)',
      'excessive calcium-rich foods at iron-rich meals',
      'phytate-heavy foods without soaking (raw legumes)'
    ],
    notes: 'Always pair iron-rich foods with Vitamin C (amla, lemon) for 3x better absorption. ' +
           'Have lemon juice on spinach or dal. Avoid tea/coffee within 1 hr of meals. ' +
           'Soak legumes before cooking to reduce phytates.'
  },
  pcos: {
    label: 'PCOS / Hormonal Balance',
    emoji: '🌸',
    prioritize: [
      'ragi (finger millet)', 'whole wheat roti', 'brown rice',
      'eggs', 'paneer', 'chickpeas (chana)', 'flaxseeds (alsi — grind before eating)',
      'walnuts (akhrot)', 'leafy greens', 'berries',
      'cinnamon (helps insulin sensitivity)', 'methi seeds'
    ],
    avoid: [
      'white sugar', 'maida / refined flour', 'deep fried foods',
      'packaged and processed snacks', 'excessive dairy (can raise androgens)',
      'high-GI foods', 'alcohol', 'trans fats'
    ],
    notes: 'Low GI, anti-inflammatory, high-protein diet. ' +
           'Omega-3 rich foods (flaxseeds, walnuts) support hormonal balance. ' +
           'Eat every 3-4 hrs to stabilize blood sugar and insulin. ' +
           '1 tbsp ground flaxseeds daily helps balance estrogen levels.'
  },
  general: {
    label: 'General Fitness',
    emoji: '💪',
    prioritize: [
      'seasonal vegetables', 'whole grains', 'all types of dal',
      'curd (probiotic)', 'fresh seasonal fruits', 'nuts and seeds',
      'paneer or eggs (protein)', 'sprouts'
    ],
    avoid: [
      'ultra-processed foods', 'excess cooking oil', 'excessive sugar',
      'skipping meals', 'large gaps between meals'
    ],
    notes: 'Focus on variety, seasonal produce, and whole Indian foods. ' +
           'Eat the rainbow — different colored vegetables = different micronutrients. ' +
           'Maintain consistent meal times for metabolic health.'
  }
};

// ── Edamam nutrition lookup ────────────────────────
async function getNutrition(food) {
  try {
    const res = await axios.get('https://api.edamam.com/api/nutrition-data', {
      params: {
        app_id: process.env.EDAMAM_APP_ID,
        app_key: process.env.EDAMAM_APP_KEY,
        ingr: food
      }
    });
    return res.data;
  } catch (error) {
    console.error(`Edamam API Error for "${food}":`, error.message);
    return null;
  }
}

// ══════════════════════════════════════════════════
// AI CALLER — Gemini Flash (primary) + Groq (fallback)
//
// WHY GEMINI FLASH FOR YOUR DEMO:
//   ✅ 60 req/min free  (vs Groq's 30 req/min)
//   ✅ 1M tokens/day free
//   ✅ Fast response times
//   ✅ Free API key at aistudio.google.com
//
// HOW TO SET UP:
//   1. Go to https://aistudio.google.com/app/apikey
//   2. Create a free key, paste in .env as GEMINI_API_KEY
//   3. Keep GROQ_API_KEY as fallback (same as your current OPENROUTER_API_KEY)
// ══════════════════════════════════════════════════
async function callAI(prompt, maxTokens = 2000, aiConfig = {}) {
  const useLocal = aiConfig.source === 'local';

  if (useLocal) {
    const baseUrl = (aiConfig.localEndpoint || 'http://localhost:11434/v1').replace(/\/$/, '');
    const model = aiConfig.localModel || 'llama3';
    const aiRes = await axios.post(`${baseUrl}/chat/completions`, {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 120000
    });
    return aiRes.data.choices[0].message.content
      .replace(/```json/g, '').replace(/```/g, '').trim();
  }

  // ── Try Gemini Flash first (60 RPM free) ──────────
  if (process.env.GEMINI_API_KEY) {
    try {
      const geminiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0.7
          }
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      const raw = geminiRes.data.candidates[0].content.parts[0].text;
      return raw.replace(/```json/g, '').replace(/```/g, '').trim();
    } catch (geminiErr) {
      console.warn('Gemini failed, falling back to Groq:', geminiErr.message);
      // Fall through to Groq below
    }
  }

  // ── Fallback: Groq (30 RPM free) ─────────────────
  // Uses llama3-8b (faster + more tokens/min on free tier)
  // than llama3-70b for better throughput in demos.
  const groqRes = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: 'llama3-8b-8192',   // 14400 tokens/min vs 6000 for 70b on free tier
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 30000
  });
  const raw = groqRes.data.choices[0].message.content;
  return raw.replace(/```json/g, '').replace(/```/g, '').trim();
}

// ── Queued + Cached + Retried AI call ─────────────
// All routes use this wrapper instead of calling callAI directly.
async function queuedAI(prompt, maxTokens, aiConfig, cacheKey) {
  // 1. Check cache first (free — no API call needed)
  if (cacheKey) {
    const cached = getFromCache(cacheKey);
    if (cached) {
      console.log(`Cache hit for key ${cacheKey.slice(0, 8)}…`);
      return cached;
    }
  }

  // 2. Queue the actual API call
  const result = await aiQueue.add(() =>
    withRetry(() => callAI(prompt, maxTokens, aiConfig))
  );

  // 3. Store in cache for future identical requests
  if (cacheKey) setCache(cacheKey, result);

  return result;
}

// ══════════════════════════════════════════════════
// ROUTE: Daily Diet Plan
// ══════════════════════════════════════════════════
app.post('/api/diet', async (req, res) => {
  const { targetCal, protein, condition, foodPref, budget, aiConfig } = req.body;

  if (!targetCal || !protein) {
    return res.status(400).json({ error: 'Missing targetCal or protein in request body.' });
  }

  const rules = (condition && condition !== 'none' && CONDITION_RULES[condition])
    ? CONDITION_RULES[condition] : CONDITION_RULES.general;

  const conditionSection = (condition && condition !== 'none')
    ? `\nTHERAPEUTIC REQUIREMENTS — ${rules.label}:\n` +
      `- MUST prioritize these foods: ${rules.prioritize.join(', ')}\n` +
      `- STRICTLY AVOID: ${rules.avoid.join(', ')}\n` +
      `- Clinical principle: ${rules.notes}\n`
    : '';

  const vegNote = foodPref === 'nonveg'
    ? 'Food preference: Non-vegetarian allowed. Can include eggs, fish, or chicken (minimal).'
    : 'Food preference: STRICTLY VEGETARIAN. No meat, chicken, fish. Eggs are acceptable.';

  const budgetNote = budget === 'medium'
    ? 'Budget: Medium — can use paneer, curd, nuts, dry fruits occasionally.'
    : 'Budget: Low/affordable — dal, roti, seasonal vegetables, eggs as primary sources.';

  const prompt = `
Create a 1-day therapeutic diet plan using COMMON INDIAN FOODS only.
- Specify exact quantities (e.g., "2 rotis", "1 cup dal", "100g paneer")
- ${vegNote}
- ${budgetNote}
${conditionSection}
Daily Nutrition Targets: Calories: ~${targetCal} kcal, Protein: ~${protein}g

Return ONLY raw JSON (no markdown, no extra text):
{
  "meals":[
    {"name":"Breakfast","items":["2 whole wheat rotis with 100g paneer bhurji","1 cup green tea"]},
    {"name":"Lunch","items":["2 rotis","1 cup moong dal","bhindi sabzi (150g)","salad"]},
    {"name":"Dinner","items":["1 cup brown rice","rajma curry (150g)","curd (100g)"]},
    {"name":"Snacks","items":["1 banana","10 almonds"]}
  ]
}`;

  // Cache key based on the meaningful inputs (not aiConfig)
  const cacheKey = getCacheKey({ targetCal, protein, condition, foodPref, budget });

  try {
    const cleanJson = await queuedAI(prompt, 2000, aiConfig || {}, cacheKey);
    const plan = JSON.parse(cleanJson);

    // Enrich with Edamam nutrition data
    const enrichedMeals = [];
    for (const meal of plan.meals) {
      let totalKcal = 0, totalProtein = 0;
      const itemsDetailed = [];

      for (const item of meal.items) {
        const data = await getNutrition(item);
        const kcal = data?.calories || 0;
        const itemProtein = data?.totalNutrients?.PROCNT?.quantity || 0;
        totalKcal += kcal;
        totalProtein += itemProtein;
        itemsDetailed.push({
          name: item,
          kcal: Math.round(kcal),
          protein: Math.round(itemProtein)
        });
      }

      enrichedMeals.push({
        ...meal,
        itemsDetailed,
        kcal: Math.round(totalKcal),
        protein: Math.round(totalProtein)
      });
    }

    res.json({
      meals: enrichedMeals,
      condition: condition || 'none',
      conditionLabel: rules.label,
      fromCache: false // you can expose this in demo to show caching working
    });

  } catch (error) {
    console.error('Backend Error (/api/diet):', error.message);
    res.status(500).json({ error: 'Failed to generate diet plan. Please try again.' });
  }
});

// ══════════════════════════════════════════════════
// ROUTE: Smart Meal Improver
// ══════════════════════════════════════════════════
app.post('/api/improve-meal', async (req, res) => {
  const { mealDescription, condition, aiConfig } = req.body;

  if (!mealDescription || mealDescription.trim().length < 5) {
    return res.status(400).json({ error: 'Please provide a meal description.' });
  }

  const conditionContext = (condition && condition !== 'none' && CONDITION_RULES[condition])
    ? `\nIMPORTANT: The person has ${CONDITION_RULES[condition].label}.\n` +
      `Consider their restrictions: ${CONDITION_RULES[condition].notes}\n` +
      `Suggest alternatives that are safe for their condition.`
    : '';

  const prompt = `
You are a clinical Indian nutritionist. Analyze this meal and provide helpful, practical advice.

What the person ate today: "${mealDescription}"
${conditionContext}

Be encouraging, practical, and specific to Indian eating habits.

Respond in ONLY this exact JSON format (no markdown, no extra text):
{
  "summary": "One positive + honest assessment sentence",
  "estimatedKcal": 1200,
  "strengths": ["One specific thing done well"],
  "improvements": [
    {
      "issue": "Low protein intake",
      "suggestion": "Add 2 boiled eggs to breakfast OR replace one snack with 100g curd",
      "priority": "high"
    }
  ],
  "missingNutrients": ["Iron", "Fiber", "Vitamin C"],
  "addTomorrow": [
    "1 cup palak dal (spinach + lentil) — addresses iron + protein"
  ]
}`;

  // Meal descriptions are unique per user, so cache by exact text + condition
  const cacheKey = getCacheKey({ mealDescription: mealDescription.trim().toLowerCase(), condition });

  try {
    const cleanJson = await queuedAI(prompt, 1000, aiConfig || {}, cacheKey);
    const analysis = JSON.parse(cleanJson);
    res.json(analysis);
  } catch (error) {
    console.error('Backend Error (/api/improve-meal):', error.message);
    res.status(500).json({ error: 'Failed to analyze meal. Please try again.' });
  }
});

// ══════════════════════════════════════════════════
// ROUTE: Weekly Meal Planner
// ══════════════════════════════════════════════════
app.post('/api/weekly-plan', async (req, res) => {
  const { targetCal, protein, condition, foodPref, budget, aiConfig } = req.body;

  if (!targetCal || !protein) {
    return res.status(400).json({ error: 'Missing targetCal or protein.' });
  }

  const rules = (condition && condition !== 'none' && CONDITION_RULES[condition])
    ? CONDITION_RULES[condition] : null;

  const conditionSection = rules
    ? `\nHealth Condition: ${rules.label}\n` +
      `Prioritize: ${rules.prioritize.slice(0, 8).join(', ')}\n` +
      `Avoid: ${rules.avoid.slice(0, 5).join(', ')}\n`
    : '';

  const vegNote = foodPref === 'nonveg'
    ? 'Non-vegetarian OK (eggs, fish, chicken 2-3 times/week max).'
    : 'Strictly vegetarian (eggs allowed).';

  const budgetNote = budget === 'medium'
    ? 'Medium budget (paneer, curd, nuts are fine).'
    : 'Low budget (dal, roti, eggs, seasonal vegetables only).';

  const prompt = `
Create a 7-day varied Indian meal plan. Each day should have different meals.

Daily targets: ~${targetCal} kcal, ~${protein}g protein
${vegNote}
${budgetNote}
${conditionSection}

IMPORTANT: Return ONLY raw JSON (no markdown, no extra text):
{
  "days": [
    {
      "day": "Monday",
      "breakfast": "Poha with vegetables (1.5 cups) + 1 boiled egg + green tea",
      "lunch": "2 whole wheat rotis + 1 cup moong dal + bhindi sabzi (150g)",
      "dinner": "1 cup rice + rajma curry (1 cup) + 100g curd",
      "snacks": "1 banana + 10 almonds"
    }
  ],
  "groceryList": {
    "grains": ["Whole wheat atta — 2 kg"],
    "proteins": ["Moong dal — 500g"],
    "vegetables": ["Spinach (palak) — 500g"],
    "fruits": ["Bananas — 8"],
    "dairy": ["Milk — 1.5L"],
    "spicesCondiments": ["Jeera (cumin)", "Turmeric (haldi)"],
    "nutsSeeds": ["Almonds — 100g"]
  }
}`;

  const cacheKey = getCacheKey({ targetCal, protein, condition, foodPref, budget, type: 'weekly' });

  try {
    const cleanJson = await queuedAI(prompt, 3000, aiConfig || {}, cacheKey);
    const weekPlan = JSON.parse(cleanJson);
    res.json(weekPlan);
  } catch (error) {
    console.error('Backend Error (/api/weekly-plan):', error.message);
    res.status(500).json({ error: 'Failed to generate weekly plan. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NutriPlan Backend running on port ${PORT}`);
  console.log(`Queue: max ${QUEUE_CONCURRENCY} concurrent AI calls, ${QUEUE_INTERVAL_MS}ms interval`);
  console.log(`AI: ${process.env.GEMINI_API_KEY ? 'Gemini Flash (primary) + Groq (fallback)' : 'Groq only'}`);
});