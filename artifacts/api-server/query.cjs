const { Client } = require('pg');

async function run() {
  const client = new Client({
    connectionString: "postgresql://noetic_dial_usr:Webworks%401234@localhost:5432/noetic_dialog"
  });
  await client.connect();
  const res = await client.query('SELECT * FROM training_data');
  console.log(JSON.stringify(res.rows, null, 2));
  await client.end();
}
run().catch(console.error);
