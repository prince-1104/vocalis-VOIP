import { db } from './src/lib/database.js';
import { trainingDataTable } from './src/schema.js';

async function run() {
  const data = await db.select().from(trainingDataTable);
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}
run();
