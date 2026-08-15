import { createDb } from "../client";
import { migrate } from "../migrate";

const url = process.env.DATABASE_URL ?? "sqlite:data/nexus.sqlite";
const db = createDb(url);
await migrate(db);
await db.close();
console.log("migrations complete");
process.exit(0);
