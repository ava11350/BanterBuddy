import { loadEnv } from "vite";
console.log("process.env.GEMINI_API_KEY:", process.env.GEMINI_API_KEY);
const env = loadEnv('development', '.', '');
console.log("env.GEMINI_API_KEY:", env.GEMINI_API_KEY);
