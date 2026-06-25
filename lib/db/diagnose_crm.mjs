import pg from 'pg';

const connectionString = "postgresql://noetic_dial_usr:Webworks%401234@localhost:5432/noetic_dialog";
const pool = new pg.Pool({ connectionString });

async function diagnose() {
  try {
    const res = await pool.query('SELECT * FROM external_crm_configs WHERE user_id = 7');
    if (res.rows.length === 0) {
      console.log("No external CRM config found for user_id = 7 in the production database.");
      return;
    }
    
    const config = res.rows[0];
    console.log("--- Production CRM Config ---");
    console.log("Name:", config.name);
    console.log("Is Enabled:", config.is_enabled);
    console.log("Lookup URL:", config.lookup_url);
    console.log("HTTP Method:", config.http_method);
    console.log("Auth Type:", config.auth_type);
    console.log("Auth Value Prefix:", config.auth_value ? config.auth_value.slice(0, 15) + "..." : "null");
    console.log("Phone Param Name:", config.phone_param_name);
    console.log("Phone Param Location:", config.phone_param_location);
    console.log("Response Mapping:", JSON.stringify(config.response_mapping, null, 2));
    console.log("Use Raw Response:", config.use_raw_response);
    
    // Simulate lookup
    const phone = "9782427020";
    let url = config.lookup_url;
    const headers = { "Accept": "application/json" };
    
    if (config.auth_value) {
      if (config.auth_type === "bearer") {
        headers["Authorization"] = `Bearer ${config.auth_value}`;
      } else if (config.auth_type === "api_key") {
        headers["X-API-Key"] = config.auth_value;
      } else if (config.auth_type === "basic") {
        headers["Authorization"] = `Basic ${Buffer.from(config.auth_value).toString("base64")}`;
      } else if (config.auth_type === "header") {
        headers[config.auth_header_name || "X-Auth-Token"] = config.auth_value;
      }
    }
    
    let body;
    if (config.phone_param_location === "path") {
      url = url.replace(/\{phone\}/g, encodeURIComponent(phone));
    } else if (config.http_method === "GET" || config.phone_param_location === "query") {
      const separator = url.includes("?") ? "&" : "?";
      url = `${url}${separator}${encodeURIComponent(config.phone_param_name)}=${encodeURIComponent(phone)}`;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ [config.phone_param_name]: phone });
    }
    
    console.log("\nCalling CRM URL:", url);
    console.log("Headers:", JSON.stringify(Object.keys(headers)));
    
    const response = await fetch(url, {
      method: config.http_method,
      headers,
      body
    });
    
    console.log("Status:", response.status);
    const json = await response.json();
    console.log("\n--- Raw CRM Response ---");
    console.log(JSON.stringify(json, null, 2));
    
  } catch (err) {
    console.error("Diagnosis failed:", err);
  } finally {
    await pool.end();
  }
}

diagnose();
