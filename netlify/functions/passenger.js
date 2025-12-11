// netlify/functions/passenger.js

export async function handler(event, context) {
  // --- Common CORS headers ---
  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ""
    };
  }

  // Only allow POST for main logic
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Invalid JSON body" })
    };
  }

  const { action, token, passengers } = payload;

  if (!token) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Missing token" })
    };
  }

  // Read env vars
  const ODOO_URL = process.env.ODOO_URL;
  const ODOO_DB = process.env.ODOO_DB;
  const ODOO_USERNAME = process.env.ODOO_USERNAME;
  const ODOO_API_KEY = process.env.ODOO_API_KEY;

  if (!ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_API_KEY) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Odoo credentials not configured on server" })
    };
  }

  try {
    // 1) Authenticate with Odoo to get user ID
    const uid = await odooAuthenticate(
      ODOO_URL,
      ODOO_DB,
      ODOO_USERNAME,
      ODOO_API_KEY
    );

    if (!uid) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Authentication to Odoo failed" })
      };
    }

    // --- LOAD ACTION ---
    if (action === "load") {
      // Load passengers for this token
      const passengersData = await odooSearchRead(
        ODOO_URL,
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        "x_tour_departure_passenger",
        [["x_studio_test_token", "=", token]],
        ["x_passenger_email", "x_passport_number", "x_partner_id"]
      );

      if (!passengersData || passengersData.length === 0) {
        return {
          statusCode: 404,
          headers: corsHeaders,
          body: JSON.stringify({
            status: "not_found",
            message: "No passengers found for this token"
          })
        };
      }

      // Map Odoo records to a clean JSON structure
      const mappedPassengers = passengersData.map((p) => {
        // x_partner_id is a Many2one: [id, "Name"]
        const partnerField = p.x_partner_id;
        const partnerName = Array.isArray(partnerField) ? partnerField[1] : null;

        return {
          id: p.id,
          name: partnerName,
          email: p.x_passenger_email || null,
          passport_number: p.x_passport_number || ""
        };
      });

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          status: "ok",
          passengers: mappedPassengers
        })
      };
    }

    // --- SAVE ACTION ---
    if (action === "save") {
      if (!Array.isArray(passengers)) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "Missing passengers array for save action" })
        };
      }

      // Optional: verify the token still maps to existing passengers
      const existing = await odooSearchRead(
        ODOO_URL,
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        "x_tour_departure_passenger",
        [["x_studio_test_token", "=", token]],
        ["id"]
      );

      const validIds = new Set((existing || []).map((p) => p.id));

      // For each passenger payload, update passport_number (or any other fields later)
      for (const p of passengers) {
        if (!p.id || !validIds.has(p.id)) {
          // Ignore unknown IDs for safety
          continue;
        }

        const vals = {};

        if (typeof p.passport_number === "string") {
          vals["x_passport_number"] = p.passport_number;
        }

        // If nothing to write, skip
        if (Object.keys(vals).length === 0) {
          continue;
        }

        await odooWrite(
          ODOO_URL,
          ODOO_DB,
          uid,
          ODOO_API_KEY,
          "x_tour_departure_passenger",
          p.id,
          vals
        );
      }

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ status: "ok" })
      };
    }

    // Unknown action
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Unknown action" })
    };
  } catch (err) {
    console.error("Netlify function error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Server error", details: String(err) })
    };
  }
}

// ---------- Helper functions for Odoo JSON-RPC ----------

async function odooJsonRpc(odooUrl, body) {
  const res = await fetch(`${odooUrl}/jsonrpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odoo HTTP error ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Odoo JSON-RPC error: ${JSON.stringify(data.error)}`);
  }
  return data.result;
}

async function odooAuthenticate(odooUrl, db, username, apiKey) {
  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "common",
      method: "authenticate",
      args: [db, username, apiKey, {}]
    }
  };
  const result = await odooJsonRpc(odooUrl, payload);
  return result; // uid or false
}

async function odooSearchRead(
  odooUrl,
  db,
  uid,
  apiKey,
  model,
  domain,
  fields
) {
  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: [db, uid, apiKey, model, "search_read", [domain], { fields: fields }]
    }
  };
  const result = await odooJsonRpc(odooUrl, payload);
  return result; // array of records
}

async function odooWrite(odooUrl, db, uid, apiKey, model, id, vals) {
  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: {
      service: "object",
      method: "execute_kw",
      args: [db, uid, apiKey, model, "write", [[id], vals]]
    }
  };
  const result = await odooJsonRpc(odooUrl, payload);
  return result; // true/false
}
