const express = require("express");
const sharp = require("sharp");
const crypto = require("crypto");
const FormData = require("form-data");
const https = require("https");
const http = require("http");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Config from environment ──────────────────────────────────────────────────
const {
  API_KEY,
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_ACCOUNTS_DOMAIN = "accounts.zoho.com", // accounts.zoho.eu for EU
  ZOHO_RECRUIT_DOMAIN = "recruit.zoho.com",    // recruit.zoho.eu for EU
  WEBFLOW_API_TOKEN,
  WEBFLOW_SITE_ID = "69aecf9a9d01438a1c822029",
  WEBFLOW_COLLECTION_ID = "69bc723158a93bcc7cbb40a3",
  WEBFLOW_IMAGE_FIELD = "profile-picture",
  PORT = "3000",
} = process.env;

// ── Zoho OAuth token cache ───────────────────────────────────────────────────
let accessToken = null;
let tokenExpiry = 0;

async function getZohoAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const res = await fetch(
    `https://${ZOHO_ACCOUNTS_DOMAIN}/oauth/v2/token?${params}`,
    { method: "POST" }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zoho token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Zoho token response missing access_token: ${JSON.stringify(data)}`);
  }

  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log("Zoho access token refreshed");
  return accessToken;
}

// ── Fetch candidate photo from Zoho Recruit ──────────────────────────────────
async function fetchCandidatePhoto(candidateId) {
  const token = await getZohoAccessToken();
  const url = `https://${ZOHO_RECRUIT_DOMAIN}/recruit/v2/Candidates/${candidateId}/photo`;

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });

  if (res.status === 204 || res.status === 404) {
    throw new Error(`No photo found for candidate ${candidateId}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Recruit photo fetch failed (${res.status}): ${text}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ── Convert to WebP with sharp ───────────────────────────────────────────────
async function convertToWebP(imageBuffer) {
  return sharp(imageBuffer)
    .resize(400, 400, { fit: "cover", position: "top" })
    .webp({ quality: 80 })
    .toBuffer();
}

// ── Helper: POST multipart form using native https (no axios needed) ─────────
function postMultipart(url, formData) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;

    const options = {
      method: "POST",
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: formData.getHeaders(),
      // S3 redirects on success — follow it
      maxRedirects: 5,
    };

    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        // S3 returns 201 or 204 on success, 303 if success_action_redirect
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ status: res.statusCode, body, headers: res.headers });
        } else {
          reject(new Error(`S3 upload failed (${res.statusCode}): ${body}`));
        }
      });
    });

    req.on("error", reject);
    formData.pipe(req);
  });
}

// ── Upload image to Webflow Assets API ───────────────────────────────────────
async function uploadToWebflowAssets(webpBuffer, fileName) {
  const fileHash = crypto.createHash("md5").update(webpBuffer).digest("hex");

  // Step 1: Request upload URL from Webflow
  const createRes = await fetch(
    `https://api.webflow.com/v2/sites/${WEBFLOW_SITE_ID}/assets`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ fileName, fileHash }),
    }
  );

  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Webflow asset create failed (${createRes.status}): ${text}`);
  }

  const assetData = await createRes.json();
  const { uploadUrl, uploadDetails } = assetData;
  const assetId = assetData.id;
  const assetUrl = assetData.hostedUrl || assetData.url;

  if (!uploadUrl || !uploadDetails) {
    throw new Error(`Webflow asset response missing uploadUrl/uploadDetails: ${JSON.stringify(assetData)}`);
  }

  console.log(`Asset created: ${assetId}, uploading to S3...`);

  // Step 2: Upload to S3 using presigned multipart form
  // Fields MUST come before the file — this is why Deluge can't do it
  const form = new FormData();
  for (const [key, value] of Object.entries(uploadDetails)) {
    form.append(key, String(value));
  }
  form.append("file", webpBuffer, {
    filename: fileName,
    contentType: "image/webp",
  });

  await postMultipart(uploadUrl, form);
  console.log(`S3 upload complete for ${fileName}`);

  return { assetId, assetUrl };
}

// ── Update CMS item with the uploaded image ──────────────────────────────────
async function updateCmsItemImage(webflowItemId, assetId) {
  const url = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/${webflowItemId}/live`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      fieldData: {
        [WEBFLOW_IMAGE_FIELD]: assetId,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CMS item update failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  console.log(`CMS item ${webflowItemId} updated with image ${assetId}`);
  return data;
}

// ── Main upload endpoint ─────────────────────────────────────────────────────
app.post("/upload", async (req, res) => {
  // Auth
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { candidateId, webflowItemId, candidateName } = req.body;

  if (!candidateId || !webflowItemId) {
    return res.status(400).json({ error: "candidateId and webflowItemId are required" });
  }

  const fileName = `talent-${candidateId}.webp`;

  try {
    console.log(`\n── Upload started: candidate ${candidateId} → item ${webflowItemId} ──`);

    // 1. Fetch photo from Zoho Recruit
    console.log("Fetching photo from Recruit...");
    const photoBuffer = await fetchCandidatePhoto(candidateId);
    console.log(`Photo fetched: ${(photoBuffer.length / 1024).toFixed(1)} KB`);

    // 2. Convert to WebP
    const webpBuffer = await convertToWebP(photoBuffer);
    console.log(`Converted to WebP: ${(webpBuffer.length / 1024).toFixed(1)} KB`);

    // 3. Upload to Webflow Assets
    const { assetId, assetUrl } = await uploadToWebflowAssets(webpBuffer, fileName);

    // 4. Update CMS item
    await updateCmsItemImage(webflowItemId, assetId);

    console.log(`── Upload complete: ${fileName} ──\n`);

    res.json({
      success: true,
      candidateId,
      webflowItemId,
      assetId,
      assetUrl,
      fileName,
    });
  } catch (err) {
    console.error(`Upload failed for candidate ${candidateId}:`, err.message);
    res.status(500).json({
      error: "Upload failed",
      details: err.message,
      candidateId,
      webflowItemId,
    });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(parseInt(PORT), () => {
  console.log(`Talent image proxy running on port ${PORT}`);
  console.log(`Image field: ${WEBFLOW_IMAGE_FIELD}`);
  console.log(`Collection: ${WEBFLOW_COLLECTION_ID}`);
});
