require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════
// [NEW] CONDITION-BASED DIETARY RULES
// Rule-based therapeutic nutrition engine.
// Each condition defines: foods to prioritize,
// foods to avoid, and guiding clinical notes.
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

// ── Helper: Edamam nutrition lookup ──────────────
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

// ── Helper: Call OpenRouter AI ────────────────────
async function callAI(prompt, maxTokens = 2000) {
  const aiRes = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: 'google/gemma-3-27b-it:free',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  const raw = aiRes.data.choices[0].message.content;
  return raw.replace(/```json/g, '').replace(/```/g, '').trim();
}

// ══════════════════════════════════════════════════
// EXISTING ROUTE: Daily Diet Plan  [ENHANCED]
// Now accepts: condition, foodPref, budget
// Uses condition rules to craft a therapeutic prompt
// ══════════════════════════════════════════════════
app.post('/api/diet', async (req, res) => {
  const { targetCal, protein, condition, foodPref, budget } = req.body;

  if (!targetCal || !protein) {
    return res.status(400).json({ error: 'Missing targetCal or protein in request body.' });
  }

  // Build condition-specific context for the AI prompt
  const rules = (condition && condition !== 'none' && CONDITION_RULES[condition])
    ? CONDITION_RULES[condition]
    : CONDITION_RULES.general;

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
    : 'Budget: Low/affordable — dal, roti, seasonal vegetables, eggs as primary sources. Minimize expensive ingredients.';

  const prompt = `
Create a 1-day therapeutic diet plan using COMMON INDIAN FOODS only.

Core rules:
- Use foods easily available across India
- Keep meals practical and achievable at home
- Specify exact quantities (e.g., "2 rotis", "1 cup dal", "100g paneer")
- ${vegNote}
- ${budgetNote}
${conditionSection}
Daily Nutrition Targets:
Calories: ~${targetCal} kcal
Protein: ~${protein}g

Return ONLY raw JSON (absolutely no markdown, no extra text):
{
  "meals":[
    {"name":"Breakfast","items":["2 whole wheat rotis with 100g paneer bhurji", "1 cup green tea"]},
    {"name":"Lunch","items":["2 rotis","1 cup moong dal","bhindi sabzi (150g)","salad"]},
    {"name":"Dinner","items":["1 cup brown rice","rajma curry (150g)","curd (100g)"]},
    {"name":"Snacks","items":["1 banana","10 almonds"]}
  ]
}`;

  try {
    const cleanJson = await callAI(prompt);
    const plan = JSON.parse(cleanJson);

    // Enrich meals with Edamam nutrition data
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
      conditionLabel: rules.label
    });

  } catch (error) {
    console.error('Backend Error (/api/diet):', error.message);
    res.status(500).json({ error: 'Failed to generate diet plan.' });
  }
});

// ══════════════════════════════════════════════════
// [NEW ROUTE] Smart Meal Improver
// User inputs what they ate today → AI analyzes
// and provides practical improvement suggestions
// using Indian food alternatives
// ══════════════════════════════════════════════════
app.post('/api/improve-meal', async (req, res) => {
  const { mealDescription, condition } = req.body;

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
  "strengths": [
    "One specific thing done well"
  ],
  "improvements": [
    {
      "issue": "Low protein intake",
      "suggestion": "Add 2 boiled eggs to breakfast OR replace one snack with 100g curd",
      "priority": "high"
    },
    {
      "issue": "Missing vegetables/fiber",
      "suggestion": "Add a small kachumber salad (cucumber, tomato, onion) to lunch",
      "priority": "medium"
    }
  ],
  "missingNutrients": ["Iron", "Fiber", "Vitamin C"],
  "addTomorrow": [
    "1 cup palak dal (spinach + lentil) — addresses iron + protein",
    "1 whole fruit (guava or amla) — Vitamin C"
  ]
}`;

  try {
    const cleanJson = await callAI(prompt, 1000);
    const analysis = JSON.parse(cleanJson);
    res.json(analysis);
  } catch (error) {
    console.error('Backend Error (/api/improve-meal):', error.message);
    res.status(500).json({ error: 'Failed to analyze meal. Please try again.' });
  }
});

// ══════════════════════════════════════════════════
// [NEW ROUTE] Weekly Meal Planner
// Generates a 7-day structured plan with variety,
// then auto-extracts a categorized grocery list
// ══════════════════════════════════════════════════
app.post('/api/weekly-plan', async (req, res) => {
  const { targetCal, protein, condition, foodPref, budget } = req.body;

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
Create a 7-day varied Indian meal plan. Each day should have different meals — avoid repeating the same dish on consecutive days.

Daily targets: ~${targetCal} kcal, ~${protein}g protein
${vegNote}
${budgetNote}
${conditionSection}

Rules:
- Common Indian foods only (roti, dal, rice, sabzi, etc.)
- Specify quantities ("2 rotis", "1 cup dal", "1 banana")
- Be practical: meals a regular Indian family would cook

IMPORTANT: Return ONLY raw JSON (no markdown, no extra text):
{
  "days": [
    {
      "day": "Monday",
      "breakfast": "Poha with vegetables (1.5 cups) + 1 boiled egg + green tea",
      "lunch": "2 whole wheat rotis + 1 cup moong dal + bhindi sabzi (150g) + kachumber salad",
      "dinner": "1 cup rice + rajma curry (1 cup) + 100g curd",
      "snacks": "1 banana + 10 almonds"
    },
    { "day": "Tuesday", "breakfast": "...", "lunch": "...", "dinner": "...", "snacks": "..." },
    { "day": "Wednesday", "breakfast": "...", "lunch": "...", "dinner": "...", "snacks": "..." },
    { "day": "Thursday", "breakfast": "...", "lunch": "...", "dinner": "...", "snacks": "..." },
    { "day": "Friday", "breakfast": "...", "lunch": "...", "dinner": "...", "snacks": "..." },
    { "day": "Saturday", "breakfast": "...", "lunch": "...", "dinner": "...", "snacks": "..." },
    { "day": "Sunday", "breakfast": "...", "lunch": "...", "dinner": "...", "snacks": "..." }
  ],
  "groceryList": {
    "grains": ["Whole wheat atta — 2 kg", "Rice — 1 kg", "Oats — 500g", "Poha — 500g"],
    "proteins": ["Moong dal — 500g", "Rajma — 500g", "Chana dal — 500g", "Eggs — 1 dozen"],
    "vegetables": ["Spinach (palak) — 500g", "Bhindi — 500g", "Tomatoes — 8", "Onions — 6", "Potatoes — 4"],
    "fruits": ["Bananas — 8", "Apples — 4", "Seasonal fruit — 500g"],
    "dairy": ["Milk — 1.5L", "Curd — 500g"],
    "spicesCondiments": ["Jeera (cumin)", "Turmeric (haldi)", "Ginger — 100g", "Garlic — 1 pod", "Mustard seeds"],
    "nutsSeeds": ["Almonds — 100g", "Pumpkin seeds — 100g", "Flaxseeds (alsi) — 100g"]
  }
}`;

  try {
    const cleanJson = await callAI(prompt, 3000);
    const weekPlan = JSON.parse(cleanJson);
    res.json(weekPlan);
  } catch (error) {
    console.error('Backend Error (/api/weekly-plan):', error.message);
    res.status(500).json({ error: 'Failed to generate weekly plan. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`NutriPlan (Food as Medicine) Backend running on port ${PORT}`);
});