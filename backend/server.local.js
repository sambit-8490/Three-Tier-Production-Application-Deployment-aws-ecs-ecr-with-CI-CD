const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

let db;

/* ------------------ DB CONFIG FROM ENV VARS ------------------ */

function getDBConfig() {
  const config = {
    host: process.env.host,
    user: process.env.user,
    password: process.env.password,
    name: process.env.database
  };

  if (!config.host || !config.user || !config.password || !config.name) {
    throw new Error("Missing DB environment variables (host, user, password, database)");
  }

  return config;
}

/* ------------------ CREATE DATABASE IF NOT EXISTS ------------------ */

async function ensureDatabaseExists(config) {
  const conn = await mysql.createConnection({
    host: config.host,
    user: config.user,
    password: config.password
  });

  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.name}\``);
  await conn.end();
  console.log("✅ Database verified");
}

/* ------------------ CONNECT TO DB ------------------ */

async function connectWithRetry(retries = 10, delay = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      const cfg = getDBConfig();

      await ensureDatabaseExists(cfg);

      const pool = mysql.createPool({
        host: cfg.host,
        user: cfg.user,
        password: cfg.password,
        database: cfg.name,
        connectionLimit: 10
      });

      console.log("✅ Connected to MySQL");
      return pool;
    } catch (err) {
      console.error(`❌ DB connection failed (attempt ${i})`, err.message);
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/* ------------------ TABLE CREATION ------------------ */

async function ensureTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS student (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255),
      roll_number VARCHAR(255),
      class VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS teacher (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255),
      subject VARCHAR(255),
      class VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("✅ Tables ready");
}

// ---- Health Check Routes ----

app.get('/health', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'backend',
    uptime: process.uptime()
  });
});

app.get('/health/db', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT 1 as db_up');

    return res.status(200).json({
      status: 'ok',
      database: 'connected',
      host: process.env.host,
      database_name: process.env.database,
      result: rows[0]
    });

  } catch (error) {
    console.error('DB health check failed:', error.message);

    return res.status(500).json({
      status: 'error',
      database: 'down',
      error: error.message
    });
  }
});

/* ------------------ ROUTES ------------------ */

app.get("/", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM student");
  res.json({ message: "Backend running 🚀", data: rows });
});

app.get("/student", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM student");
  res.json(rows);
});

app.get("/teacher", async (req, res) => {
  const [rows] = await db.query("SELECT * FROM teacher");
  res.json(rows);
});

app.post("/addstudent", async (req, res) => {
  const { name, rollNo, class: cls } = req.body;
  await db.query(
    "INSERT INTO student (name, roll_number, class) VALUES (?, ?, ?)",
    [name, rollNo, cls]
  );
  res.json({ message: "Student added" });
});

app.post("/addteacher", async (req, res) => {
  const { name, subject, class: cls } = req.body;
  await db.query(
    "INSERT INTO teacher (name, subject, class) VALUES (?, ?, ?)",
    [name, subject, cls]
  );
  res.json({ message: "Teacher added" });
});

app.delete("/student/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      "DELETE FROM student WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Student not found" });
    }

    res.json({ message: "Student deleted successfully" });
  } catch (err) {
    console.error("Delete student error:", err);
    res.status(500).json({ error: "Failed to delete student" });
  }
});

app.delete("/teacher/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [result] = await db.query(
      "DELETE FROM teacher WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Teacher not found" });
    }

    res.json({ message: "Teacher deleted successfully" });
  } catch (err) {
    console.error("Delete teacher error:", err);
    res.status(500).json({ error: "Failed to delete teacher" });
  }
});

/* ------------------ START SERVER ------------------ */

(async () => {
  try {
    db = await connectWithRetry();
    await ensureTables(db);

    const PORT = 3500;
    app.listen(PORT, () =>
      console.log(`🚀 Server running on port ${PORT}`)
    );
  } catch (err) {
    console.error("❌ App failed to start:", err);
    process.exit(1);
  }
})();
