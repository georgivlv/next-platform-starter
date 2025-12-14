// netlify/functions/passenger.js

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',          // later you can restrict to your domain
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function handler(event, context) {
  // --- CORS preflight ---
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: CORS_HEADERS,
      body: '',
    };
  }

  // --- Only allow POST for main logic ---
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // --- Parse body ---
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { action, token, passengers } = payload;

  if (!token) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Missing token' }),
    };
  }

  // --- Env vars for Odoo ---
  const ODOO_URL = process.env.ODOO_URL;
  const ODOO_DB = process.env.ODOO_DB;
  const ODOO_USERNAME = process.env.ODOO_USERNAME;
  const ODOO_API_KEY = process.env.ODOO_API_KEY;

  if (!ODOO_URL || !ODOO_DB || !ODOO_USERNAME || !ODOO_API_KEY) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Odoo credentials not configured on server' }),
    };
  }

  try {
    // 1) Authenticate with Odoo
    const uid = await odooAuthenticate(
      ODOO_URL,
      ODOO_DB,
      ODOO_USERNAME,
      ODOO_API_KEY
    );

    if (!uid) {
      return {
        statusCode: 401,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Authentication to Odoo failed' }),
      };
    }

    // ==============================
    //  LOAD
    // ==============================
    if (action === 'load') {
      // 1.1) Load passengers for this token
      const passengersData = await odooSearchRead(
        ODOO_URL,
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        'x_tour_departure_passenger',
        [
          ['x_studio_test_token', '=', token]
        ],
        [
          // core linkage
          'x_studio_test_token',
          'x_partner_id',
          'x_departure_id',
          'x_tour_departure',

          // personal / contact
          'x_name',
          'x_passenger_first_name',
          'x_passenger_last_name',
          'x_passenger_middle_name',
          'x_passenger_email',
          'x_date_of_birth',
          'x_sex',
          'x_marrital_status',
          'x_nationality',
          'x_home_address',
          'x_job_position',
          'x_working_at',

          // travel / rooming
          'x_type_of_room',
          'x_sharing_with',
          'x_pre_tour_extra_night',
          'x_post_tour_extra_night',
          'x_flight_arrival',
          'x_flight_departure',

          // health / diet
          'x_diet',
          'x_allergies',
          'x_medical_conditions',

          // emergency
          'x_emergency_contact',
          'x_emergency_contact_number',

          // passport
          'x_passport_number',
          'x_passport_issue_date',
          'x_passport_expiry_date',

          // misc
          'x_notes'
          // (intentionally skipping binary image fields for now)
        ]
      );

      if (!passengersData || passengersData.length === 0) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            status: 'not_found',
            message: 'No passengers found for this token'
          }),
        };
      }

      // Helper: Many2one → { id, name }
      function m2oToObj(field) {
        if (Array.isArray(field) && field.length >= 2) {
          return { id: field[0], name: field[1] };
        }
        return null;
      }

      // 1.2) Collect unique departure IDs from passengers
      const departureIds = new Set();
      for (const p of passengersData) {
        const depField1 = p.x_departure_id;
        const depField2 = p.x_tour_departure;

        if (Array.isArray(depField1) && depField1.length >= 1) {
          departureIds.add(depField1[0]);
        }
        if (Array.isArray(depField2) && depField2.length >= 1) {
          departureIds.add(depField2[0]);
        }
      }

      // 1.3) Load departure details from x_tour_departure
      let departureInfo = null;

      if (departureIds.size > 0) {
        const idsArray = Array.from(departureIds);

        // IMPORTANT:
        // - Model: 'x_tour_departure' (your custom departure model)
        // - Fields: x_name, x_departure_date, x_end_date (as you specified)
        const departures = await odooSearchRead(
          ODOO_URL,
          ODOO_DB,
          uid,
          ODOO_API_KEY,
          'x_tour_departure',
          [['id', 'in', idsArray]],
          ['x_name', 'x_departure_date', 'x_end_date']
        );

        if (departures && departures.length > 0) {
          const d = departures[0]; // assume one departure per token
          departureInfo = {
            id: d.id,
            name: d.x_name || null,
            start_date: d.x_departure_date || null,
            end_date: d.x_end_date || null
          };
        }
      }

      // 1.4) Map passenger records to clean JSON
      const mappedPassengers = passengersData.map(p => {
        const partner = m2oToObj(p.x_partner_id);
        const dep1 = m2oToObj(p.x_departure_id);
        const dep2 = m2oToObj(p.x_tour_departure);

        return {
          id: p.id,

          token: p.x_studio_test_token || null,

          // name / identity
          partner,
          name: p.x_name || (partner && partner.name) || null,
          first_name: p.x_passenger_first_name || null,
          middle_name: p.x_passenger_middle_name || null,
          last_name: p.x_passenger_last_name || null,
          sex: p.x_sex || null,                  // MALE / FEMALE
          marital_status: p.x_marrital_status || null, // SINGLE/MARRIED/...
          date_of_birth: p.x_date_of_birth || null,
          nationality: p.x_nationality || null,

          // contact
          email: p.x_passenger_email || null,
          home_address: p.x_home_address || null,
          job_position: p.x_job_position || null,
          working_at: p.x_working_at || null,

          // travel / rooming
          departure_m2o: dep1,
          tour_departure_m2o: dep2,
          type_of_room: p.x_type_of_room || null,
          sharing_with: p.x_sharing_with || null,
          pre_tour_extra_night: p.x_pre_tour_extra_night || null,
          post_tour_extra_night: p.x_post_tour_extra_night || null,
          flight_arrival: p.x_flight_arrival || null,
          flight_departure: p.x_flight_departure || null,

          // health / diet
          diet: p.x_diet || null,
          allergies: p.x_allergies || null,
          medical_conditions: p.x_medical_conditions || null,

          // emergency
          emergency_contact: p.x_emergency_contact || null,
          emergency_contact_number: p.x_emergency_contact_number || null,

          // passport
          passport_number: p.x_passport_number || '',
          passport_issue_date: p.x_passport_issue_date || null,
          passport_expiry_date: p.x_passport_expiry_date || null,

          // misc
          notes: p.x_notes || null
        };
      });

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          status: 'ok',
          departure: departureInfo,      // <-- tour name + dates, per token
          passengers: mappedPassengers
        }),
      };
    }

    // ==============================
    //  SAVE
    // ==============================
    if (action === 'save') {
      if (!Array.isArray(passengers)) {
        return {
          statusCode: 400,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: 'Missing passengers array for save action' }),
        };
      }

      // Verify token still maps to existing passengers
      const existing = await odooSearchRead(
        ODOO_URL,
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        'x_tour_departure_passenger',
        [
          ['x_studio_test_token', '=', token]
        ],
        ['id']
      );

      const validIds = new Set((existing || []).map(p => p.id));

      // For each passenger payload, update allowed fields
      for (const p of passengers) {
        if (!p.id || !validIds.has(p.id)) {
          // Ignore unknown / mismatched IDs for safety
          continue;
        }

        const vals = {};

        // Currently: only passport_number is editable.
        // Add more fields here later as needed.

        if (typeof p.passport_number === 'string') {
          vals['x_passport_number'] = p.passport_number;
        }

        /*
        // Examples of additional editable fields:
        if (typeof p.diet === 'string') vals['x_diet'] = p.diet;
        if (typeof p.allergies === 'string') vals['x_allergies'] = p.allergies;
        if (typeof p.medical_conditions === 'string') vals['x_medical_conditions'] = p.medical_conditions;
        if (typeof p.emergency_contact === 'string') vals['x_emergency_contact'] = p.emergency_contact;
        if (typeof p.emergency_contact_number === 'string') vals['x_emergency_contact_number'] = p.emergency_contact_number;
        if (typeof p.nationality === 'string') vals['x_nationality'] = p.nationality;
        if (typeof p.notes === 'string') vals['x_notes'] = p.notes;
        if (typeof p.pre_tour_extra_night === 'string') vals['x_pre_tour_extra_night'] = p.pre_tour_extra_night;
        if (typeof p.post_tour_extra_night === 'string') vals['x_post_tour_extra_night'] = p.post_tour_extra_night;
        if (typeof p.type_of_room === 'string') vals['x_type_of_room'] = p.type_of_room;
        */

        if (Object.keys(vals).length === 0) {
          continue;
        }

        await odooWrite(
          ODOO_URL,
          ODOO_DB,
          uid,
          ODOO_API_KEY,
          'x_tour_departure_passenger',
          p.id,
          vals
        );
      }

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ status: 'ok' }),
      };
    }

    // --- Unknown action ---
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unknown action' }),
    };

  } catch (err) {
    console.error('Netlify function error:', err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Server error', details: String(err) }),
    };
  }
}

// ---------- Helper functions for Odoo JSON-RPC ----------

async function odooJsonRpc(odooUrl, body) {
  const res = await fetch(`${odooUrl}/jsonrpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
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
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'common',
      method: 'authenticate',
      args: [db, username, apiKey, {}]
    }
  };
  const result = await odooJsonRpc(odooUrl, payload);
  return result; // uid or false
}

async function odooSearchRead(odooUrl, db, uid, apiKey, model, domain, fields) {
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [
        db,
        uid,
        apiKey,
        model,
        'search_read',
        [domain],
        { fields: fields }
      ]
    }
  };
  const result = await odooJsonRpc(odooUrl, payload);
  return result; // array of records
}

async function odooWrite(odooUrl, db, uid, apiKey, model, id, vals) {
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [
        db,
        uid,
        apiKey,
        model,
        'write',
        [[id], vals]
      ]
    }
  };
  const result = await odooJsonRpc(odooUrl, payload);
  return result; // true/false
}
