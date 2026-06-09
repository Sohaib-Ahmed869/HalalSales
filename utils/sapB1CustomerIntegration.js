// utils/sapB1CustomerIntegration.js
const axios = require("axios");
const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

// SAP B1 Service Layer Configuration
const SAP_CONFIG = {
  serviceLayerUrl: process.env.SAP_SERVICE_LAYER_URL,
  companyDB: process.env.COMPANY_DB,
  username: process.env.USER_NAME,
  password: process.env.PASSWORD,
};

// Set this to true to enable automatic SAP sync
const ENABLE_SAP_SYNC = true;

// Session management (reuse from your existing SAP integration)
let sessionId = null;
let sessionTimeout = null;

// Login to SAP B1 Service Layer and get session ID
async function loginToSAP() {
  try {
    console.log("Logging in to SAP B1 Service Layer...");

    // Clear any existing session timeout
    if (sessionTimeout) {
      clearTimeout(sessionTimeout);
    }

    const loginData = {
      CompanyDB: SAP_CONFIG.companyDB,
      UserName: SAP_CONFIG.username,
      Password: SAP_CONFIG.password,
    };

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/Login`,
      loginData,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // Extract session ID from cookies
    const cookies = response.headers["set-cookie"];
    if (!cookies) {
      throw new Error("No cookies returned from SAP B1 login");
    }

    // Parse session ID from cookies
    const sessionCookie = cookies.find((cookie) =>
      cookie.includes("B1SESSION=")
    );
    if (!sessionCookie) {
      throw new Error("B1SESSION cookie not found");
    }

    sessionId = sessionCookie.split(";")[0].replace("B1SESSION=", "");

    // Set session timeout (25 minutes)
    sessionTimeout = setTimeout(() => {
      sessionId = null;
    }, 25 * 60 * 1000);

    console.log("Successfully logged in to SAP B1 Service Layer");
    return sessionId;
  } catch (error) {
    console.error("Error logging in to SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);
    }
    throw new Error(`SAP Login Error: ${error.message}`);
  }
}

// Get a valid session ID (login if necessary)
async function getSessionId() {
  if (!sessionId) {
    return await loginToSAP();
  }
  return sessionId;
}

// Get the last customer from SAP B1
exports.getLastCustomerFromSAP = async () => {
  try {
    const sessionId = await getSessionId();

    console.log("Fetching last customer from SAP B1...");

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/BusinessPartners?$top=1&$orderby=CardCode desc&$filter=CardType eq 'cCustomer'`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    if (
      response.data &&
      response.data.value &&
      response.data.value.length > 0
    ) {
      const lastCustomer = response.data.value[0];
      console.log(`Last customer CardCode: ${lastCustomer.CardCode}`);
      return lastCustomer;
    }

    console.log("No customers found in SAP B1");
    return null;
  } catch (error) {
    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getLastCustomerFromSAP();
    }

    console.error("Error fetching last customer from SAP:", error.message);
    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Codes at or above this value are reserved/special accounts (e.g. C9996,
// C9998, C9999) and must NOT be treated as part of the sequential customer
// range. The historical corrupt code C71000 (71000) is also excluded by this.
const RESERVED_CARDCODE_THRESHOLD = 9000;

// Generate next CardCode based on the highest sequential customer code.
//
// IMPORTANT: We compute the maximum NUMERICALLY in JS. The SAP Service Layer's
// `$orderby=CardCode desc` sorts CardCode as a STRING, which is unreliable once
// codes differ in digit width (e.g. "C7999" > "C71000" lexicographically). The
// old code also hardcoded a "C7" prefix and only incremented the 3 trailing
// digits, so C7999 overflowed to "C71000" instead of rolling over to "C8000" —
// and because C71000 sorts below C7999, every new customer got "C71000" forever.
// @param {number} floorExclusive - optional. The returned code is guaranteed to
//   be strictly greater than this number. Used by the collision-retry allocator
//   so a duplicate attempt advances past the taken code instead of re-reading
//   the same max.
exports.generateNextCardCode = async (floorExclusive = -1) => {
  try {
    const sessionId = await getSessionId();

    console.log("Fetching customer CardCodes from SAP B1 to compute next code...");

    // Fetch a generous window of the highest codes. The reserved C9xxx codes and
    // any legacy corrupt codes sort near the top/bottom in string order, so a
    // large window guarantees the true sequential max is included; we then pick
    // the max numerically and ignore the reserved band.
    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/BusinessPartners?$top=200&$select=CardCode&$orderby=CardCode desc&$filter=CardType eq 'cCustomer' and startswith(CardCode,'C')`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    if (
      response.data &&
      response.data.value &&
      response.data.value.length > 0
    ) {
      // Parse pure-numeric "C<digits>" codes, drop the reserved band, find max.
      let maxNumber = -1;
      for (const bp of response.data.value) {
        const match = bp.CardCode && bp.CardCode.match(/^C(\d+)$/);
        if (!match) continue;
        const num = parseInt(match[1], 10);
        if (num >= RESERVED_CARDCODE_THRESHOLD) continue; // skip reserved/corrupt
        if (num > maxNumber) maxNumber = num;
      }

      // Honour the caller's floor (collision retry) as well as the SAP max.
      const baseNumber = Math.max(maxNumber, floorExclusive);

      if (baseNumber >= 0) {
        const nextNumber = baseNumber + 1;

        if (nextNumber >= RESERVED_CARDCODE_THRESHOLD) {
          throw new Error(
            `Sequential CardCode range exhausted (next would be C${nextNumber}, ` +
              `which collides with the reserved C${RESERVED_CARDCODE_THRESHOLD}+ band). ` +
              `Manual intervention required to choose a new range.`
          );
        }

        const nextCardCode = `C${nextNumber}`;
        console.log(
          `Highest sequential CardCode: C${maxNumber} -> next: ${nextCardCode}`
        );
        return nextCardCode;
      }
    }

    // No sequential customers found at all — start the range.
    console.log("No sequential C-customers found, starting with C7000");
    return "C7000";
  } catch (error) {
    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.generateNextCardCode();
    }

    console.error("Error generating next CardCode:", error.message);

    // IMPORTANT: Throw error instead of returning fallback
    // This prevents all customers from getting the same code
    throw new Error(`Failed to generate CardCode from SAP: ${error.message}`);
  }
};

// Detect SAP B1 "CardCode already exists" style errors so the allocator can
// retry with the next code instead of stranding the customer.
function isDuplicateCardCodeError(error) {
  const data = error && error.response && error.response.data;
  const sapMsg =
    data && data.error && data.error.message && data.error.message.value;
  const sapCode = data && data.error && data.error.code;
  const text = `${sapMsg || ""} ${error && error.message ? error.message : ""}`.toLowerCase();
  return (
    sapCode === -2035 || // SAP: "Business partner ... already exists"
    text.includes("already exist") ||
    text.includes("-2035")
  );
}

// Format customer data for SAP B1
// Format customer data for SAP B1
exports.formatCustomerForSAP = async (customer) => {
  const sapCustomer = {
    CardCode: customer.CardCode || "", // Use existing CardCode or generate a new one
    CardName: customer.CardName,
    CardType: "cCustomer",

    // Contact Information
    EmailAddress: customer.Email,
    Phone1: customer.phoneNumber || "",

    // Default SAP values (you can customize these)
    GroupCode: 110,
    Currency: "EUR", // Euro currency as requested
    PayTermsGrpCode: -1, // Default payment terms - adjust as needed
    PriceListNum: 2,

    // Additional phone numbers
    Phone2:
      customer.additionalPhoneNumbers &&
        customer.additionalPhoneNumbers.length > 0
        ? customer.additionalPhoneNumbers[0]
        : "",
    // Status
    Valid: customer.status === "active" ? "tYES" : "tNO",
    Frozen: customer.status === "inactive" ? "tYES" : "tNO",
  };

  // Add contact persons if we have detailed contact info
  if (customer.firstName || customer.lastName) {
    sapCustomer.ContactEmployees = [
      {
        Name: `${customer.firstName || ""} ${customer.lastName || ""}`.trim(),
        Phone1: customer.phoneNumber || "",
        E_Mail: customer.Email || "",
        Active: "tYES",
      },
    ];
  }

  // Add addresses array if address exists
  if (customer.address) {
    sapCustomer.BPAddresses = [
      {
        AddressName: "Bill To",
        AddressType: "bo_BillTo",
        Street: customer.address.street || "",
        ZipCode: customer.address.zipCode || "",
        City: customer.address.city || "",
        Country: "FR",
      },
      {
        AddressName: "Ship To",
        AddressType: "bo_ShipTo",
        Street: customer.address.street || "",
        ZipCode: customer.address.zipCode || "",
        City: customer.address.city || "",
        Country: "FR",
      },
    ];
  }

  console.log("Formatted customer for SAP:", {
    CardCode: sapCustomer.CardCode,
    CardName: sapCustomer.CardName,
    EmailAddress: sapCustomer.EmailAddress,
    GroupCode: sapCustomer.GroupCode,
    Currency: sapCustomer.Currency,
  });

  return sapCustomer;
};
// Create a customer in SAP B1
exports.createCustomerInSAP = async (customerData) => {
  try {
    // Skip SAP sync if disabled
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync is disabled. Skipping customer creation in SAP.");
      return {
        simulated: true,
        message: "SAP sync is disabled",
        CardCode: customerData.CardCode,
      };
    }

    const sessionId = await getSessionId();

    console.log("Creating customer in SAP B1...");

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/BusinessPartners`,
      customerData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Customer created successfully in SAP B1");
    return response.data;
  } catch (error) {
    console.error("Error creating customer in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);

      // Log detailed error information
      if (
        error.response.data &&
        error.response.data.error &&
        error.response.data.error.message
      ) {
        console.error(
          "Error field details:",
          error.response.data.error.message.value
        );
      }
    }

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.createCustomerInSAP(customerData);
    }

    const wrapped = new Error(`SAP Error: ${error.message}`);
    wrapped.isDuplicateCardCode = isDuplicateCardCodeError(error);
    wrapped.sapErrorData = error.response && error.response.data;
    throw wrapped;
  }
};

// Allocate a guaranteed-unique CardCode and create the customer in SAP B1 in one
// atomic, self-healing operation.
//
// This is the single safe entry point for first-time SAP creation. It prevents
// the "everyone gets the same CardCode" class of bug for good:
//   - Concurrent approvals that read the same SAP max will collide on POST; the
//     loser retries with the next code instead of silently failing.
//   - A stale/duplicate code never persists, because the local CardCode is only
//     committed to what SAP actually accepted.
//
// Returns the SAP response (including the final CardCode). Sets customer.CardCode
// to the accepted code. Throws if a unique code cannot be allocated.
exports.createCustomerInSAPWithUniqueCode = async (customer, formatFn) => {
  const MAX_ATTEMPTS = 15;
  let floorExclusive = -1;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const cardCode = await exports.generateNextCardCode(floorExclusive);
    customer.CardCode = cardCode;

    const sapCustomer = await (formatFn || exports.formatCustomerForSAP)(customer);

    try {
      return await exports.createCustomerInSAP(sapCustomer);
    } catch (err) {
      if (err.isDuplicateCardCode) {
        const m = cardCode.match(/^C(\d+)$/);
        if (m) floorExclusive = parseInt(m[1], 10); // force advance past the taken code
        lastError = err;
        console.warn(
          `CardCode ${cardCode} already taken (attempt ${attempt}/${MAX_ATTEMPTS}), retrying with next...`
        );
        continue;
      }
      throw err; // non-collision error: surface it
    }
  }

  throw new Error(
    `Unable to allocate a unique CardCode after ${MAX_ATTEMPTS} attempts. ` +
      `Last error: ${lastError && lastError.message}`
  );
};

// Check if a customer exists in SAP
exports.checkCustomerExistsInSAP = async (cardCode) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Checking if customer ${cardCode} exists in SAP...`);

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/BusinessPartners('${cardCode}')`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log(`Customer ${cardCode} exists in SAP`);
    return true;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`Customer ${cardCode} does not exist in SAP`);
      return false;
    }

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.checkCustomerExistsInSAP(cardCode);
    }

    console.error("Error checking customer in SAP:", error.message);
    throw new Error(`SAP Error: ${error.message}`);
  }
};
