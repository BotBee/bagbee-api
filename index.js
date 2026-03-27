import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const AIRTABLE_BASE_ID = "appHB2bNYPAhfUcLv";
const AIRTABLE_TABLE = "Nýtt/óflokkað";
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;

app.get("/order/:recordId", async (req, res) => {
const { recordId } = req.params;

try {
const response = await fetch(
`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`,
{
headers: {
Authorization: `Bearer ${AIRTABLE_TOKEN}`
}
}
);

if (!response.ok) {
return res.status(400).json({ error: "Record not found" });
}

const data = await response.json();
const f = data.fields;

const totalBags =
(f["Töskufjöldi_no"] || 0) +
(f["Töskufjöldi_no_yfirstærð"] || 0);

res.json({
DynamicValue01: f["Delivery Address"] || "",
DynamicValue02: f["Nafn Viðskiptavinar"] || "",
DynamicValue03: f["Requested service"] || "",
DynamicValue04: f["Tölvupóstfang"] || "",
DynamicValue05: f["Símanúmer"] || "",
DynamicValue06: f["Delivery Address"] || "",
DynamicValue07: f["Delivery Time-window"] || "",
DynamicValue08: f["Nafn Viðskiptavinar"] || "",
DynamicValue09: f["Delivery Address"] || "",
DynamicValue10: f["Delivery Time-window"] || "",
DynamicValue11: f["Dagsetning pick-up"] || "",
DynamicValue12: f["Pöntunarnúmer (fx)"] || "",
totalBags
});

} catch (err) {
console.error(err);
res.status(500).json({ error: "Server error" });
}
});

app.listen(PORT, () => {
console.log(`Server running on port ${PORT}`);
});
