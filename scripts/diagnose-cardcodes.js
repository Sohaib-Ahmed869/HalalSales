// One-off diagnostic: find the real max legitimate customer CardCode in SAP B1.
// Fetches all cCustomer CardCodes matching ^C\d+$, sorts numerically, and prints
// the top of the range so we can spot reserved/special codes (e.g. C9996) that
// must NOT be treated as the sequential max.
const axios = require("axios");
require("dotenv").config();

const SAP = {
  url: process.env.SAP_SERVICE_LAYER_URL,
  companyDB: process.env.COMPANY_DB,
  username: process.env.USER_NAME,
  password: process.env.PASSWORD,
};

async function login() {
  const res = await axios.post(`${SAP.url}/Login`, {
    CompanyDB: SAP.companyDB,
    UserName: SAP.username,
    Password: SAP.password,
  });
  const cookie = res.headers["set-cookie"].find((c) => c.includes("B1SESSION="));
  return cookie.split(";")[0].replace("B1SESSION=", "");
}

async function main() {
  const sid = await login();
  console.log("Logged in. Fetching all customer CardCodes...");

  const all = [];
  let url = `${SAP.url}/BusinessPartners?$select=CardCode&$filter=CardType eq 'cCustomer' and startswith(CardCode,'C')&$orderby=CardCode asc`;

  while (url) {
    const res = await axios.get(url, {
      headers: { Cookie: `B1SESSION=${sid}` },
    });
    for (const bp of res.data.value) all.push(bp.CardCode);
    const next = res.data["odata.nextLink"] || res.data["@odata.nextLink"];
    url = next ? `${SAP.url}/${next}` : null;
  }

  console.log(`Total C-prefixed customers fetched: ${all.length}`);

  // Keep only pure numeric "C<digits>" codes
  const numeric = all
    .map((cc) => {
      const m = cc.match(/^C(\d+)$/);
      return m ? { cc, n: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.n - a.n);

  console.log("\n=== Top 40 numeric CardCodes (descending) ===");
  for (const e of numeric.slice(0, 40)) console.log(`${e.cc}\t(${e.n})`);

  // Count duplicates of the known-bad value
  const c71000 = all.filter((cc) => cc === "C71000").length;
  console.log(`\nCount of exact "C71000": ${c71000}`);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  if (e.response) console.error("SAP details:", JSON.stringify(e.response.data));
  process.exit(1);
});
