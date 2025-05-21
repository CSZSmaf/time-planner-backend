
import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;
const express = require('express');
const cors = require('cors'); // ✅ 引入 CORS 中间件
const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static("../frontend"));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ====== 用户注册 ======
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
      [email, hash]
    );
    res.json({ userId: result.rows[0].id });
  } catch (err) {
    console.error("注册失败:", err);
    res.status(500).json({ error: "注册失败，可能邮箱已存在" });
  }
});

// ====== 用户登录 ======
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "用户不存在" });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: "密码错误" });

    res.json({ userId: user.id });
  } catch (err) {
    console.error("登录失败:", err);
    res.status(500).json({ error: "登录失败" });
  }
});

// ====== 添加任务 ======
app.post("/api/tasks", async (req, res) => {
  const { userId, task, duration, date } = req.body;
  try {
    await pool.query(
      "INSERT INTO tasks (user_id, task, duration, date) VALUES ($1, $2, $3, $4)",
      [userId, task, duration, date]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("添加任务失败:", err);
    res.status(500).json({ error: "添加任务失败" });
  }
});

// ====== 获取任务 ======
app.get("/api/tasks/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM tasks WHERE user_id = $1 ORDER BY date",
      [userId]
    );
    res.json({ tasks: result.rows });
  } catch (err) {
    console.error("获取任务失败:", err);
    res.status(500).json({ error: "获取任务失败" });
  }
});

// ====== DeepSeek 生成 7 天计划 ======
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const API_KEY = process.env.DEEPSEEK_API_KEY;

app.post("/api/plan", async (req, res) => {
  const { goal } = req.body;
  const systemPrompt = `
You are a supportive study-planning assistant.
The user goal is: "${goal}".
Return a 7-day schedule. STRICT FORMAT:
DAY1:
- Task description @ hours
DAY2:
...
Respond only with the schedule.
`.trim();

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: systemPrompt }
        ]
      })
    });

    const data = await response.json();
    const plan = data.choices?.[0]?.message?.content || "";
    res.json({ plan });
  } catch (err) {
    console.error("Error in /api/plan:", err);
    res.status(500).json({ error: "Plan generation failed" });
  }
});

// ====== 调整任务 ======
app.post("/api/adjust", async (req, res) => {
  const { unfinished, feedback } = req.body;
  const today = new Date().toDateString();

  const unfinishedToday = unfinished
    .filter((t) => t.date === today)
    .map((t, i) => `${i + 1}. ${t.task} (${t.duration})`)
    .join("\n");

  const adjustPrompt = `
You are a study-planning assistant. The following tasks are unfinished:
${unfinishedToday}
User feedback: "${feedback}"
Make a new schedule for today only, starting from the unfinished tasks.
Respond ONLY with the tasks for today.
`.trim();

  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: adjustPrompt }
        ]
      })
    });

    const data = await response.json();
    const plan = data.choices?.[0]?.message?.content || "";
    res.json({ plan });
  } catch (err) {
    console.error("Error in /api/adjust:", err);
    res.status(500).json({ error: "Adjustment failed" });
  }
});

app.listen(port, () => {
  console.log(`✔ Server running at http://localhost:${port}`);
});
