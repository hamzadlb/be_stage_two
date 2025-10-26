import pool from "./db.js";

(async () => {
  try {
    const [rows] = await pool.query("SELECT 1 + 1 AS result");
    console.log("DB Connected:", rows[0].result);
  } catch (err) {
    console.error("DB Connection Error:", err);
  }
})();
