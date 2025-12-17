// netlify/functions/passenger.js

function buildCorsHeaders(event) {
  const allowedOrigins = new Set([
    'https://adventurebound.travel',
    'https://www.adventurebound.travel',
  ]);

  const origin = event?.headers?.origin || event?.headers?.Origin || '';
  const allowOrigin = allowedOrigins.has(origin)
    ? origin
    : 'https://www.adventurebound.travel';

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

// dd/mm/yyyy -> YYYY-MM-DD (Odoo date)
function toOdooDate(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const s = String(ddmmyyyy).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const dd = m[1], mm = m[2], yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeSex(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'male') return 'MALE';
  if (s === 'female') return 'FEMALE';
  if (s === 'rather not say' || s === 'rather_not_say' || s === 'prefer not to say') return 'RATHER_NOT_SAY';
  // if already in Odoo format, keep
  return String(v).trim();
}

function normalizeMaritalStatus(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'single') return 'SINGLE';
  if (s === 'married') return 'MARRIED';
  if (s === 'rather not say' || s === 'rather_not_say' || s === 'prefer not to say') return 'RATHER_NOT_SAY';
  return String(v).trim();
}

export async function handler(event, context) {
  const CORS_HEADERS = buildCorsHeaders(event);

  // --- CORS preflight ---
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
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
    const uid = await odooAuthenticate(ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY);

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
      const passengersData = await odooSearchRead(
        ODOO_URL,
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        'x_tour_departure_passenger',
        [['x_studio_test_token', '=', token]],
        [
          // core linkage
          'x_studio_test_token',
          'x_partner_id',
          'x_departure_id', // <-- keep only this (x_tour_departure removed)

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
          'x_notes',
        ]
      );

      if (!passengersData || passengersData.length === 0) {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            status: 'not_found',
            message: 'No passengers found for this token',
          }),
        };
      }

      function m2oToObj(field) {
        if (Array.isArray(field) && field.length >= 2) return { id: field[0], name: field[1] };
        return null;
      }

      // Departure (from x_departure_id only)
      let departureInfo = null;
      const first = passengersData[0];
      const depField = first?.x_departure_id;

      if (Array.isArray(depField) && depField.length >= 1) {
        const depId = depField[0];

        const departures = await odooSearchRead(
          ODOO_URL,
          ODOO_DB,
          uid,
          ODOO_API_KEY,
          'x_tour_departure',
          [['id', '=', depId]],
          ['x_name', 'x_departure_date', 'x_end_date']
        );

        if (departures && departures.length > 0) {
          const d = departures[0];
          departureInfo = {
            id: d.id,
            name: d.x_name || null,
            start_date: d.x_departure_date || null,
            end_date: d.x_end_date || null,
          };
        }
      }

      const mappedPassengers = passengersData.map(p => {
        const partner = m2oToObj(p.x_partner_id);
        const dep = m2oToObj(p.x_departure_id);

        return {
          id: p.id,
          token: p.x_studio_test_token || null,

          partner,
          departure_m2o: dep,

          name: p.x_name || (partner && partner.name) || null,
          first_name: p.x_passenger_first_name || null,
          middle_name: p.x_passenger_middle_name || null,
          last_name: p.x_passenger_last_name || null,
          sex: p.x_sex || null,
          marital_status: p.x_marrital_status || null,
          date_of_birth: p.x_date_of_birth || null,
          nationality: p.x_nationality || null,

          email: p.x_passenger_email || null,
          home_address: p.x_home_address || null,
          job_position: p.x_job_position || null,
          working_at: p.x_working_at || null,

          type_of_room: p.x_type_of_room || null,
          sharing_with: p.x_sharing_with || null,
          pre_tour_extra_night: p.x_pre_tour_extra_night || null,
          post_tour_extra_night: p.x_post_tour_extra_night || null,
          flight_arrival: p.x_flight_arrival || null,
          flight_departure: p.x_flight_departure || null,

          diet: p.x_diet || null,
          allergies: p.x_allergies || null,
          medical_conditions: p.x_medical_conditions || null,

          emergency_contact: p.x_emergency_contact || null,
          emergency_contact_number: p.x_emergency_contact_number || null,

          passport_number: p.x_passport_number || '',
          passport_issue_date: p.x_passport_issue_date || null,
          passport_expiry_date: p.x_passport_expiry_date || null,

          notes: p.x_notes || null,
        };
      });

      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          status: 'ok',
          departure: departureInfo,
          passengers: mappedPassengers,
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
        [['x_studio_test_token', '=', token]],
        ['id']
      );

      const validIds = new Set((existing || []).map(p => p.id));

      for (const p of passengers) {
        if (!p.id || !validIds.has(p.id)) continue;

        const vals = {};

        // Names
        if (typeof p.first_name === 'string') vals['x_passenger_first_name'] = p.first_name;
        if (typeof p.middle_name === 'string') vals['x_passenger_middle_name'] = p.middle_name;
        if (typeof p.last_name === 'string') vals['x_passenger_last_name'] = p.last_name;

        // Select fields
        if (p.sex != null) vals['x_sex'] = normalizeSex(p.sex);
        if (p.marital_status != null) vals['x_marrital_status'] = normalizeMaritalStatus(p.marital_status);

        // Dates (dd/mm/yyyy -> YYYY-MM-DD)
        if (p.date_of_birth != null) {
          const d = toOdooDate(p.date_of_birth) || p.date_of_birth; // allow already-ISO
          vals['x_date_of_birth'] = d;
        }
        if (p.passport_issue_date != null) {
          const d = toOdooDate(p.passport_issue_date) || p.passport_issue_date;
          vals['x_passport_issue_date'] = d;
        }
        if (p.passport_expiry_date != null) {
          const d = toOdooDate(p.passport_expiry_date) || p.passport_expiry_date;
          vals['x_passport_expiry_date'] = d;
        }

        // Contact
        if (typeof p.email === 'string') vals['x_passenger_email'] = p.email;
        if (typeof p.nationality === 'string') vals['x_nationality'] = p.nationality;
        if (typeof p.home_address === 'string') vals['x_home_address'] = p.home_address;
        if (typeof p.job_position === 'string') vals['x_job_position'] = p.job_position;
        if (typeof p.working_at === 'string') vals['x_working_at'] = p.working_at;

        // Passport number
        if (typeof p.passport_number === 'string') vals['x_passport_number'] = p.passport_number;

        // Misc
        if (typeof p.notes === 'string') vals['x_notes'] = p.notes;

        if (Object.keys(vals).length === 0) continue;

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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
      args: [db, username, apiKey, {}],
    },
  };
  return await odooJsonRpc(odooUrl, payload);
}

async function odooSearchRead(odooUrl, db, uid, apiKey, model, domain, fields) {
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [db, uid, apiKey, model, 'search_read', [domain], { fields }],
    },
  };
  return await odooJsonRpc(odooUrl, payload);
}

async function odooWrite(odooUrl, db, uid, apiKey, model, id, vals) {
  const payload = {
    jsonrpc: '2.0',
    method: 'call',
    params: {
      service: 'object',
      method: 'execute_kw',
      args: [db, uid, apiKey, model, 'write', [[id], vals]],
    },
  };
  return await odooJsonRpc(odooUrl, payload);
}
