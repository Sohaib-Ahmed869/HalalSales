// utils/sapB1Integration.js - Complete rewrite with minimal approach
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

// Session management
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

    // Set session timeout (SAP B1 sessions typically expire after 30 minutes)
    // We'll set it to refresh after 25 minutes to be safe
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

exports.loginToSAP = loginToSAP;

// Check if a business partner exists in SAP
exports.checkBusinessPartnerExists = async (cardCode) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Checking if business partner ${cardCode} exists in SAP...`);

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/BusinessPartners('${cardCode}')`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    // If we get here, the business partner exists
    console.log(`Business partner ${cardCode} exists in SAP`);
    return true;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`Business partner ${cardCode} does not exist in SAP`);
      return false;
    }

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.checkBusinessPartnerExists(cardCode);
    }

    console.error("Error checking business partner in SAP:", error.message);
    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Add this function to utils/sapB1Integration.js

// Get the next available DocNum from SAP B1
exports.getNextDocNumFromSAP = async () => {
  try {
    const sessionId = await getSessionId();

    console.log("Fetching next DocNum from SAP B1...");

    // Get the last order to find the highest DocNum
    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Orders?$select=DocNum&$orderby=DocNum desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocNum = 1; // Default if no orders exist

    if (
      response.data &&
      response.data.value &&
      response.data.value.length > 0
    ) {
      const lastDocNum = response.data.value[0].DocNum;
      nextDocNum = lastDocNum + 1;
      console.log(
        `Last DocNum in SAP: ${lastDocNum}, Next DocNum: ${nextDocNum}`
      );
    } else {
      console.log("No existing orders found in SAP, starting with DocNum: 1");
    }

    return nextDocNum;
  } catch (error) {
    console.error("Error getting next DocNum from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getNextDocNumFromSAP();
    }

    // If we can't get DocNum from SAP, fall back to local calculation
    console.warn("Falling back to local DocNum calculation");
    return null;
  }
};

// Alternative function to get series information if you want to use a specific numbering series
exports.getNextDocNumFromSeries = async (seriesCode = null) => {
  try {
    const sessionId = await getSessionId();

    console.log("Fetching next DocNum from SAP B1 series...");

    let url = `${SAP_CONFIG.serviceLayerUrl}/SeriesService_GetDocumentSeries?DocumentTypeParams='13'`; // 13 = Sales Order

    if (seriesCode) {
      url += `&SeriesParams='${seriesCode}'`;
    }

    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        Cookie: `B1SESSION=${sessionId}`,
      },
    });

    if (
      response.data &&
      response.data.value &&
      response.data.value.length > 0
    ) {
      const series = response.data.value[0];
      const nextDocNum = series.NextNumber;
      console.log(`Next DocNum from SAP series: ${nextDocNum}`);
      return nextDocNum;
    }

    return null;
  } catch (error) {
    console.error("Error getting next DocNum from SAP series:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getNextDocNumFromSeries(seriesCode);
    }

    return null;
  }
};

// Format order data specifically for UPDATES (much more restrictive)
exports.formatOrderForSAPUpdate = async (order) => {
  // For updates, ONLY send fields that SAP B1 allows updating
  // CRITICAL: Never include CardCode in updates - SAP doesn't allow changing customer
  const sapUpdateData = {
    Comments: order.Comments || "",
    DocumentLines: []
  };

  // ✅ ADD: Only include U_Notes if it exists
  if (order.U_Notes) {
    sapUpdateData.U_Notes = order.U_Notes;
  }

  // Process document lines with ONLY updateable fields
  if (order.DocumentLines && Array.isArray(order.DocumentLines)) {
    sapUpdateData.DocumentLines = order.DocumentLines.map((line, index) => ({
      LineNum: index,
      ItemCode: line.ItemCode,
      ItemDescription: line.ItemDescription || "",
      Quantity: Number(line.Quantity || 0),
      UnitPrice: Number(line.Price || 0),
      // ✅ REMOVED: PriceList - cannot be updated after creation
      // ✅ REMOVED: Any base document references
    }));
  }

  console.log("SAP Order Update formatted:", {
    Comments: sapUpdateData.Comments,
    DocumentLines: sapUpdateData.DocumentLines.length,
    hasUNotes: !!sapUpdateData.U_Notes
  });

  return sapUpdateData;
};

exports.formatOrderForSAP = async (order) => {
  const today = new Date();

  // Create SAP order with price list information
  const sapOrder = {
    CardCode: order.CardCode,
    DocDate: order.DocDate || today,
    DocDueDate: order.DocDueDate || today,
    Comments: order.Comments || "",
    U_Notes: order.U_Notes || "",
    RequriedDate: order.RequriedDate || order.StartDeliveryDate || today,


    // CRITICAL FIX: Include price list at document level
    PriceList: order.PriceList ? parseInt(order.PriceList, 10) : 2,

    // *** NEW: Let SAP handle DocNum automatically ***
    // Don't specify DocNum - let SAP assign it according to its numbering series
    // This ensures alignment with SAP's internal numbering

    DocumentLines: [],
  };

  // Process document lines with price list information
  if (order.DocumentLines && Array.isArray(order.DocumentLines)) {
    sapOrder.DocumentLines = order.DocumentLines.map((line, index) => {
      const sapLine = {
        ItemCode: line.ItemCode,
        Quantity: Number(line.Quantity || 0),
        UnitPrice: Number(line.Price || 0),
        ItemDescription: line.ItemDescription || "",

        // CRITICAL FIX: Include price list for each line
        PriceList: line.PriceList
          ? parseInt(line.PriceList, 10)
          : order.PriceList
            ? parseInt(order.PriceList, 10)
            : 2,

        // Optional: Include line number for tracking
        LineNum: index,
      };

      return sapLine;
    });
  }

  // Add custom field if salesAgent exists
  if (order.salesAgent) {
    sapOrder.U_SalesAgentId = order.salesAgent.toString();
  }

  // Add reference to local DocNum for tracking
  if (order.DocNum) {
    sapOrder.U_LocalDocNum = order.DocNum.toString();
  }

  // Log detailed information for debugging
  console.log("SAP Order formatted:", {
    CardCode: sapOrder.CardCode,
    PriceList: sapOrder.PriceList,
    U_LocalDocNum: sapOrder.DocNum,
    DocumentLines: sapOrder.DocumentLines.map((line) => ({
      ItemCode: line.ItemCode,
      UnitPrice: line.UnitPrice,
      PriceList: line.PriceList,
      Quantity: line.Quantity,
    })),
  });

  return sapOrder;
};

// NEW FUNCTION - Add this after formatOrderForSAP
exports.formatDeliveryNoteForSAP = async (deliveryNote, salesOrderDocEntry = null) => {
  const today = new Date();

  const sapDeliveryNote = {
    CardCode: deliveryNote.CardCode,
    DocDate: deliveryNote.DocDate || today,
    DocDueDate: deliveryNote.DocDueDate || today,
    Comments: deliveryNote.Comments || "",
    U_Notes: deliveryNote.U_Notes || "",
    PriceList: deliveryNote.PriceList ? parseInt(deliveryNote.PriceList, 10) : 2,
    DocumentLines: [],
  };

  // Process document lines with proper base document references
  if (deliveryNote.DocumentLines && Array.isArray(deliveryNote.DocumentLines)) {
    sapDeliveryNote.DocumentLines = deliveryNote.DocumentLines.map((line, index) => {
      const sapLine = {
        ItemCode: line.ItemCode,
        Quantity: Number(line.Quantity || 0),
        UnitPrice: Number(line.UnitPrice || line.Price || 0),
        ItemDescription: line.ItemDescription || "",
        PriceList: line.PriceList ? parseInt(line.PriceList, 10) :
          deliveryNote.PriceList ? parseInt(deliveryNote.PriceList, 10) : 2,
        LineNum: index,
      };

      // ✅ CRITICAL FIX: Include base document references to close the order in SAP
      if (salesOrderDocEntry && salesOrderDocEntry > 0) {
        sapLine.BaseType = 17; // 17 = Sales Order
        sapLine.BaseEntry = salesOrderDocEntry; // SAP's DocEntry for the order
        sapLine.BaseLine = line.BaseLine !== undefined ? line.BaseLine : index;

        console.log(`Line ${index}: Mapping to Order DocEntry ${salesOrderDocEntry}, Line ${sapLine.BaseLine}`);
      }

      return sapLine;
    });
  }

  // Add custom fields for tracking
  if (deliveryNote.DocNum) {
    sapDeliveryNote.U_LocalDocNum = deliveryNote.DocNum.toString();
  }

  if (deliveryNote.OriginatingOrder) {
    sapDeliveryNote.U_SourceOrderNum = deliveryNote.OriginatingOrder.toString();
  }

  console.log("SAP Delivery Note formatted with base document:", {
    CardCode: sapDeliveryNote.CardCode,
    BaseOrderDocEntry: salesOrderDocEntry,
    DocumentLines: sapDeliveryNote.DocumentLines.length,
    HasBaseReferences: sapDeliveryNote.DocumentLines.some(line => line.BaseType === 17)
  });

  return sapDeliveryNote;
};

// Create a sales order in SAP B1
exports.createSalesOrderInSAP = async (orderData) => {
  try {
    // Skip SAP sync if disabled (for testing/debugging purposes)
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync is disabled. Skipping order creation in SAP.");
      return {
        simulated: true,
        message: "SAP sync is disabled",
        DocEntry: Math.floor(Math.random() * 10000), // Simulate a DocEntry
        DocNum: Math.floor(Math.random() * 10000), // Simulate a DocNum
      };
    }

    const sessionId = await getSessionId();

    console.log("Creating sales order in SAP B1...");
    console.log("Order data being sent:", JSON.stringify(orderData, null, 2));

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/Orders`,
      orderData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Sales order created successfully in SAP B1");
    console.log("SAP Response:", {
      DocEntry: response.data.DocEntry,
      DocNum: response.data.DocNum,
      CardCode: response.data.CardCode,
    });

    return response.data;
  } catch (error) {
    console.error("Error creating sales order in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);

      // For debugging, log the full error details
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
      return exports.createSalesOrderInSAP(orderData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Get a sales order from SAP B1 by DocEntry
exports.getSalesOrderFromSAP = async (docEntry) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Fetching sales order ${docEntry} from SAP B1...`);

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Orders?$filter=DocNum eq ${docEntry}`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Sales order fetched successfully from SAP B1");
    return response.data.value && response.data.value.length > 0 ? response.data.value[0] : null;
  } catch (error) {
    console.error("Error fetching sales order from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getSalesOrderFromSAP(docEntry);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Fetch all sales orders from SAP with filters
exports.fetchSalesOrdersFromSAP = async (filters = {}) => {
  try {
    const sessionId = await getSessionId();

    let filterQuery = "";
    if (filters.fromDate) {
      filterQuery += `DocDate ge '${filters.fromDate}'`;
    }
    if (filters.toDate) {
      if (filterQuery) filterQuery += " and ";
      filterQuery += `DocDate le '${filters.toDate}'`;
    }

    const url = filterQuery
      ? `${SAP_CONFIG.serviceLayerUrl}/Orders?$filter=${filterQuery}`
      : `${SAP_CONFIG.serviceLayerUrl}/Orders`;

    console.log("Fetching orders from SAP:", url);

    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        Cookie: `B1SESSION=${sessionId}`,
      },
    });

    return response.data.value || [];
  } catch (error) {
    console.error("Error fetching orders from SAP:", error.message);
    if (error.response && error.response.status === 401) {
      sessionId = null;
      await getSessionId();
      return exports.fetchSalesOrdersFromSAP(filters);
    }
    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Fetch specific sales order from SAP
exports.getSalesOrderFromSAPByDocNum = async (docNum) => {
  try {
    const sessionId = await getSessionId();

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Orders?$filter=DocNum eq ${docNum}`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    return response.data.value?.[0] || null;
  } catch (error) {
    console.error("Error fetching order from SAP:", error.message);
    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Fetch all delivery notes from SAP with filters
exports.fetchDeliveryNotesFromSAP = async (filters = {}) => {
  try {
    const sessionId = await getSessionId();

    let filterQuery = "";
    if (filters.fromDate) {
      filterQuery += `DocDate ge '${filters.fromDate}'`;
    }
    if (filters.toDate) {
      if (filterQuery) filterQuery += " and ";
      filterQuery += `DocDate le '${filters.toDate}'`;
    }

    const url = filterQuery
      ? `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes?$filter=${filterQuery}`
      : `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes`;

    console.log("Fetching delivery notes from SAP:", url);

    const response = await axios.get(url, {
      headers: {
        "Content-Type": "application/json",
        Cookie: `B1SESSION=${sessionId}`,
      },
    });

    return response.data.value || [];
  } catch (error) {
    console.error("Error fetching delivery notes from SAP:", error.message);
    if (error.response && error.response.status === 401) {
      sessionId = null;
      await getSessionId();
      return exports.fetchDeliveryNotesFromSAP(filters);
    }
    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Fetch specific delivery note from SAP
exports.getDeliveryNoteFromSAPByDocNum = async (docNum) => {
  try {
    const sessionId = await getSessionId();

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes?$filter=DocNum eq ${docNum}`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    return response.data.value?.[0] || null;
  } catch (error) {
    console.error("Error fetching delivery note from SAP:", error.message);
    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Create a delivery note in SAP B1
exports.createDeliveryNoteInSAP = async (deliveryNoteData) => {
  try {
    // Skip SAP sync if disabled (for testing/debugging purposes)
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync is disabled. Skipping delivery note creation in SAP.");
      return {
        simulated: true,
        message: "SAP sync is disabled",
        DocEntry: Math.floor(Math.random() * 10000), // Simulate a DocEntry
        DocNum: Math.floor(Math.random() * 10000), // Simulate a DocNum
      };
    }

    const sessionId = await getSessionId();

    console.log("Creating delivery note in SAP B1...");
    console.log("Delivery note data being sent:", JSON.stringify(deliveryNoteData, null, 2));

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes`,
      deliveryNoteData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Delivery note created successfully in SAP B1");
    console.log("SAP Response:", {
      DocEntry: response.data.DocEntry,
      DocNum: response.data.DocNum,
      CardCode: response.data.CardCode,
    });

    return response.data;
  } catch (error) {
    console.error("Error creating delivery note in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);

      // For debugging, log the full error details
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
      return exports.createDeliveryNoteInSAP(deliveryNoteData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Get a delivery note from SAP B1 by DocEntry
exports.getDeliveryNoteFromSAP = async (docEntry) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Fetching delivery note ${docEntry} from SAP B1...`);

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes(${docEntry})`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Delivery note fetched successfully from SAP B1");
    return response.data;
  } catch (error) {
    console.error("Error fetching delivery note from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getDeliveryNoteFromSAP(docEntry);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Get the next available DocNum for Delivery Notes from SAP B1
exports.getNextDeliveryNoteDocNumFromSAP = async () => {
  try {
    const sessionId = await getSessionId();
    console.log("Fetching next Delivery Note DocNum from SAP B1...");

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes?$select=DocNum&$orderby=DocNum desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocNum = 1;

    if (response.data && response.data.value && response.data.value.length > 0) {
      const lastDocNum = response.data.value[0].DocNum;
      nextDocNum = lastDocNum + 1;
      console.log(`Last Delivery Note DocNum in SAP: ${lastDocNum}, Next DocNum: ${nextDocNum}`);
    } else {
      console.log("No existing delivery notes found in SAP, starting with DocNum: 1");
    }

    return nextDocNum;
  } catch (error) {
    console.error("Error getting next Delivery Note DocNum from SAP B1:", error.message);

    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getNextDeliveryNoteDocNumFromSAP();
    }

    console.warn("Falling back to local DocNum calculation for Delivery Note");
    return null;
  }
};

// Batch create delivery notes in SAP B1 (for bulk operations)
exports.bulkCreateDeliveryNotesInSAP = async (deliveryNotesData) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Creating ${deliveryNotesData.length} delivery notes in SAP B1...`);

    const results = {
      successful: [],
      failed: [],
    };

    // Process each delivery note
    for (let i = 0; i < deliveryNotesData.length; i++) {
      const deliveryNote = deliveryNotesData[i];

      try {
        console.log(`Processing delivery note ${i + 1}/${deliveryNotesData.length}...`);

        // ✅ FIX: Format the delivery note properly BEFORE sending to SAP
        const formattedDeliveryNote = await exports.formatDeliveryNoteForSAP(deliveryNote, null);

        const response = await axios.post(
          `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes`,
          formattedDeliveryNote,  // ✅ Send formatted data instead of raw data
          {
            headers: {
              "Content-Type": "application/json",
              Cookie: `B1SESSION=${sessionId}`,
            },
          }
        );

        results.successful.push({
          localDocNum: deliveryNote.U_LocalDocNum,
          sapDocEntry: response.data.DocEntry,
          sapDocNum: response.data.DocNum,
          cardCode: response.data.CardCode,
        });

        console.log(`✅ Delivery note created: DocEntry ${response.data.DocEntry}`);

      } catch (error) {
        console.error(`❌ Failed to create delivery note:`, error.message);

        results.failed.push({
          localDocNum: deliveryNote.U_LocalDocNum,
          cardCode: deliveryNote.CardCode,
          error: error.message,
        });

        // If unauthorized, re-login and continue
        if (error.response && error.response.status === 401) {
          console.log("Session expired during batch, re-logging in...");
          sessionId = null;
          await getSessionId();
        }
      }

      // Small delay between requests to avoid overwhelming SAP
      if (i < deliveryNotesData.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  } catch (error) {
    console.error("Error in bulk delivery note creation:", error.message);
    throw new Error(`SAP Bulk Error: ${error.message}`);
  }
};

// Get the next available DocNum for Invoices from SAP B1
exports.getNextInvoiceDocNumFromSAP = async () => {
  try {
    const sessionId = await getSessionId();
    console.log("Fetching next Invoice DocNum from SAP B1...");

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Invoices?$select=DocNum&$orderby=DocNum desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocNum = 1;

    if (response.data && response.data.value && response.data.value.length > 0) {
      const lastDocNum = response.data.value[0].DocNum;
      nextDocNum = lastDocNum + 1;
      console.log(`Last Invoice DocNum in SAP: ${lastDocNum}, Next DocNum: ${nextDocNum}`);
    } else {
      console.log("No existing invoices found in SAP, starting with DocNum: 1");
    }

    return nextDocNum;
  } catch (error) {
    console.error("Error getting next Invoice DocNum from SAP B1:", error.message);

    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getNextInvoiceDocNumFromSAP();
    }

    console.warn("Falling back to local DocNum calculation for Invoice");
    return null;
  }
};

exports.getNextInvoiceDocEntryFromSAP = async () => {
  try {
    const sessionId = await getSessionId();
    console.log("Fetching next Invoice DocEntry from SAP B1...");

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Invoices?$select=DocEntry&$orderby=DocEntry desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocEntry = 1;

    if (response.data && response.data.value && response.data.value.length > 0) {
      const lastDocEntry = response.data.value[0].DocEntry;
      nextDocEntry = lastDocEntry + 1;
      console.log(`Last Invoice DocEntry in SAP: ${lastDocEntry}, Next DocEntry: ${nextDocEntry}`);
    } else {
      console.log("No existing invoices found in SAP, starting with DocEntry: 1");
    }

    return nextDocEntry;
  } catch (error) {
    console.error("Error getting next Invoice DocEntry from SAP B1:", error.message);

    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getNextInvoiceDocEntryFromSAP();
    }

    console.warn("Falling back to local DocEntry calculation for Invoice");
    return null;
  }
};


// utils/sapB1Integration.js
// Replace createInvoiceInSAP function

exports.createInvoiceInSAP = async (invoiceData) => {
  try {
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync is disabled. Skipping invoice creation in SAP.");
      return {
        simulated: true,
        message: "SAP sync is disabled",
        DocEntry: Math.floor(Math.random() * 10000),
        DocNum: Math.floor(Math.random() * 10000),
      };
    }

    const sessionId = await getSessionId();

    console.log("Creating invoice in SAP B1...");

    // ✅ Clean the data - but PRESERVE base references
    const cleanInvoiceData = {
      CardCode: invoiceData.CardCode,
      DocDate: invoiceData.DocDate,
      DocDueDate: invoiceData.DocDueDate,
      DocCurrency: invoiceData.DocCurrency,
      DocumentStatus: "bost_Open",
      Comments: invoiceData.Comments,
      U_Notes: invoiceData.U_Notes,
      DocumentLines: invoiceData.DocumentLines.map((line, index) => {
        const cleanLine = {
          ItemCode: line.ItemCode,
          ItemDescription: line.ItemDescription,
          Quantity: Number(line.Quantity),
          UnitPrice: Number(line.UnitPrice),
          LineNum: index
        };

        // ✅ CRITICAL FIX: Preserve base document references if they exist
        if (line.BaseType !== undefined && line.BaseType !== null) {
          cleanLine.BaseType = Number(line.BaseType);
          cleanLine.BaseEntry = Number(line.BaseEntry);
          cleanLine.BaseLine = Number(line.BaseLine !== undefined ? line.BaseLine : index);
        }

        return cleanLine;
      })
    };

    // Add custom fields if they exist
    if (invoiceData.U_SourceDeliveryNote) {
      cleanInvoiceData.U_SourceDeliveryNote = invoiceData.U_SourceDeliveryNote;
    }

    console.log("Clean invoice data:", JSON.stringify(cleanInvoiceData, null, 2));

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/Invoices`,
      cleanInvoiceData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Invoice created successfully in SAP B1");
    console.log("SAP Response:", {
      DocEntry: response.data.DocEntry,
      DocNum: response.data.DocNum,
      CardCode: response.data.CardCode,
    });

    return response.data;
  } catch (error) {
    console.error("Error creating invoice in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);
      if (error.response.data?.error?.message) {
        console.error("Error message:", error.response.data.error.message.value);
      }
    }

    if (error.response?.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.createInvoiceInSAP(invoiceData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Get an invoice from SAP B1 by DocEntry
exports.getInvoiceFromSAP = async (docEntry) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Fetching invoice ${docEntry} from SAP B1...`);

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Invoices(${docEntry})`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Invoice fetched successfully from SAP B1");
    return response.data;
  } catch (error) {
    console.error("Error fetching invoice from SAP B1:", error.message);

    // If unauthorized, try to login again and retry once
    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.getInvoiceFromSAP(docEntry);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Batch create invoices in SAP B1 (for bulk operations)
exports.bulkCreateInvoicesInSAP = async (invoicesData) => {
  try {
    const sessionId = await getSessionId();

    console.log(`Creating ${invoicesData.length} invoices in SAP B1...`);

    const results = {
      successful: [],
      failed: [],
    };

    // Process each invoice
    for (let i = 0; i < invoicesData.length; i++) {
      const invoice = invoicesData[i];

      try {
        console.log(`Processing invoice ${i + 1}/${invoicesData.length}...`);

        const response = await axios.post(
          `${SAP_CONFIG.serviceLayerUrl}/Invoices`,
          invoice,
          {
            headers: {
              "Content-Type": "application/json",
              Cookie: `B1SESSION=${sessionId}`,
            },
          }
        );

        results.successful.push({
          localDocNum: invoice.U_LocalDocNum,
          sapDocEntry: response.data.DocEntry,
          sapDocNum: response.data.DocNum,
          cardCode: response.data.CardCode,
        });

        console.log(`✅ Invoice created: DocEntry ${response.data.DocEntry}`);

      } catch (error) {
        console.error(`❌ Failed to create invoice:`, error.message);

        results.failed.push({
          localDocNum: invoice.U_LocalDocNum,
          cardCode: invoice.CardCode,
          error: error.message,
        });

        // If unauthorized, re-login and continue
        if (error.response && error.response.status === 401) {
          console.log("Session expired during batch, re-logging in...");
          sessionId = null;
          await getSessionId();
        }
      }

      // Small delay between requests to avoid overwhelming SAP
      if (i < invoicesData.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  } catch (error) {
    console.error("Error in bulk invoice creation:", error.message);
    throw new Error(`SAP Bulk Error: ${error.message}`);
  }
};

// ============================================
// RETURNS FUNCTIONS - CORRECTED
// ============================================

// Get next Return DocNum from SAP
exports.getNextReturnDocNumFromSAP = async () => {
  try {
    const sessionId = await getSessionId();
    console.log("Fetching next Return DocNum from SAP B1...");

    // ✅ CORRECT ENDPOINT: Returns (not ReturnsService)
    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Returns?$select=DocNum&$orderby=DocNum desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocNum = 1;
    if (response.data?.value?.length > 0) {
      const lastDocNum = response.data.value[0].DocNum;
      nextDocNum = lastDocNum + 1;
      console.log(`Last Return DocNum in SAP: ${lastDocNum}, Next: ${nextDocNum}`);
    } else {
      console.log("No existing returns found in SAP, starting with DocNum: 1");
    }

    return nextDocNum;
  } catch (error) {
    console.error("Error getting next Return DocNum:", error.message);
    if (error.response?.status === 401) {
      sessionId = null;
      await getSessionId();
      return exports.getNextReturnDocNumFromSAP();
    }
    console.warn("Falling back to local DocNum calculation for Return");
    return null;
  }
};

// Create Return in SAP
exports.createReturnInSAP = async (returnData) => {
  try {
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync disabled. Simulating return creation.");
      return {
        simulated: true,
        DocEntry: Math.floor(Math.random() * 10000),
        DocNum: Math.floor(Math.random() * 10000),
      };
    }

    const sessionId = await getSessionId();
    console.log("Creating return in SAP B1 with base document references...");
    console.log("Return data being sent:", JSON.stringify(returnData, null, 2));

    // ✅ CORRECT ENDPOINT: Returns
    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/Returns`,
      returnData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Return created successfully in SAP B1");
    console.log("SAP Response:", {
      DocEntry: response.data.DocEntry,
      DocNum: response.data.DocNum,
      CardCode: response.data.CardCode,
    });

    return response.data;
  } catch (error) {
    console.error("Error creating return in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);

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

    if (error.response?.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.createReturnInSAP(returnData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// ============================================
// CREDIT NOTES FUNCTIONS
// ============================================

// Get next Credit Note DocNum from SAP
exports.getNextCreditNoteDocNumFromSAP = async () => {
  try {
    const sessionId = await getSessionId();
    console.log("Fetching next Credit Note DocNum from SAP B1...");

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/CreditNotes?$select=DocNum&$orderby=DocNum desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocNum = 1;
    if (response.data?.value?.length > 0) {
      const lastDocNum = response.data.value[0].DocNum;
      nextDocNum = lastDocNum + 1;
      console.log(`Last Credit Note DocNum in SAP: ${lastDocNum}, Next: ${nextDocNum}`);
    }

    return nextDocNum;
  } catch (error) {
    console.error("Error getting next Credit Note DocNum:", error.message);
    if (error.response?.status === 401) {
      sessionId = null;
      await getSessionId();
      return exports.getNextCreditNoteDocNumFromSAP();
    }
    return null;
  }
};

// Create Credit Note in SAP
exports.createCreditNoteInSAP = async (creditNoteData) => {
  try {
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync disabled. Simulating credit note creation.");
      return {
        simulated: true,
        DocEntry: Math.floor(Math.random() * 10000),
        DocNum: Math.floor(Math.random() * 10000),
      };
    }

    const sessionId = await getSessionId();
    console.log("Creating credit note in SAP B1 with base document references...");
    console.log("Credit note data being sent:", JSON.stringify(creditNoteData, null, 2));

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/CreditNotes`,
      creditNoteData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Credit note created successfully in SAP B1");
    console.log("SAP Response:", {
      DocEntry: response.data.DocEntry,
      DocNum: response.data.DocNum,
      CardCode: response.data.CardCode,
    });

    return response.data;
  } catch (error) {
    console.error("Error creating credit note in SAP:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);

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

    if (error.response?.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.createCreditNoteInSAP(creditNoteData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Get next Credit Note DocNum from SAP - ✅ VERIFIED CORRECT
exports.getNextCreditNoteDocNumFromSAP = async () => {
  try {
    const sessionId = await getSessionId();
    console.log("Fetching next Credit Note DocNum from SAP B1...");

    const response = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/CreditNotes?$select=DocNum&$orderby=DocNum desc&$top=1`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    let nextDocNum = 1;
    if (response.data?.value?.length > 0) {
      const lastDocNum = response.data.value[0].DocNum;
      nextDocNum = lastDocNum + 1;
      console.log(`Last Credit Note DocNum in SAP: ${lastDocNum}, Next: ${nextDocNum}`);
    } else {
      console.log("No existing credit notes found in SAP, starting with DocNum: 1");
    }

    return nextDocNum;
  } catch (error) {
    console.error("Error getting next Credit Note DocNum:", error.message);
    if (error.response?.status === 401) {
      sessionId = null;
      await getSessionId();
      return exports.getNextCreditNoteDocNumFromSAP();
    }
    console.warn("Falling back to local DocNum calculation for Credit Note");
    return null;
  }
};

// utils/sapB1Integration.js
// Replace formatInvoiceForSAP function

exports.formatInvoiceForSAP = async (invoice) => {
  const today = new Date().toISOString().split('T')[0];

  const sapInvoice = {
    CardCode: invoice.CardCode,
    DocDate: invoice.DocDate ? new Date(invoice.DocDate).toISOString().split('T')[0] : today,
    DocDueDate: invoice.DocDueDate ? new Date(invoice.DocDueDate).toISOString().split('T')[0] : today,
    DocCurrency: invoice.DocCurrency || "EUR",
    Comments: invoice.Comments || "",
    U_Notes: invoice.U_Notes || "",
    DocumentLines: [],
  };

  // ✅ CRITICAL FIX: Include base document references
  if (invoice.DocumentLines && Array.isArray(invoice.DocumentLines)) {
    sapInvoice.DocumentLines = invoice.DocumentLines.map((line, index) => {
      const sapLine = {
        ItemCode: line.ItemCode,
        Quantity: Number(line.Quantity || 0),
        UnitPrice: Number(line.Price || line.UnitPrice || 0),
        ItemDescription: line.ItemDescription || "",
        LineNum: index,
      };

      // ✅ CRITICAL: Include base document references to close the delivery note
      // Check if this invoice is based on a delivery note
      if (invoice.BaseEntry && invoice.BaseEntry > 0 && invoice.BaseType === 15) {
        sapLine.BaseType = 15; // 15 = Delivery Note
        sapLine.BaseEntry = invoice.BaseEntry; // SAP's DocEntry for delivery note
        sapLine.BaseLine = line.BaseLine !== undefined ? line.BaseLine : index;

        console.log(`Invoice Line ${index}: Mapping to Delivery Note DocEntry ${invoice.BaseEntry}, Line ${sapLine.BaseLine}`);
      }

      return sapLine;
    });
  }

  // Add tracking fields
  if (invoice.OriginatingDeliveryNote) {
    sapInvoice.U_SourceDeliveryNote = invoice.OriginatingDeliveryNote.toString();
  }

  console.log("SAP Invoice formatted:", {
    CardCode: sapInvoice.CardCode,
    BaseDeliveryNoteDocEntry: invoice.BaseEntry,
    DocumentLines: sapInvoice.DocumentLines.length,
    HasBaseReferences: sapInvoice.DocumentLines.some(line => line.BaseType === 15),
    FirstLineBaseEntry: sapInvoice.DocumentLines[0]?.BaseEntry,
    FirstLineBaseType: sapInvoice.DocumentLines[0]?.BaseType
  });

  return sapInvoice;
};

// Format Return for SAP
exports.formatReturnForSAP = async (returnDoc) => {
  const today = new Date();

  const sapReturn = {
    CardCode: returnDoc.CardCode,
    DocDate: returnDoc.DocDate || today,
    DocDueDate: returnDoc.DocDueDate || today,
    Comments: returnDoc.Comments || "",
    DocumentLines: []
  };

  if (returnDoc.DocumentLines?.length > 0) {
    sapReturn.DocumentLines = returnDoc.DocumentLines.map((line, index) => ({
      ItemCode: line.ItemCode,
      Quantity: Number(line.Quantity || 0),
      UnitPrice: Number(line.Price || 0),
      ItemDescription: line.ItemDescription || "",
      LineNum: index,

      // ✅ CRITICAL: Base document references to link and close DN
      // BaseType 15 = Delivery Note (for returns)
      BaseType: line.BaseType || 15,
      BaseEntry: line.BaseEntry,
      BaseLine: line.BaseLine !== undefined ? line.BaseLine : index
    }));
  }

  console.log("SAP Return formatted with base references:", {
    CardCode: sapReturn.CardCode,
    DocumentLines: sapReturn.DocumentLines.length,
    HasBaseReferences: sapReturn.DocumentLines.some(l => l.BaseType === 15),
    BaseEntry: sapReturn.DocumentLines[0]?.BaseEntry
  });

  return sapReturn;
};

// Create incoming payment in SAP
exports.createIncomingPaymentInSAP = async (paymentData) => {
  try {
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync disabled. Simulating payment creation.");
      return {
        simulated: true,
        DocEntry: Math.floor(Math.random() * 10000),
        DocNum: Math.floor(Math.random() * 10000),
      };
    }

    const sessionId = await getSessionId();
    console.log("Creating incoming payment in SAP B1...");
    console.log("Payment data:", JSON.stringify(paymentData, null, 2));

    const response = await axios.post(
      `${SAP_CONFIG.serviceLayerUrl}/IncomingPayments`,
      paymentData,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("Payment created successfully in SAP B1");
    console.log("SAP Response:", {
      DocEntry: response.data.DocEntry,
      DocNum: response.data.DocNum,
    });

    return response.data;
  } catch (error) {
    console.error("Error creating payment in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);
    }

    if (error.response?.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.createIncomingPaymentInSAP(paymentData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};

// Format Credit Note for SAP - Based on actual SAP structure
exports.formatCreditNoteForSAP = async (creditNote) => {
  const today = new Date().toISOString().split('T')[0];

  // Build the credit note with only fields SAP accepts
  const sapCreditNote = {
    CardCode: creditNote.CardCode,
    DocDate: creditNote.DocDate
      ? new Date(creditNote.DocDate).toISOString().split('T')[0]
      : today,
    DocDueDate: creditNote.DocDueDate
      ? new Date(creditNote.DocDueDate).toISOString().split('T')[0]
      : today,
    DocCurrency: creditNote.DocCurrency || "EUR",
    DocumentLines: []
  };

  // Add Comments if provided
  if (creditNote.Comments) {
    sapCreditNote.Comments = creditNote.Comments;
  }

  // Add U_Notes if provided
  if (creditNote.U_Notes) {
    sapCreditNote.U_Notes = creditNote.U_Notes;
  }

  // Process document lines with base references
  if (creditNote.DocumentLines?.length > 0) {
    sapCreditNote.DocumentLines = creditNote.DocumentLines.map((line, index) => {
      const sapLine = {
        LineNum: index,
        ItemCode: line.ItemCode,
        ItemDescription: line.ItemDescription || "",
        Quantity: Number(line.Quantity || 0),
        // SAP uses "Price" field for credit notes
        Price: Number(line.Price || line.UnitPrice || 0),
      };

      // ✅ CRITICAL: Include base document references to link and close invoice
      // BaseType 13 = AR Invoice
      if (line.BaseType !== undefined && line.BaseType !== null) {
        sapLine.BaseType = Number(line.BaseType);

        if (line.BaseEntry !== undefined && line.BaseEntry !== null) {
          sapLine.BaseEntry = Number(line.BaseEntry);
          sapLine.BaseLine = Number(line.BaseLine !== undefined ? line.BaseLine : index);
        }
      }

      return sapLine;
    });
  }

  console.log("SAP Credit Note formatted with base references:", {
    CardCode: sapCreditNote.CardCode,
    DocumentLines: sapCreditNote.DocumentLines.length,
    HasBaseReferences: sapCreditNote.DocumentLines.some(l => l.BaseType === 13),
    BaseEntry: sapCreditNote.DocumentLines[0]?.BaseEntry
  });

  return sapCreditNote;
};

exports.updateSalesOrderInSAP = async (docNum, orderData) => {
  try {
    if (!ENABLE_SAP_SYNC) {
      console.log("SAP sync disabled. Simulating order update.");
      return {
        simulated: true,
        message: "SAP sync is disabled",
        DocNum: docNum,
      };
    }

    const sessionId = await getSessionId();

    console.log(`Finding SAP order with DocNum ${docNum}...`);

    // STEP 1: Get current order from SAP
    const searchResponse = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Orders?$filter=DocNum eq ${docNum}`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    if (!searchResponse.data.value || searchResponse.data.value.length === 0) {
      throw new Error(`Order with DocNum ${docNum} not found in SAP`);
    }

    const currentSAPOrder = searchResponse.data.value[0];
    const docEntry = currentSAPOrder.DocEntry;

    console.log(`Found SAP order: DocEntry=${docEntry}, DocNum=${docNum}`);

    // STEP 2: Build update data
    const updateData = {
      DocumentLines: []
    };

    if (orderData.Comments !== undefined) {
      updateData.Comments = orderData.Comments || "";
    }

    if (orderData.U_Notes !== undefined) {
      updateData.U_Notes = orderData.U_Notes || "";
    }

    // Build DocumentLines array with sequential LineNum starting from 0
    if (orderData.DocumentLines && orderData.DocumentLines.length > 0) {
      updateData.DocumentLines = orderData.DocumentLines.map((line, index) => ({
        LineNum: index,  // ✅ Use sequential numbering starting from 0
        ItemCode: line.ItemCode,
        ItemDescription: line.ItemDescription || "",
        Quantity: Number(line.Quantity || 0),
        UnitPrice: Number(line.UnitPrice || 0),
      }));

      console.log(`Built DocumentLines array with ${updateData.DocumentLines.length} lines`);
    }

    console.log(`Updating sales order DocEntry ${docEntry} in SAP B1 with PATCH...`);
    console.log("Update data being sent:", JSON.stringify(updateData, null, 2));

    // ✅ CRITICAL FIX: Add the B1S-ReplaceCollectionsOnPatch header
    const response = await axios.patch(
      `${SAP_CONFIG.serviceLayerUrl}/Orders(${docEntry})`,
      updateData,
      {
        headers: {
          "Content-Type": "application/json",
          "B1S-ReplaceCollectionsOnPatch": "true",  // ✅ THIS IS THE KEY FIX
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    console.log("✅ Sales order updated successfully in SAP B1");

    // STEP 3: Fetch and return updated order
    const updatedOrderResponse = await axios.get(
      `${SAP_CONFIG.serviceLayerUrl}/Orders?$filter=DocNum eq ${docNum}`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: `B1SESSION=${sessionId}`,
        },
      }
    );

    const updatedOrder = updatedOrderResponse.data.value?.[0] || null;

    if (updatedOrder) {
      console.log(`✅ Verified: Updated order now has ${updatedOrder.DocumentLines?.length || 0} lines`);
    }

    return updatedOrder;
  } catch (error) {
    console.error("Error updating sales order in SAP B1:", error.message);
    if (error.response) {
      console.error("SAP Error details:", error.response.data);

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

    if (error.response && error.response.status === 401) {
      console.log("Session expired, attempting to login again...");
      sessionId = null;
      await getSessionId();
      return exports.updateSalesOrderInSAP(docNum, orderData);
    }

    throw new Error(`SAP Error: ${error.message}`);
  }
};