import dotenv from "dotenv";

dotenv.config();

const port = process.env.VERN_PORT ?? 3000;

console.log(`Vern starting on port ${port}`);
