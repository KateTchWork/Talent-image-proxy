// v1.2 - photo source selection fix (17.11.2026)
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

// Anything narrower than this came from the square avatar endpoint, not a real
// upload. Logged as a warning so it is visible in Railway without guessing.
const MIN_GOOD_WIDTH = 500;

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
//
// ══ FIX 17.11.2026 ═══════════════════════════════════════════════════════════
// The old version matched attachments with  Category.name === "Profile Picture"
// — exact and case sensitive. Anything else fell through to the /photo endpoint,
// which serves Recruit's SQUARE AVATAR: small, cropped, and then left at that
// size because convertToWebP uses withoutEnlargement.
//
// That produced the two bugs reported:
//   TALENT-12810  369x368   <- square, small  = came from /photo
//   TALENT-12955  326x360   <- square, small  = came from /photo
//   TALENT-13013  620x332   <- landscape      = came from the attachment  ✅
//   TALENT-14692  no image  <- no category match AND no avatar -> threw
//
// A photo uploaded as an attachment with no category, a lowercase category, or
// any other label was invisible to the old matcher even though it was sitting
// right there on the record.
//
// Now the attachment list is tried in four steps, newest first at each step,
// and /photo is only ever a last resort. The chosen source is logged.
// ═════════════════════════════════════════════════════════════════════════════

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|tiff?|heic|heif|avif)$/i;

// "Profile Picture", "profile picture", "Profile_Picture" all normalise the same
function normCat(value) {
  if (!value) return "";
  const raw = typeof value === "string" ? value : value.name || "";
  return raw.toLowerCase().replace(/[^a-z]/g, "");
}

function attachmentCategory(a) {
  return normCat(a.Category || a.category || a.Category_Name || "");
}

function newestFirst(a, b) {
  const ta = new Date(a.Modified_Time || a.Created_Time || 0).getTime();
  const tb = new Date(b.Modified_Time || b.Created_Time || 0).getTime();
  return tb - ta;
}

async function fetchCandidatePhoto(candidateId) {
  const token = await getZohoAccessToken();
  const authHeader = { Authorization: `Zoho-oauthtoken ${token}` };

  let attachments = [];
  try {
    const listUrl = `https://${ZOHO_RECRUIT_DOMAIN}/recruit/v2/Candidates/${candidateId}/Attachments`;
    const listRes = await fetch(listUrl, { headers: authHeader });
    if (listRes.ok) {
      const listData = await listRes.json();
      attachments = listData.data || [];
    } else if (listRes.status !== 204) {
      console.log(`Attachment list returned ${listRes.status}`);
    }
  } catch (err) {
    console.log(`Attachment list failed: ${err.message}`);
  }

  console.log(`Attachments on record: ${attachments.length}`);
  for (const a of attachments) {
    console.log(`   - "${a.File_Name}"  category="${a.Category?.name || a.Category || "(none)"}"`);
  }

  const images = attachments.filter((a) => IMAGE_EXT.test(a.File_Name || ""));

  // 1 — category is exactly "Profile Picture", however it is spelled or cased
  let pick = images.filter((a) => attachmentCategory(a) === "profilepicture").sort(newestFirst)[0];
  let how = "attachment (category: Profile Picture)";

  // 2 — any category that mentions profile / photo / picture
  if (!pick) {
    pick = images
      .filter((a) => {
        const c = attachmentCategory(a);
        return c.includes("profile") || c.includes("photo") || c.includes("picture");
      })
      .sort(newestFirst)[0];
    if (pick) how = `attachment (category: ${pick.Category?.name || pick.Category || "?"})`;
  }

  // 3 — a file NAMED like a profile picture, whatever its category
  if (!pick) {
    pick = images
      .filter((a) => /profile|photo|picture|avatar|headshot/i.test(a.File_Name || ""))
      .sort(newestFirst)[0];
    if (pick) how = "attachment (matched by file name)";
  }

  // 4 — just the newest image attachment on the record
  //     🔴 This is the branch that fixes the reported bug. A photo uploaded
  //     without any category is still the real photo.
  if (!pick) {
    pick = images.sort(newestFirst)[0];
    if (pick) how = "attachment (newest image, no category)";
  }

  if (pick) {
    try {
      const dlUrl = `https://${ZOHO_RECRUIT_DOMAIN}/recruit/v2/Candidates/${candidateId}/Attachments/${pick.id}`;
      const dlRes = await fetch(dlUrl, { headers: authHeader });
      if (dlRes.ok) {
        console.log(`Photo source: ${how} -> "${pick.File_Name}"`);
        return Buffer.from(await dlRes.arrayBuffer());
      }
      console.log(`Attachment download failed (${dlRes.status}), falling back to /photo`);
    } catch (err) {
      console.log(`Attachment download threw: ${err.message}`);
    }
  }

  // 5 — last resort: Recruit's square-cropped avatar
  console.log("⚠️  No usable image attachment — falling back to the /photo avatar (small, square)");
  const photoUrl = `https://${ZOHO_RECRUIT_DOMAIN}/recruit/v2/Candidates/${candidateId}/photo`;
  const res = await fetch(photoUrl, { headers: authHeader });

  if (res.status === 204 || res.status === 404) {
    throw new Error(
      `No photo found for candidate ${candidateId} — ` +
      `${attachments.length} attachment(s) on the record, ${images.length} of them images, ` +
      `and no profile avatar set`
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Recruit photo fetch failed (${res.status}): ${text}`);
  }

  console.log("Photo source: /photo avatar (square-cropped fallback)");
  return Buffer.from(await res.arrayBuffer());
}

// ── Convert to WebP with sharp ───────────────────────────────────────────────
// Width is capped at 620 to match the talent pool layout. Smaller originals are
// NOT upscaled — enlarging adds no detail — but they are logged, because a small
// result almost always means the wrong source was used upstream.
async function convertToWebP(imageBuffer) {
  const before = await sharp(imageBuffer).metadata();

  const out = await sharp(imageBuffer)
    .rotate()                                   // honour EXIF orientation
    .resize(620, undefined, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  const after = await sharp(out).metadata();
  console.log(
    `Image: ${before.width}x${before.height} ${before.format} -> ` +
    `${after.width}x${after.height} webp`
  );
  if ((after.width || 0) < MIN_GOOD_WIDTH) {
    console.log(
      `⚠️  Result is only ${after.width}px wide (under ${MIN_GOOD_WIDTH}). ` +
      `The source was probably the square avatar, not the uploaded file.`
    );
  }
  return out;
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

// ── Diagnostic endpoint ──────────────────────────────────────────────────────
// Read-only. Shows exactly what Recruit holds for a candidate and which source
// the uploader would choose, WITHOUT uploading anything.
//
//   GET /diagnose/616278000023983298   with header  x-api-key: <API_KEY>
//
// Use this whenever a photo looks wrong instead of re-running the sync.
app.get("/diagnose/:candidateId", async (req, res) => {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { candidateId } = req.params;
  try {
    const token = await getZohoAccessToken();
    const authHeader = { Authorization: `Zoho-oauthtoken ${token}` };

    let attachments = [];
    const listRes = await fetch(
      `https://${ZOHO_RECRUIT_DOMAIN}/recruit/v2/Candidates/${candidateId}/Attachments`,
      { headers: authHeader }
    );
    if (listRes.ok) attachments = (await listRes.json()).data || [];

    const images = attachments.filter((a) => IMAGE_EXT.test(a.File_Name || ""));

    const avatarRes = await fetch(
      `https://${ZOHO_RECRUIT_DOMAIN}/recruit/v2/Candidates/${candidateId}/photo`,
      { headers: authHeader }
    );
    const hasAvatar = avatarRes.ok;

    let chosen = null;
    let dimensions = null;
    try {
      const buf = await fetchCandidatePhoto(candidateId);
      const meta = await sharp(buf).metadata();
      dimensions = `${meta.width}x${meta.height} ${meta.format}`;
      chosen = "see logs for the branch used";
    } catch (e) {
      chosen = `WOULD FAIL: ${e.message}`;
    }

    res.json({
      candidateId,
      attachmentCount: attachments.length,
      imageAttachments: images.map((a) => ({
        fileName: a.File_Name,
        category: a.Category?.name || a.Category || null,
        size: a.Size,
        modified: a.Modified_Time,
      })),
      nonImageAttachments: attachments
        .filter((a) => !IMAGE_EXT.test(a.File_Name || ""))
        .map((a) => a.File_Name),
      hasProfileAvatar: hasAvatar,
      sourceDimensions: dimensions,
      note: chosen,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, candidateId });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.2", timestamp: new Date().toISOString() });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(parseInt(PORT), () => {
  console.log(`Talent image proxy v1.2 running on port ${PORT}`);
  console.log(`Image field: ${WEBFLOW_IMAGE_FIELD}`);
  console.log(`Collection: ${WEBFLOW_COLLECTION_ID}`);
});
