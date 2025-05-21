/*
  Time‑Planner‑AI – Backend server  (CommonJS version)
  --------------------------------------------------
  Express + PostgreSQL + DeepSeek
  .env 需要配置：
      DATABASE_URL      Postgres 连接字符串
      PORT              端口 (可选，默认 3000)
      DEEPSEEK_API_KEY  DeepSeek API Key
*/

require("dotenv").config();            // 读取 .env
const express = require("express");
const cors    = require("cors");
const { Pool } = require("pg");
const bcrypt  = require("bcryptjs");
const fetch   = require("node-fetch");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

/*********************** 共用工具 *************************/
const toISOdate = (d) => d.toISOString().split("T")[0];

function parsePlanText(planText, startDate = new Date()) {
  const tasks = [];
  let dayIndex = -1;
  planText.split(/\r?\n/).forEach((lineRaw) => {
    const line = lineRaw.trim();
    if (!line) return;

    const dayMatch = line.match(/^DAY\s*(\d+)/i);
    if (dayMatch) {
      dayIndex = parseInt(dayMatch[1], 10) - 1;
      return;
    }

    const taskMatch = line.match(/^[\-•]\s*(.+?)\s*@\s*([\d\.]+)/);
    if (taskMatch && dayIndex >= 0) {
      const [, task, hours] = taskMatch;
      const d = new Date(startDate);
      d.setDate(d.getDate() + dayIndex);
      tasks.push({ task: task.trim(), duration: parseFloat(hours), date: toISOdate(d) });
    }
  });
  return tasks;
}

/*********************** 用户注册 & 登录 *************************/

app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query("SELECT id FROM users WHERE email=$1", [email]);
    if (rows.length) return res.status(400).json({ error: "邮箱已存在" });

    const hash = await bcrypt.hash(password, 10);
    const { rows: newUser } = await pool.query(
      "INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id",
      [email, hash]
    );
    res.json({ userId: newUser[0].id });
  } catch (e) {
    console.error("注册失败", e);
    res.status(500).json({ error: "注册失败" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query("SELECT id, password_hash FROM users WHERE email=$1", [email]);
    if (!rows.length) return res.status(400).json({ error: "用户不存在" });

    const user = rows[0];
    if (!user.password_hash || typeof user.password_hash !== "string") {
      return res.status(500).json({ error: "密码字段无效" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: "密码错误" });

    res.json({ userId: user.id });
  } catch (e) {
    console.error("登录失败", e);
    res.status(500).json({ error: "登录失败" });
  }
});

/*********************** DeepSeek 计划生成功能 *************************/

const DEEPSEEK_URL  = "https://api.deepseek.com/v1/chat/completions";
const DEEP_MODEL    = "deepseek-chat";
const BEARER        = `Bearer ${process.env.DEEPSEEK_API_KEY}`;

app.post("/api/plan", async (req, res) => {
  const { goal, userId } = req.body;
  if (!goal || !userId) return res.status(400).json({ error: "缺少 goal 或 userId" });

  const sysPrompt = `You are a supportive study-planning assistant.\n` +
                    `The user goal is: "${goal}".\n` +
                    `Return a 7-day schedule. STRICT FORMAT:\n` +
                    `DAY1:\n- Task description @ hours\nDAY2:\n...\nRespond only with the schedule.`;
  try {
    const r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": BEARER,
      },
      body: JSON.stringify({
        model: DEEP_MODEL,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user",   content: sysPrompt },
        ],
      }),
    });

    const data = await r.json();
    const planText = data.choices?.[0]?.message?.content || "";
    const tasks = parsePlanText(planText);

    for (const t of tasks) {
      await pool.query(
        "INSERT INTO tasks (user_id, task, duration, date) VALUES ($1,$2,$3,$4)",
        [userId, t.task, t.duration, t.date]
      );
    }

    res.json({ success: true });
  } catch (e) {
    console.error("/api/plan 失败", e);
    res.status(500).json({ error: "Plan generation failed" });
  }
});

/*********************** AI 聊天接口 *************************/

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "消息为空" });

  try {
    const r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": BEARER,
      },
      body: JSON.stringify({
        model: DEEP_MODEL,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: message },
        ],
      }),
    });

    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content || "⚠️ AI 没有返回内容";
    res.json({ reply });
  } catch (e) {
    console.error("Chat 接口错误", e);
    res.status(500).json({ error: "连接 AI 失败" });
  }
});

/*********************** 任务 CRUD *************************/

app.post("/api/tasks", async (req, res) => {
  const { userId, task, duration, date } = req.body;
  try {
    await pool.query(
      "INSERT INTO tasks (user_id, task, duration, date) VALUES ($1,$2,$3,$4)",
      [userId, task, duration, date]
    );
    res.json({ success: true });
  } catch (e) {
    console.error("添加任务失败", e);
    res.status(500).json({ error: "添加任务失败" });
  }
});

app.get("/api/tasks/:userId", async (req, res) => {
  const { userId } = req.params;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM tasks WHERE user_id=$1 ORDER BY date",
      [userId]
    );
    res.json(rows);
  } catch (e) {
    console.error("获取任务失败", e);
    res.status(500).json({ error: "获取任务失败" });
  }
});

app.patch("/api/tasks/:id/done", async (req, res) => {
  const { id } = req.params;
  const { done } = req.body;
  try {
    await pool.query("UPDATE tasks SET done=$1 WHERE id=$2", [done, id]);
    res.json({ success: true });
  } catch (e) {
    console.error("更新失败", e);
    res.status(500).json({ error: "更新失败" });
  }
});

app.delete("/api/tasks/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query("DELETE FROM tasks WHERE id=$1", [id]);
    res.json({ success: true });
  } catch (e) {
    console.error("删除任务失败", e);
    res.status(500).json({ error: "删除任务失败" });
  }
});

app.listen(PORT, () => {
  const base = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || "https://time-planner-backend.onrender.com";
  console.log(`🚀 Server ready on ${base}`);
});