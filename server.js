// v1.1 - Content-Length fix for S3 uploads
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
// First tries attachments with category "Profile Picture" (uncropped).
// Falls back to the profile photo endpoint (square-cropped by Recruit).
async function fetchCandidatePhoto(candidateId) {
  const token = await getZohoAccessToken();
  const authHeader = { Authorization: `Zoho-oauthtoken ${token}` };

  // Try attachments first — look for "Profile Picture" category
  try {
    const listUrl = `https://${ZOHO_RECRUIT_DOMAIN}/recruit/v2/Candidates/${candidateId}/Attachments`;
    const listRes = await fetch(listUrl, { headers: authHeader });

    if (listRes.ok) {
      const listData = await listRes.json();
      const attachments = listData.data || [];

      // Find the most recent attachment with category "Profile Picture"
      // Recruit API returns Category as { name: "Profile Picture", id: "..." }
      const profilePic = attachments
        .filter((a) => {
          const cat = a.Category?.name || a.category || "";
          return cat === "Profile Picture";
        })
        .sort((a, b) => new Date(b.Modified_Time) - new Date(a.Modified_Time))[0];

      if (profilePic) {
        console.log(`Found attachment: "${profilePic.File_Name}" (${profilePic.Category?.name})`);
        const dlUrl = `https://${ZOHO_RECRUIT_DOMAIN}/recruit/v2/Candidates/${candidateId}/Attachments/${profilePic.id}`;
        const dlRes = await fetch(dlUrl, { headers: authHeader });

        if (dlRes.ok) {
          console.log("Downloaded attachment (uncropped)");
          return Buffer.from(await dlRes.arrayBuffer());
        }
      }
    }
  } catch (err) {
    console.log(`Attachment fetch failed, falling back to photo: ${err.message}`);
  }

  // Fallback: profile photo endpoint (square-cropped)
  console.log("No 'Profile Picture' attachment found, trying profile photo...");
  const photoUrl = `https://${ZOHO_RECRUIT_DOMAIN}/recruit/v2/Candidates/${candidateId}/photo`;
  const res = await fetch(photoUrl, { headers: authHeader });

  if (res.status === 204 || res.status === 404) {
    throw new Error(`No photo found for candidate ${candidateId}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Recruit photo fetch failed (${res.status}): ${text}`);
  }

  console.log("Downloaded profile photo (square-cropped fallback)");
  return Buffer.from(await res.arrayBuffer());
}

// ── Convert to WebP with sharp ───────────────────────────────────────────────
// Zoho Recruit crops photos to square. Resize to 620x296 landscape (matching
// existing talent pool images) would cut off too much. Instead, just convert
// to WebP without forced cropping — let Webflow CSS handle the display.
async function convertToWebP(imageBuffer) {
  return sharp(imageBuffer)
    .resize(620, undefined, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

// ── Helper: POST multipart form using native https (no axios needed) ─────────
function postMultipart(url, formData) {
  return new Promise((resolve, reject) => {
    // Get the full form buffer so we can set Content-Length (S3 requires it)
    formData.getLength((err, length) => {
      if (err) return reject(new Error(`Failed to get form length: ${err.message}`));

      const parsed = new URL(url);
      const transport = parsed.protocol === "https:" ? https : http;

      const headers = formData.getHeaders();
      headers["content-length"] = length;

      const options = {
        method: "POST",
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers,
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
async function updateCmsItemImage(webflowItemId, assetId, assetUrl, altText) {
  const url = `https://api.webflow.com/v2/collections/${WEBFLOW_COLLECTION_ID}/items/${webflowItemId}/live`;

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    // ── FIX 2026-11-10 ────────────────────────────────────────────────────
    // Webflow's single-item live PATCH requires the item `id` INSIDE the body
    // as well as in the URL. Without it the API answers
    //   400 {"message":"Bad Request: Request is malformed: Missing fields"}
    // and the details array is empty, which makes it look like a field-format
    // problem when it is not. Nothing in this file changed — Webflow tightened
    // the schema, so uploads that used to work started failing at the last
    // step with the asset already uploaded.
    //
    // `url` is genuinely required too: sending fileId alone is rejected with
    // "Expected value to have a 'url' field". Both are sent below.
    body: JSON.stringify({
      id: webflowItemId,
      fieldData: {
        [WEBFLOW_IMAGE_FIELD]: {
          fileId: assetId,
          url: assetUrl,
          alt: altText || null,
        },
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

  const { candidateId, webflowItemId, candidateName, candidateCode } = req.body;

  if (!candidateId || !webflowItemId) {
    return res.status(400).json({ error: "candidateId and webflowItemId are required" });
  }

  // Use candidateCode (e.g. "Talent-4667") for file name, fallback to candidateId
  const code = candidateCode || candidateId;
  const fileName = `${code}.webp`;

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

    // 4. Update CMS item with image + alt text
    const altText = code.toUpperCase();
    await updateCmsItemImage(webflowItemId, assetId, assetUrl, altText);

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
