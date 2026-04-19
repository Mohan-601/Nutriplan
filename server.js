require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors()); // Allows your frontend to communicate with this backend
app.use(express.json());
app.use(express.static('public'));
// Helper function to get Edamam Nutrition Data
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
        console.error(`Edamam API Error for item "${food}":`, error.message);
        return null;
    }
}

// Main API Route
app.post('/api/diet', async (req, res) => {
    const { targetCal, protein } = req.body;

    if (!targetCal || !protein) {
        return res.status(400).json({ error: "Missing targetCal or protein in request body." });
    }

    const prompt = `
    Create a daily diet plan using COMMON INDIAN FOODS only.
    
    Rules:
    - Use foods easily available in India (roti, dal, rice, paneer, eggs, chicken, etc.)
    - Avoid western foods like quinoa, avocado toast, etc.
    - Keep it practical and home-cooked
    
    Targets:
    Calories: ${targetCal}
    Protein: ${protein}g
    
    Return ONLY raw JSON, no markdown formatting or extra text:
    {
      "meals":[
        {"name":"Breakfast","items":["..."]},
        {"name":"Lunch","items":["..."]},
        {"name":"Dinner","items":["..."]},
        {"name":"Snacks","items":["..."]}
      ]
    }`;

    try {
        // 1. Get Diet Plan from OpenRouter (Mistral)
        const aiRes = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            model: "google/gemma-3-27b-it:free",
            messages: [{ role: "user", content: prompt }]
        }, {
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            }
        });

        const rawContent = aiRes.data.choices[0].message.content;
        
        // Clean up markdown block if the AI included it despite instructions
        const cleanJson = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
        const plan = JSON.parse(cleanJson);

        // 2. Enrich meals with Edamam Data
        const enrichedMeals = [];

        for (let meal of plan.meals) {
            let totalKcal = 0;
            let totalProtein = 0;
            const itemsDetailed = [];

            for (let item of meal.items) {
                const data = await getNutrition(item);
                
                let kcal = 0;
                let itemProtein = 0;

                if (data) {
                    kcal = data.calories || 0;
                    itemProtein = data.totalNutrients?.PROCNT?.quantity || 0;
                }

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

        // 3. Send back the enriched plan
        res.json({ meals: enrichedMeals });

    } catch (error) {
        console.error("Backend Error:", error);
        res.status(500).json({ error: "Failed to generate diet plan." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`NutriPlan Backend running on port ${PORT}`);
});