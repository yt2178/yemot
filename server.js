import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

const GEMINI_KEY = process.env.GEMINI_KEY;

// נקודת קצה לקבלת שאלה מימות המשיח
app.post("/ask", async (req, res) => {
  try {
    const question = req.body.stt || "לא קיבלתי שאלה";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: question }] }],
        }),
      }
    );

    const data = await response.json();
    const answer =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "לא הצלחתי לקבל תשובה";

    res.json({ tts: answer });
  } catch (err) {
    res.json({ tts: "שגיאה בעיבוד הבקשה" });
  }
});

// נקודת קצה לתשובות
app.post("/answer", (req, res) => {
  res.json({ tts: "התשובה מוכנה" });
});

app.listen(3000, () => console.log("Server running"));
