import express from "express";             
  import fetch from "node-fetch";                                      
  import cors from "cors";                                                       
  import nodemailer from "nodemailer";                  
                                                                       
  const app = express();                                                                                                
  app.use(cors());                                                  
  app.use(express.json());                                                                                              
                                                                                                                        
  const PORT = process.env.PORT || 3000;                                                                                
                                                                                                                        
  const AIRTABLE_BASE_ID = "appHB2bNYPAhfUcLv";                                                                         
  const AIRTABLE_TABLE = "tblWLlNxZvtkFSFXs";                                                                           
  const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;                               
                                                     
  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;                                                            
  const ACTIVATION_TO = process.env.ACTIVATION_TO || "pax@airportassociates.com";
                                                                                                                        
const mailer = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,                                                                                                          
    secure: true,
    auth: {                                                                                                             
      user: GMAIL_USER,                                     
      pass: GMAIL_APP_PASSWORD,
    },
    connectionTimeout: 20000,
    greetingTimeout: 20000,                                                                                             
    socketTimeout: 20000,
  });                                                                                                                   
                                                     
  app.get("/order/:recordId", async (req, res) => {                                                                     
    const { recordId } = req.params;                                                                                    
    console.log("HIT /order route - recordId:", recordId);
                                                                                                                        
    try {                                                                          
      const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`;
      console.log("Fetching Airtable URL:", url);
                                                                                                                        
      const response = await fetch(url, {          
        headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },                                                         
      });                                                                          
                                                                              
      console.log("Airtable status:", response.status);
                                                                                                                        
      if (!response.ok) {                                                                                               
        const errBody = await response.text();                                                                          
        console.log("Airtable error body:", errBody);                                                                   
        return res.status(400).json({ error: "Record not found", airtableStatus: response.status, airtableError: errBody
   });                                             
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
        totalBags,                                                                                                      
      });                                                                                                               
    } catch (err) {                                                 
      console.error(err);                                                                                               
      res.status(500).json({ error: "Server error" });                             
    }                                                                                                                   
  });                                                                                                                   
                                                                              
  app.post("/send-activation-request", async (req, res) => {                                                            
    const { tagNumbers } = req.body || {};                                         
                                                                                                                        
    if (!Array.isArray(tagNumbers) || tagNumbers.length === 0) {    
      return res.status(400).json({ error: "tagNumbers must be a non-empty array" });                                   
    }                                                                              
                                                   
    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {                                                                           
      console.error("Missing GMAIL_USER or GMAIL_APP_PASSWORD env var");
      return res.status(500).json({ error: "Email service not configured" });                                           
    }                                                                              
                                                                              
    const lines = tagNumbers.map((t) => `• ${t}`).join("\n");                                                           
    const text = `Please activate these inactive bag tags:\n\n${lines}\n`;
    const html = `                                                                                                      
      <p>Please activate these inactive bag tags:</p>                              
      <ul>${tagNumbers.map((t) => `<li><code>${t}</code></li>`).join("")}</ul>                                          
    `;                                                                                                                  
                                                                    
    try {                                                                                                               
      const info = await mailer.sendMail({                                         
        from: `"BagBee" <${GMAIL_USER}>`,                                                                               
        to: ACTIVATION_TO,                                                                                              
        subject: `Inactive bag tags — please activate (${tagNumbers.length})`,
        text,                                                                                                           
        html,                                                                      
      });                                                                                                               
      console.log(`[activation] sent ${tagNumbers.length} tags, messageId=${info.messageId}`);
      res.json({ ok: true, count: tagNumbers.length, messageId: info.messageId });
    } catch (err) {                                                                                                     
      console.error("[activation] send failed:", err);
      res.status(500).json({ error: "Failed to send email", detail: String(err.message || err) });                      
    }                                                                              
  });                                                                                                                   
                                                                                   
  app.listen(PORT, () => {                                                                                              
    console.log(`Server running on port ${PORT}`);                                                                      
  });     
